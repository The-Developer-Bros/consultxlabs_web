"use server";

import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { findSessionRun } from "@/lib/appointments/slots";
import { ConsentRequiredError } from "@/lib/compliance/dpdp";
import { resolveMaxCallDurationSeconds } from "@/lib/meetings/duration-cap";
import { resolvePlanOwnerIds } from "@/lib/booking/plan-owners";
import { getMaintenanceState } from "@/lib/maintenance";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
/**
 * Minimal slot interface for database meeting session operations.
 * Matches the MeetingSlot interface from lib/meeting.ts.
 */
interface MeetingSlot {
  id: string;
  startsAt: Date | string;
  endsAt: Date | string | null;
  isTentative?: boolean;
  appointmentId?: string | null;
}
import { MeetingSession } from "@prisma/client";
import type { AppointmentsType } from "@prisma/client";
import { upsertUsersToStream } from "@/actions/stream/chat/user.action";
import { streamLogger } from "@/lib/stream-logger";
import {
  getStreamVideoClient,
  isStreamConfigured,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { STREAM_CALL_TYPE } from "@/lib/stream/call-cid";

// Input validation schemas
const slotIdSchema = z.string().min(1, "Slot ID is required");
const streamCallIdSchema = z.string().min(1, "Stream Call ID is required");

/**
 * Only what `findSessionRun` and `MeetingSlot` need — see #1061.
 * `completionStatus` is selected because the grouping helper, not this file,
 * decides which rows are dead.
 */
const anchorSlotSelect = {
  id: true,
  startsAt: true,
  endsAt: true,
  isTentative: true,
  appointmentId: true,
  completionStatus: true,
  // E2E-audit P1 fix — lets anchor selection prefer the consultant-owned row
  // of a run (group events carry parallel per-buyer rows spanning only the
  // first atom, and whichever row sorted first used to decide the room id).
  consultantProfileId: true,
} as const;

export type AnchorSlot = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  isTentative: boolean;
  appointmentId: string;
  completionStatus: string;
  consultantProfileId: string | null;
};

/** Consultant identity, deep enough for `resolvePlanOwnerIds` to read it. */
const ownerProfileSelect = {
  select: { id: true, userId: true, user: { select: { name: true } } },
} as const;
const collaboratorsSelect = {
  where: { status: "ACCEPTED" as const },
  select: { consultantProfile: ownerProfileSelect },
} as const;

/**
 * The plan graph both resolvers authorize against and read identity from.
 * `slotsOfAppointment` is filtered to the caller: a non-empty array is the
 * consultee-side proof of participation, and `take: 1` keeps it an existence
 * check rather than a fetch of every attendee.
 */
const appointmentAccessSelect = (userId: string) =>
  ({
    appointmentType: true,
    // #1270 — read here rather than in a second query. The org tag used to be
    // supplied by the browser (an argument the caller chose), and the audit
    // column on MeetingSession was then read back separately; one column on a
    // query that already runs answers both.
    organizationId: true,
    slotsOfAppointment: {
      where: { user: { some: { id: userId } } },
      select: { id: true },
      take: 1,
    },
    consultation: {
      select: {
        consultationPlan: {
          select: { title: true, consultantProfile: ownerProfileSelect },
        },
      },
    },
    subscription: {
      select: {
        subscriptionPlan: {
          select: { title: true, consultantProfile: ownerProfileSelect },
        },
      },
    },
    webinar: {
      select: {
        webinarPlan: {
          select: {
            title: true,
            consultantProfile: ownerProfileSelect,
            collaborators: collaboratorsSelect,
          },
        },
      },
    },
    class: {
      select: {
        classPlan: {
          select: {
            title: true,
            consultantProfile: ownerProfileSelect,
            collaborators: collaboratorsSelect,
          },
        },
      },
    },
    trialSession: {
      select: {
        subscriptionPlan: {
          select: { title: true, consultantProfile: ownerProfileSelect },
        },
      },
    },
  }) satisfies Prisma.AppointmentSelect;

/**
 * Loads a slot together with its appointment, but only for a caller entitled
 * to it.
 *
 * Both resolvers below are exported from a `"use server"` module, which makes
 * them callable directly by any authenticated client with any argument they
 * like. Validating the shape of a slot id is not authorization: without this
 * gate, one guessed id discloses an unrelated booking's offering title and the
 * user ids on both sides of it.
 *
 * Entitlement is the union of the two sides. The consultant side is
 * `resolvePlanOwnerIds` — plan owner plus ACCEPTED collaborators, the same
 * predicate the reschedule and timings routes authorize with. The consultee
 * side is participation: being connected to one of the appointment's slot
 * rows, which every booking path does for both parties.
 *
 * Returns null rather than throwing so callers can degrade to a less
 * informative join instead of refusing entry.
 */
async function readSlotForCaller(slotId: string) {
  const session = await getSession(true);
  const userId = session?.user?.id;
  if (!userId || session.user.banned === true) return null;

  const row = await prisma.slotOfAppointment.findUnique({
    where: { id: slotId },
    select: {
      ...anchorSlotSelect,
      appointment: { select: appointmentAccessSelect(userId) },
    },
  });
  if (!row?.appointment) return null;

  const { appointment, ...slot } = row;
  const consultantProfileId = session.user.consultantProfileId;
  const entitled =
    appointment.slotsOfAppointment.length > 0 ||
    (!!consultantProfileId &&
      resolvePlanOwnerIds(appointment).includes(consultantProfileId)) ||
    isPrivileged(session.user.role);

  if (!entitled) {
    streamLogger.warn("Rejected meeting resolution for unrelated caller", {
      slotId,
      userId,
    });
    return null;
  }

  // Split so a caller can hand `slot` straight back to the client without the
  // ownership graph riding along in the server action's serialized result.
  // `userId` rides along because the session read is not deduped inside a
  // server action (see the note on getSessionCached in lib/auth-server), and
  // the mint needs a fallback author when no host resolves.
  return { slot, appointment, userId };
}

/**
 * A refusal we meant to issue — maintenance, an unentitled caller, or input
 * that is genuinely not a slot — as opposed to something breaking underneath
 * us. Kept out of Sentry and passed through with its message intact.
 *
 * Not exported: a "use server" module may only export async functions, and
 * nothing outside this file needs to narrow on it.
 */
class MeetingSessionRefusal extends Error {}

/**
 * `readSlotForCaller` as a hard gate rather than a soft one.
 *
 * The resolvers degrade to null on refusal because a less informative join is
 * better than none. Anything that WRITES, or that hands back a `streamCallId`,
 * must refuse outright instead — returning null there would let the caller
 * fall through to the mint branch and create a Stream call for a booking they
 * have nothing to do with.
 */
async function requireEntitledCaller(slotId: string): Promise<void> {
  if (!(await readSlotForCaller(slotId))) {
    throw new MeetingSessionRefusal(
      "You are not a participant in this session.",
    );
  }
}

const slotSchema = z.object({
  id: z.string().min(1),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().nullable().optional(),
  isTentative: z.boolean().optional(),
  appointmentId: z.string().nullable().optional(),
});

/**
 * Resolves the slot row a session's video room is keyed to (#1061).
 *
 * A booking longer than 30 minutes is stored as N consecutive rows, and the
 * three dashboard surfaces each hand us a different one — so the room has to
 * be anchored to the run's FIRST row or the two sides of the same call end up
 * in different Stream rooms. This must be resolved server-side: the planner
 * builds a `MeetingAppointment` carrying a single slot, so the client cannot
 * see the run it belongs to.
 *
 * What counts as one session is defined in exactly one place —
 * `groupSlotsIntoRuns` in lib/appointments/slots — and this reads it rather
 * than restating it. The clients compute their join window from the same
 * helper over the same rows, and two drifting definitions of "one session"
 * would put the server's room key and the client's window back out of step,
 * which is the defect this whole change removes.
 *
 * Gated by `readSlotForCaller`: it takes a raw slot id, and even though it
 * discloses less than the profile below, it still confirms that a slot exists
 * and which appointment owns it.
 *
 * @param slotId Any row of the session.
 * @returns The anchor row, or null when it cannot be resolved (caller falls
 *   back to the row it was given, preserving today's behaviour).
 */
export async function resolveSessionAnchorSlot(
  slotId: string,
): Promise<AnchorSlot | null> {
  const validatedSlotId = slotIdSchema.parse(slotId);

  try {
    const slot = (await readSlotForCaller(validatedSlotId))?.slot;
    // An appointment-less row has no siblings to walk, and querying for them
    // would ask Prisma for `appointmentId IS NULL` — every orphan in the
    // table. The column is required today, so this is a guard, not a fix.
    if (!slot?.appointmentId) return slot ?? null;

    // Served by @@index([appointmentId]). Only the soft-delete tombstone is
    // filtered here — it is a storage concern the grouping helper has no
    // business knowing about; every session rule is left to the helper.
    // The `id` tiebreak makes equal-start rows order deterministically in
    // every query that fetches them, so two surfaces can't disagree about
    // which row leads a run merely by fetching in a different order.
    const siblings = await prisma.slotOfAppointment.findMany({
      where: { appointmentId: slot.appointmentId, deletedAt: null },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      select: anchorSlotSelect,
    });

    // No run means the row we were handed is itself cancelled, rescheduled or
    // soft-deleted, so it anchors only itself — which keeps a stale Join click
    // on the room it already has.
    const run = findSessionRun(siblings, slot.id);
    if (!run) return slot;

    // Prefer a consultant-owned anchor when one exists in this run. Webinar
    // and class buyers get their own parallel slot row spanning only the
    // first atom; if such a row sorts ahead of the consultant's contiguous
    // N-atom run, the buyer's Join minted a SECOND room on a different key
    // and split the audience (#1061 class). The consultant's rows are the
    // canonical spine every attendee is grouped around.
    const consultantAnchor = run.slots.find((s) => s.consultantProfileId);
    return consultantAnchor ?? run.anchor ?? slot;
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Failed to resolve session anchor slot", error, {
      slotId: validatedSlotId,
    });
    return null;
  }
}

/**
 * The one role every member of an appointment call is named with (#1270).
 *
 * It used to be `host` for the consultant and `user` for everyone else, which
 * was worse than useless: the live `default` call type has exactly six role
 * keys — guest, user, call_member, admin, global_read_only, global_admin — and
 * no `host` among them, so a consultant stamped `host` held no grants at all.
 * The moment scripts/stream/ensure-call-type-grants.ts strips `join-call` from
 * `user`, that pair locks BOTH sides out: one role does not exist and the other
 * no longer admits anyone.
 *
 * `call_member` is what POST /api/meetings/[meetingId]/join assigns, and it is
 * the role the grants script keeps `join-call` on. Naming it here is what makes
 * the common path cheap rather than what makes it possible.
 *
 * Nothing is lost by dropping the distinction. Host-ness in the UI is derived
 * from `custom.consultantUserId` via useSessionInfo(), never from the Stream
 * role, and `hostUserIds`/`guestUserIds` below still carry the two sides.
 */
const CALL_MEMBER_ROLE = "call_member";

export type SessionCallMember = { user_id: string; role: string };

export type SessionCallProfile = {
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
  offeringTitle: string | null;
  members: SessionCallMember[];
  hostUserIds: string[];
  guestUserIds: string[];
  /**
   * Display names for the two sides. Carried so the meeting screens can name
   * the person the viewer is actually sitting across from — the call's `title`
   * only ever held the requester, which reads as the consultee's own name back
   * at them.
   */
  hostName: string | null;
  guestName: string | null;
};

/**
 * Everything about a session a Stream call should describe itself with — the
 * run's real bounds, the offering it belongs to, and who is hosting it (#1070).
 *
 * Resolved server-side and once, at call-creation time, rather than left to
 * each dashboard surface to infer. Only read on the branch that actually mints
 * a call, so a normal join into an existing room pays nothing for it.
 *
 * Gated by `readSlotForCaller`, and that gate is the reason this function can
 * be as generous as it is: it hands back the offering title and the user ids
 * and names on both sides, which is session membership. Without the check, one
 * guessed slot id would disclose all of it for a stranger's booking.
 *
 * @returns null when it cannot be resolved OR the caller is not entitled to
 *   it; the caller then creates the call exactly as it did before, since every
 *   field this feeds is additive.
 */
export async function resolveSessionCallProfile(
  anchorSlotId: string,
): Promise<SessionCallProfile | null> {
  const validatedSlotId = slotIdSchema.parse(anchorSlotId);

  try {
    const authorized = await readSlotForCaller(validatedSlotId);
    if (!authorized) return null;
    const { slot: anchor, appointment } = authorized;
    // Same guard as the anchor resolver: without it Prisma would ask for
    // `appointmentId IS NULL` and pull every appointment-less row in the table.
    if (!anchor.appointmentId) return null;

    // A webinar or class discards its attendees a few lines below (they are
    // never named as members), and can hold hundreds of them — so they are not
    // fetched at all. `appointmentType` is already in hand from the gate.
    const isGroupEvent =
      appointment.appointmentType === "WEBINAR" ||
      appointment.appointmentType === "CLASS";
    const siblings = await prisma.slotOfAppointment.findMany({
      where: { appointmentId: anchor.appointmentId, deletedAt: null },
      orderBy: { startsAt: "asc" },
      select: {
        ...anchorSlotSelect,
        // `take: 0` rather than a narrower select, so the row type stays the
        // same shape on both branches.
        user: {
          select: { id: true, name: true },
          ...(isGroupEvent ? { take: 0 } : {}),
        },
      },
    });
    const run = findSessionRun(siblings, validatedSlotId);
    if (!run) return null;

    // Ownership stays defined by resolvePlanOwnerIds — the same predicate the
    // reschedule and timings routes authorize with. It answers in consultant
    // PROFILE ids, so pair each profile with its user before filtering.
    const profileToUser = new Map<string, string>();
    const userToName = new Map<string, string>();
    const remember = (
      profile?: {
        id: string;
        userId: string;
        user?: { name?: string | null } | null;
      } | null,
    ) => {
      if (!profile) return;
      profileToUser.set(profile.id, profile.userId);
      if (profile.user?.name) userToName.set(profile.userId, profile.user.name);
    };
    remember(appointment.consultation?.consultationPlan?.consultantProfile);
    remember(appointment.subscription?.subscriptionPlan?.consultantProfile);
    remember(appointment.webinar?.webinarPlan?.consultantProfile);
    remember(appointment.class?.classPlan?.consultantProfile);
    remember(appointment.trialSession?.subscriptionPlan?.consultantProfile);
    for (const collaborator of [
      ...(appointment.webinar?.webinarPlan?.collaborators ?? []),
      ...(appointment.class?.classPlan?.collaborators ?? []),
    ]) {
      remember(collaborator.consultantProfile);
    }

    const hostUserIds = [
      ...new Set(
        resolvePlanOwnerIds(appointment)
          .map((profileId) => profileToUser.get(profileId))
          .filter((userId): userId is string => Boolean(userId)),
      ),
    ];

    // Attendees are named only for the 1:1 types, where both sides are
    // connected to the slot. A webinar or class can hold hundreds of them and
    // Stream would reject the oversized request, which would turn a working
    // join into a failure — so group events name their hosts and nobody else.
    const hosts = new Set(hostUserIds);
    for (const attendee of run.slots.flatMap((slot) => slot.user)) {
      if (attendee.name) userToName.set(attendee.id, attendee.name);
    }
    const guestUserIds = isGroupEvent
      ? []
      : [
          ...new Set(run.slots.flatMap((slot) => slot.user.map((u) => u.id))),
        ].filter((userId) => !hosts.has(userId));

    const offeringTitle =
      appointment.consultation?.consultationPlan?.title ??
      appointment.subscription?.subscriptionPlan?.title ??
      appointment.webinar?.webinarPlan?.title ??
      appointment.class?.classPlan?.title ??
      appointment.trialSession?.subscriptionPlan?.title ??
      null;

    // #1270 — Stream rejects the whole GetOrCreateCall when `members` names a
    // user it does not hold ("Please create users before referencing them in a
    // call"), and it never auto-creates one from a reference. 29% of
    // consultants were missing because only the chat paths upsert. Every chat
    // channel create already does this; the video mint never did.
    //
    // #1269 — a withdrawn consent must not take the appointments page down.
    //
    // `upsertUserToStream` throws `ConsentRequiredError` when
    // STREAM_DATA_PROCESSING is absent, which is correct: failing closed is the
    // whole point of the gate. But this function is called from the RENDER path,
    // so the throw propagated out of a React Server Component and the consultee
    // lost access to their own bookings. Withdrawal is a right DPDP explicitly
    // grants; the first person to exercise it should not be locked out of the
    // list of things they have paid for.
    //
    // Returning `null` degrades to the outcome this function already has three
    // other ways of reaching, and every caller handles it — the page renders
    // without call metadata. The refusal still bites where it should: the JOIN
    // path (`provisionAppointmentMeeting`, and `POST /api/meetings/[id]/join`)
    // upserts separately and is left to throw, because "you cannot join a video
    // call without consenting to the video processor" is the correct answer to
    // a join and the wrong answer to a page load.
    try {
      await upsertUsersToStream([...hostUserIds, ...guestUserIds]);
    } catch (err) {
      if (err instanceof ConsentRequiredError) {
        streamLogger.info(
          "No call profile — Stream consent absent for a participant",
          { anchorSlotId: validatedSlotId, purposeCode: err.purposeCode },
        );
        return null;
      }
      throw err;
    }

    return {
      startsAt: run.startsAt,
      endsAt: run.endsAt,
      durationMinutes: Math.round(
        (run.endsAt.getTime() - run.startsAt.getTime()) / 60_000,
      ),
      offeringTitle,
      members: [...hostUserIds, ...guestUserIds].map((user_id) => ({
        user_id,
        role: CALL_MEMBER_ROLE,
      })),
      hostUserIds,
      guestUserIds,
      // Only the first of each side is named. A 1:1 session has exactly one
      // per side, and a group event names no guests at all, so a list would
      // carry nothing the screens could use.
      hostName: userToName.get(hostUserIds[0] ?? "") ?? null,
      guestName: userToName.get(guestUserIds[0] ?? "") ?? null,
    };
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Failed to resolve session call profile", error, {
      slotId: validatedSlotId,
    });
    return null;
  }
}

/**
 * Finds an existing meeting session in the database by slot ID.
 *
 * Deliberately NOT entitlement-gated, unlike the writer below.
 *
 * The only thing it returns that an attacker would want is `streamCallId`, and
 * that is `slot-<anchorSlotId>` — derivable from the slot id the caller had to
 * supply to ask the question. A gate here would therefore buy no
 * confidentiality, while putting a hard refusal on the read that EVERY join
 * makes: `readSlotForCaller` returns null for a transient database failure as
 * well as for a stranger, so a blip would refuse a legitimate participant
 * instead of degrading. Entry to the meeting page is gated by
 * /api/meetings/[id]/validate-access.
 *
 * @param slotId The ID of the appointment slot.
 * @returns The MeetingSession object if found, otherwise null.
 */
export async function findDbMeetingSessionBySlot(
  slotId: string,
): Promise<MeetingSession | null> {
  // Validate input
  const validatedSlotId = slotIdSchema.parse(slotId);

  try {
    const meetingSession = await prisma.meetingSession.findUnique({
      where: { slotOfAppointmentId: validatedSlotId },
    });

    if (meetingSession) {
      streamLogger.debug("Found existing meeting session", {
        sessionId: meetingSession.id,
        slotId: validatedSlotId,
      });
    } else {
      streamLogger.debug("No existing meeting session found", {
        slotId: validatedSlotId,
      });
    }

    return meetingSession;
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Error finding meeting session", error, {
      slotId: validatedSlotId,
    });
    return null;
  }
}

/**
 * Every precondition that can REFUSE a join, in one place so it can run
 * before anything is minted (#1077).
 *
 * Both are decisions, not work: the maintenance read sits behind
 * `withCircuitBreaker` and falls back to OFF rather than throwing, and the
 * shape check is pure. So evaluating them twice — once hoisted, once as the
 * gate below — costs a cache read and cannot change the answer.
 *
 * The organization lookup deliberately stays out. It cannot refuse a join on
 * policy, only fail transiently, and hoisting it would either run the same
 * query twice or send its result back through the client to be replayed.
 *
 * @returns The refusal message, or null when the join may proceed.
 */
async function refuseMeetingCreation(
  slot: MeetingSlot,
): Promise<string | null> {
  const maintenanceState = await getMaintenanceState();
  if (maintenanceState.phase !== "OFF") {
    return "New calls cannot be created during maintenance.";
  }

  // safeParse, so a rejection names the field instead of arriving as a bare
  // ZodError the caller has to guess at.
  const parsedSlot = slotSchema.safeParse({
    id: slot.id,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    isTentative: slot.isTentative,
    appointmentId: slot.appointmentId,
  });
  if (!parsedSlot.success) {
    return `Invalid slot for meeting session: ${parsedSlot.error.issues
      .map((issue) => `${issue.path.join(".") || "value"} ${issue.message}`)
      .join("; ")}`;
  }

  // E2E-audit P1 fix — the writer is reachable by any entitled caller with
  // arguments of its choosing, and entitlement (slot participation) holds
  // even for TENTATIVE rows: an APPROVED_PENDING_PAYMENT consultation or a
  // not-yet-captured webinar seat could provision a real room and walk into
  // it pre-payment, because every Join-button guard lived in the UI. Read
  // the row's actual persisted state instead of trusting the payload. The
  // booking's status lives on its PARENT row (consultation/subscription/
  // webinar/class/trial), not on Appointment itself.
  const dbSlot = await prisma.slotOfAppointment.findUnique({
    where: { id: parsedSlot.data.id },
    select: {
      isTentative: true,
      completionStatus: true,
      deletedAt: true,
      appointment: {
        select: {
          deletedAt: true,
          consultation: { select: { status: true } },
          subscription: { select: { status: true } },
          webinar: { select: { status: true } },
          class: { select: { status: true } },
          trialSession: { select: { status: true } },
        },
      },
    },
  });
  if (!dbSlot) {
    return "Session slot not found.";
  }
  if (dbSlot.isTentative) {
    return "This session is not confirmed yet.";
  }
  if (
    dbSlot.deletedAt ||
    dbSlot.completionStatus === "CANCELLED" ||
    dbSlot.completionStatus === "RESCHEDULED"
  ) {
    return "This session was cancelled or moved.";
  }
  const appt = dbSlot.appointment;
  // The relation is required in the schema, so a null here is corrupt data
  // rather than any real booking. There is no booking state to judge, and
  // entitlement cannot be established either — `requireEntitledCaller` runs
  // immediately after this and owns that refusal, so the caller still gets
  // one message for "nothing links you to this session" instead of a
  // TypeError surfacing as an opaque 500.
  if (!appt) return null;
  const bookingStatus =
    appt.consultation?.status ??
    appt.subscription?.status ??
    appt.webinar?.status ??
    appt.class?.status ??
    (appt.trialSession?.status === "CANCELLED" ||
    appt.trialSession?.status === "REJECTED"
      ? "CANCELLED"
      : null);
  if (
    appt.deletedAt ||
    (bookingStatus && TERMINAL_APPOINTMENT_STATUSES.has(bookingStatus))
  ) {
    return "This booking is no longer active.";
  }

  return null;
}

/**
 * Booking states from which no new call may ever be provisioned. A cancelled,
 * rejected or expired request must not resurrect as a video room, however the
 * slot rows were left behind.
 */
const TERMINAL_APPOINTMENT_STATUSES = new Set([
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
]);

/**
 * The refusal check, hoisted for `getOrCreateAppointmentMeeting` to run BEFORE
 * `call.getOrCreate` (#1077).
 *
 * Blocked after the mint, Stream keeps a call no `MeetingSession` row points
 * at, stamped with whatever bounds and members were computed at the blocked
 * moment — and nothing ever corrects them, because only the mint branch writes
 * that data.
 *
 * Fails OPEN. An unexpected throw here must not turn a working join into a
 * refusal: the authoritative gate is still `createDbMeetingSession`, which runs
 * a moment later on the same request.
 *
 * Deliberately NOT entitlement-gated, and the only export here that is not.
 * It reads no row: it reports the global maintenance phase, which every user
 * already sees, and whether an object the caller itself supplied is shaped
 * like a slot. There is nothing here to disclose.
 */
export async function getMeetingCreationRefusal(
  slot: MeetingSlot,
): Promise<string | null> {
  try {
    const refusal = await refuseMeetingCreation(slot);
    if (refusal) {
      streamLogger.warn("Refused a meeting before creating the call", {
        slotId: slot.id,
        reason: refusal,
      });
    }
    return refusal;
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Failed to pre-check meeting creation", error, {
      slotId: slot.id,
    });
    // #1270 — a refusal we could not evaluate is a refusal, not a pass.
    // Answering `null` here meant "nothing refuses this", so a slot read that
    // threw let the mint proceed; `createDbMeetingSession` then re-ran the same
    // check, and a second read that succeeded threw — leaving the orphaned,
    // billable Stream room the caller's ordering exists to prevent. The
    // caller's own message is deliberately vague: a transient read failure is
    // not the user's business, and it must not leak booking state either.
    return "We could not verify this session just now. Please try again.";
  }
}

/**
 * The org an appointment belongs to, for the audit column on MeetingSession.
 *
 * Deliberately still fatal on failure rather than degrading to null: the column
 * is written once and never updated, so a null recorded because a read blipped
 * would hide this call from its own org's audit queries permanently. A failed
 * join is retryable; that is not.
 *
 * Extracted from `createDbMeetingSession` only to keep that function under the
 * cognitive-complexity limit the pipeline enforces.
 */
async function readAppointmentOrganizationId(
  appointmentId: string | null | undefined,
): Promise<string | null> {
  if (!appointmentId) return null;
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { organizationId: true },
  });
  return appointment?.organizationId ?? null;
}

/**
 * Creates a new meeting session in the database.
 * @param slot The appointment slot for which to create the session.
 * @param streamCallId The Stream Call ID to associate with the new session.
 * @returns The newly created MeetingSession object.
 */
export async function createDbMeetingSession(
  slot: MeetingSlot,
  streamCallId: string,
): Promise<MeetingSession> {
  // The maintenance read, the input validation and the organization lookup
  // all used to sit OUTSIDE this guard. Anything they threw left the server
  // action raw: Next replaces an uncaught server-action error with an opaque
  // digest, so the join toast could only say "An error occurred in the Server
  // Components render" — no Sentry event, no slot id, and no chance for the
  // P2002 fallback below to recover a concurrent join. The failure was
  // reported and then not reproducible, which is exactly what an unguarded
  // transient DB call on the mint-only branch looks like.
  try {
    // Also run ahead of the Stream call by the caller (#1077); kept here
    // because this module is `"use server"` and any client can reach this
    // function directly with arguments of its choosing.
    const refusal = await refuseMeetingCreation(slot);
    if (refusal) throw new MeetingSessionRefusal(refusal);

    // The row written here decides which Stream call BOTH sides are sent to,
    // it is unique per slot and never updated, and every later join reuses its
    // `streamCallId`. Ungated, one call to this exported action would route a
    // stranger's meeting into a room of the caller's choosing. The resolvers
    // were gated two rounds ago and this writer was missed.
    await requireEntitledCaller(slot.id);

    const validatedStreamCallId = streamCallIdSchema.parse(streamCallId);

    streamLogger.debug("Creating meeting session", {
      slotId: slot.id,
      streamCallId: validatedStreamCallId,
    });

    const organizationId = await readAppointmentOrganizationId(
      slot.appointmentId,
    );

    const meetingSession = await prisma.meetingSession.create({
      data: {
        streamCallId: validatedStreamCallId,
        platform: "STREAM",
        slotOfAppointment: {
          connect: { id: slot.id },
        },
        ...(organizationId
          ? { organization: { connect: { id: organizationId } } }
          : {}),
      },
    });

    streamLogger.info("Meeting session created", {
      sessionId: meetingSession.id,
      slotId: slot.id,
      streamCallId: validatedStreamCallId,
    });

    return meetingSession;
  } catch (error) {
    // Race condition: another caller already created a session for this slot.
    // Return the existing session instead of throwing.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      streamLogger.info(
        "Meeting session already exists (concurrent creation), returning existing",
        { slotId: slot.id },
      );
      const existing = await prisma.meetingSession.findUnique({
        where: { slotOfAppointmentId: slot.id },
      });
      if (existing) return existing;
    }

    if (error instanceof MeetingSessionRefusal) {
      streamLogger.warn("Refused to create meeting session", {
        slotId: slot.id,
        streamCallId,
        reason: error.message,
      });
      throw new Error(error.message);
    }

    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Failed to create meeting session", error, {
      slotId: slot.id,
      streamCallId,
    });

    if (error instanceof Error) {
      throw new Error(`Failed to create meeting session: ${error.message}`);
    }
    throw new Error(
      "An unknown error occurred while creating the meeting session.",
    );
  }
}

/*
 * `getOrCreateMeetingSession` and `updateMeetingSessionCallId` were removed
 * here. Neither had a single caller, and both were exported from a
 * `"use server"` module: the first wrapped the ungated find+create pair, and
 * the second rewrote an existing session's `streamCallId` outright, which is a
 * more direct hijack than the one that prompted this audit. Dead code that
 * only exposes an attack surface is deleted rather than gated.
 */

/**
 * What a session's Stream call is described with, once, by the server (#1270).
 *
 * Every field used to be assembled in the browser and handed to Stream by the
 * browser, so the person who clicked Join first decided what the room said
 * about itself — including `consultantUserId`, which is the value the meeting
 * UI derives host-ness from. These are now read from the same rows the
 * entitlement gate reads.
 */
interface CallDescription {
  title: string;
  description: string;
}

function describeCall(
  appointmentType: AppointmentsType,
  appointmentId: string | null | undefined,
  profile: SessionCallProfile | null,
): CallDescription {
  const offeringTitle = profile?.offeringTitle ?? null;
  // The consultee, by name. Group events name no guests at all, so this is
  // null for a webinar or a class and the offering branches below take over —
  // which is the same precedence the browser-side version had.
  const guestName = profile?.guestName ?? null;

  if (guestName) {
    return {
      title: `${appointmentType} with ${guestName}`,
      description: `${appointmentType} Meeting`,
    };
  }
  if (appointmentType === "WEBINAR" && offeringTitle) {
    return {
      title: `Webinar: ${offeringTitle}`,
      description: `Webinar Session for ${offeringTitle}`,
    };
  }
  if (appointmentType === "CLASS" && offeringTitle) {
    return {
      title: `Class: ${offeringTitle}`,
      description: `Class Session for ${offeringTitle}`,
    };
  }
  return {
    title: `Meeting for Appointment ${appointmentId ?? "unknown"}`,
    description: `${appointmentType} Meeting`,
  };
}

/**
 * The `custom` blob a newly minted call carries.
 *
 * Extracted only to keep `provisionAppointmentMeeting` under the
 * cognitive-complexity limit the pipeline enforces.
 */
function buildCallCustom(args: {
  anchorSlotId: string;
  appointmentId: string | null | undefined;
  appointmentType: AppointmentsType;
  organizationId: string | null;
  profile: SessionCallProfile | null;
}): Record<string, unknown> {
  const { profile } = args;
  const { title, description } = describeCall(
    args.appointmentType,
    args.appointmentId,
    profile,
  );

  // #org-appts — which SIDE of the appointment each viewer is on. Resolved from
  // resolvePlanOwnerIds and slot membership rather than accepted from the
  // caller: this is what useSessionInfo() reads to decide who may end the call
  // for everyone, so a browser must not be able to name itself here.
  const consultantUserId = profile?.hostUserIds[0] ?? null;
  const consulteeUserId = profile?.guestUserIds[0] ?? null;

  return {
    title,
    description,
    appointmentId: args.appointmentId ?? null,
    slotId: args.anchorSlotId,
    // Named explicitly so a Stream dashboard or recording entry says which row
    // keys the room without anyone having to know `slotId` means the anchor
    // (#1061).
    anchorSlotId: args.anchorSlotId,
    appointmentType: args.appointmentType,
    ...(args.organizationId ? { organizationId: args.organizationId } : {}),
    ...(consultantUserId ? { consultantUserId } : {}),
    ...(consulteeUserId ? { consulteeUserId } : {}),
    // #1070 — the session's real shape. `CallRequest` has no `ends_at`, so the
    // end travels as call metadata; see provisionAppointmentMeeting for why the
    // one field that could enforce it is still not used.
    ...(profile
      ? {
          sessionStartsAt: profile.startsAt.toISOString(),
          sessionEndsAt: profile.endsAt.toISOString(),
          sessionDurationMinutes: profile.durationMinutes,
          ...(profile.offeringTitle
            ? { offeringTitle: profile.offeringTitle }
            : {}),
          // Both sides by name, so each screen can lead with the OTHER one.
          ...(profile.hostName ? { hostName: profile.hostName } : {}),
          ...(profile.guestName ? { guestName: profile.guestName } : {}),
        }
      : {}),
  };
}

/**
 * The outcome of asking for a session's room.
 *
 * A refusal is RETURNED rather than thrown on purpose. Next replaces an
 * uncaught server-action error with an opaque digest in production, so a thrown
 * "This session is not confirmed yet." reaches the browser as "An error
 * occurred in the Server Components render" — which is how the maintenance
 * refusal already had to travel back as a string before this moved server-side.
 * Genuine faults still throw: those are meant to be opaque.
 */
export type ProvisionedMeeting =
  | { ok: true; streamCallId: string }
  | { ok: false; refusal: string };

/**
 * Creates (or finds) the Stream call for a session, server-side (#1270).
 *
 * ## Why this is not in the browser any more
 *
 * `getOrCreateAppointmentMeeting` used to run `client.call(...).getOrCreate()`
 * from the dashboard with the signed-in user's own video client. Three things
 * followed from that, none of them intended:
 *
 *   1. Whoever pressed Join first became the call's `created_by`. For half of
 *      all sessions that is the consultee, so Stream's own record of who owns
 *      the room disagreed with the product's.
 *   2. Every field of `custom` was authored by a browser — including
 *      `consultantUserId`, the value the meeting UI derives host-ness (and
 *      therefore "End for everyone") from.
 *   3. `getOrCreate` applies the call type's device settings, so merely minting
 *      a room opened the camera and microphone on the DASHBOARD. #1271 had to
 *      release them afterwards; a room minted server-side cannot open them at
 *      all.
 *
 * The room id is unchanged — `slot-<anchorSlotId>`, derived from the run's
 * first row (#1061) — because both sides and every existing MeetingSession row
 * depend on it.
 *
 * Deliberately NOT sent (still deferred to #1070): `backstage`,
 * `join_ahead_time_seconds`, and `settings_override.limits.max_duration_seconds`.
 * The first two let Stream refuse a join, so a consultant who never calls
 * goLive() would strand a paying consultee on a backstage screen. The third
 * hard-terminates a call that overruns. The join gate stays in our code.
 *
 * @param slot Any row of the session. The anchor is resolved here.
 */

export async function provisionAppointmentMeeting(
  slot: MeetingSlot,
): Promise<ProvisionedMeeting> {
  // #1061 — a session longer than 30 minutes is N consecutive slot rows, and
  // each dashboard surface hands us a different one. Key the room to the run's
  // first row so both sides, at any point in the hour, resolve the same call.
  //
  // The `?? slot` fallback is NOT safe, and is chosen anyway: if the anchor
  // lookup fails for one of two people clicking Join at the same moment, that
  // person mints `slot-<their row>` and leaves a stray MeetingSession on a
  // non-anchor row. It is still better than refusing, which would take the
  // whole meeting down for both sides rather than degrading for one.
  // Pinned by __tests__/stream/session-room-identity.test.ts.
  const anchorSlot: MeetingSlot =
    (await resolveSessionAnchorSlot(slot.id)) ?? slot;

  // An existing session is the common case and short-circuits everything else:
  // the room already exists, and nothing below may rewrite it.
  const existingMeetingSession = await findDbMeetingSessionBySlot(
    anchorSlot.id,
  );
  if (existingMeetingSession) {
    return { ok: true, streamCallId: existingMeetingSession.streamCallId };
  }

  // Entitlement FIRST — ahead of the booking-state refusal, not just ahead of
  // the mint. #1270 review: `refuseMeetingCreation` reads the persisted slot and
  // its parent booking status for any slotId it is handed, and the resulting
  // string is returned to the caller as data. Running it first meant an
  // unentitled caller who guessed a slot id learned another user's booking
  // state — "This session is not confirmed yet.", "This session was cancelled
  // or moved." A stranger gets one answer now, and it tells them nothing.
  //
  // It is also ahead of the Stream write for the original #1077 reason: the
  // browser used to mint the call and only then call `createDbMeetingSession`,
  // where the check lived, so an unentitled caller left a real billable Stream
  // room behind that the database refused to record.
  const authorized = await readSlotForCaller(anchorSlot.id);
  if (!authorized) {
    return { ok: false, refusal: "You are not a participant in this session." };
  }

  // #1077 — anything that can refuse this join runs BEFORE the mint. Blocked
  // after it, Stream keeps a call no MeetingSession row points at, stamped with
  // whatever bounds and members were computed at the blocked moment.
  //
  // #1270 review: `getMeetingCreationRefusal` swallows every error and answers
  // `null`, so a slot read that THREW used to read as "nothing refuses this"
  // and the mint proceeded — then `createDbMeetingSession` re-ran the same
  // check, and if that second read succeeded it threw, leaving exactly the
  // orphaned billable room the ordering above exists to prevent. A refusal we
  // could not evaluate is now a refusal.
  const refusal = await getMeetingCreationRefusal(anchorSlot);
  if (refusal) return { ok: false, refusal };

  if (!isStreamConfigured()) {
    streamLogger.error("Stream not configured — cannot provision meeting", {
      slotId: anchorSlot.id,
    });
    return { ok: false, refusal: "Video is not available right now." };
  }

  const streamCallId = `slot-${anchorSlot.id}`;
  const callProfile = await resolveSessionCallProfile(anchorSlot.id);

  // The RUN's start, not the clicked row's: joining a 10:00–11:00 session from
  // its 10:30 row must not tell Stream the meeting starts at 10:30.
  const startsAt =
    callProfile?.startsAt ??
    (anchorSlot.startsAt ? new Date(anchorSlot.startsAt) : new Date());

  // The consultant owns the room, whoever opened the door. Falling back to the
  // caller keeps a session that cannot resolve its host joinable — server-side
  // auth carries no user context, so Stream requires SOME author and refuses
  // the whole GetOrCreateCall without one (#1270).
  const authorUserId = callProfile?.hostUserIds[0] ?? authorized.userId;

  // #1280 — a server-side duration cap, as a BILLING and data-integrity
  // backstop. Free: `limits.max_duration_seconds` is a call-type/per-call
  // setting, not a metered service, and it reads `null` on the live type today.
  //
  // #1144 recorded this as the highest-value unbuilt item on the grounds that
  // the SFU would end calls "at the slot boundary". #1160 corrected that, and
  // the correction is the whole design: **the timer counts from the moment the
  // FIRST PARTICIPANT JOINS, not from `starts_at`.** Set to the booked length,
  // a consultant joining fifteen minutes early to check their camera would have
  // Stream hard-terminate the session before the booked end, ejecting both
  // parties mid-sentence. `lib/meeting.ts` declined to send this field for
  // exactly that reason, and on that point it was right rather than cautious.
  //
  // So it is set GENEROUSLY: the booked run, plus the earliest anyone can join,
  // plus a grace window. It is not slot enforcement and must never be mistaken
  // for it — #472 owns overrun handling, and the application still decides when
  // a session is over.
  //
  // What it buys, which nothing else in the stack provides:
  //   1. Stream stamps `ended_at` whether or not our webhook pipeline works.
  //      #1134 found 1,417 sessions with no `endedAt` and a pipeline that had
  //      never processed one event; this is the only control that degrades
  //      gracefully through that, because it does not run on our infrastructure.
  //   2. It bounds the worst-case bill. A forgotten tab or a client that fails
  //      to tear down media bills participant minutes indefinitely, and the only
  //      thing standing between us and an unbounded meter is
  //      `inactivity_timeout_seconds` — which requires everyone to actually
  //      disconnect.
  const maxDurationSeconds = resolveMaxCallDurationSeconds(
    callProfile,
    startsAt,
  );
  if (!callProfile?.hostUserIds.length) {
    streamLogger.warn("Minting a call without a resolvable host", {
      slotId: anchorSlot.id,
      authorUserId,
    });
  }

  try {
    await withStreamCircuitBreaker(async () => {
      // Stream refuses a call operation naming a user it does not hold, and a
      // token alone never creates one. resolveSessionCallProfile syncs the
      // members it names; the author may not be among them on the fallback
      // path above. Already-synced ids are filtered inside.
      await upsertUsersToStream([authorUserId]);

      const call = getStreamVideoClient().video.call(
        STREAM_CALL_TYPE,
        streamCallId,
      );
      await call.getOrCreate({
        data: {
          created_by_id: authorUserId,
          starts_at: startsAt,
          // Omitted entirely when the run could not be resolved — see
          // `resolveMaxCallDurationSeconds`. A guessed cap is worse than none:
          // the call type carries no limit of its own, so leaving it out is
          // exactly the behaviour before this backstop existed.
          ...(maxDurationSeconds !== null
            ? {
                settings_override: {
                  limits: { max_duration_seconds: maxDurationSeconds },
                },
              }
            : {}),
          custom: buildCallCustom({
            anchorSlotId: anchorSlot.id,
            appointmentId: anchorSlot.appointmentId,
            appointmentType: authorized.appointment.appointmentType,
            organizationId: authorized.appointment.organizationId ?? null,
            profile: callProfile,
          }),
          // #1134 P0-1 — once ensure-call-type-grants strips `join-call` from
          // `user` and `guest`, membership is the ONLY thing that admits
          // anyone. A call minted without members is still joinable via
          // POST /api/meetings/[id]/join, which grants membership itself.
          ...(callProfile && callProfile.members.length > 0
            ? { members: callProfile.members }
            : {}),
        },
      });
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Failed to create the Stream call", error, {
      slotId: anchorSlot.id,
      streamCallId,
    });
    throw error instanceof Error
      ? new Error(`Failed to create meeting session: ${error.message}`, {
          cause: error,
        })
      : new Error("Failed to create meeting session.", { cause: error });
  }

  // Attached to the anchor, so MeetingSession.slotOfAppointmentId stays
  // @unique-correct: one session per run, not one per half hour. Re-checks the
  // refusal and the entitlement itself; it is the authoritative write gate and
  // is deliberately not weakened by the hoisted copies above.
  await createDbMeetingSession(anchorSlot, streamCallId);

  return { ok: true, streamCallId };
}
