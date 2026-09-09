import { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import {
  getStreamVideoClient,
  isStreamConfigured,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import {
  CONSULTEE_JOIN_WINDOW_MS,
  CONSULTANT_JOIN_WINDOW_MS,
  getCurrentOrNextSession,
  getSessionJoinState,
  isDeliberateEnd,
} from "@/lib/appointments/slots";
import {
  isCancelledLikeStatus,
  isCompletedLikeStatus,
  isConfirmedStatus,
} from "@/lib/appointments/status";

/**
 * #1134 P0-1 — the single definition of "may this user join this meeting".
 *
 * It used to live inline in the validate-access route, which was the ONLY gate
 * on a video call: the meeting page rendered "Access Denied" from a React
 * conditional while the Stream token authorized every call in the app, so
 * `client.call(type, id).join()` from devtools walked straight into a private
 * consultation. `POST /api/meetings/[meetingId]/join` now shares this function
 * and grants Stream call membership only when it says yes — so with `join-call`
 * moved off the `user` role, this answer is what Stream itself enforces, not
 * just what the UI draws. `validate-access` shares it too, as a read-only probe,
 * so the gate and the affordance can never give different answers.
 */
export type MeetingRole = "host" | "participant" | null;

/**
 * Why access was granted or refused, as a stable value.
 *
 * Callers need this to pick an HTTP status, and both of them used to do it by
 * comparing `message` to the literal `"Meeting not found"`. Rewording a
 * user-facing string would have silently turned a 404 into a 403 in two routes
 * at once — the sort of coupling that survives review because nothing about the
 * string says it is load-bearing.
 */
export type MeetingAccessReason = "granted" | "not_found" | "unauthorized";

/** The meeting row does not exist. Nothing further is known about it. */
interface MeetingNotFound {
  hasAccess: false;
  role: null;
  message: string;
  reason: "not_found";
}

/**
 * The meeting exists — so the session and its appointment are always present,
 * whether or not this caller may join.
 *
 * A union rather than one interface with optional fields, because the caller
 * that needs the appointment needs it exactly when `hasAccess` is true, and an
 * optional field forces a `!` or a redundant re-check at every use. Narrowing
 * on `hasAccess` eliminates `MeetingNotFound` and leaves these non-optional.
 */
interface MeetingResolved {
  hasAccess: boolean;
  role: MeetingRole;
  message: string;
  /** Machine-readable verdict. Branch on this, never on `message`. */
  reason: "granted" | "unauthorized";
  streamCallId: string;
  meetingSessionId: string;
  /**
   * The appointment this meeting belongs to, with each plan's owner and
   * `recordingEnabled` — the shape `lib/stream/recording-utils` consumes.
   *
   * Handed back because the consent endpoints were re-querying the same row
   * immediately after the access check. The four plan relations are already
   * joined for the ownership test, so carrying one more column each costs
   * nothing and removes a whole round trip from both handlers.
   */
  appointment: MeetingAppointment;
}

export type MeetingAccess = MeetingNotFound | MeetingResolved;

/** Inferred from the resolver's own query — never hand-maintained. */
type ResolvedMeetingSession = NonNullable<
  Awaited<ReturnType<typeof loadMeetingSession>>
>;
export type MeetingAppointment =
  ResolvedMeetingSession["slotOfAppointment"]["appointment"];

/** Hoisted so `MeetingAppointment` can be inferred from the real query. */
const MEETING_SESSION_INCLUDE = {
  slotOfAppointment: {
    include: {
      user: { select: { id: true } },
      appointment: {
        include: {
          consultation: {
            include: {
              consultationPlan: {
                select: {
                  consultantProfileId: true,
                  recordingEnabled: true,
                },
              },
            },
          },
          subscription: {
            include: {
              subscriptionPlan: {
                select: {
                  consultantProfileId: true,
                  recordingEnabled: true,
                },
              },
            },
          },
          webinar: {
            include: {
              webinarPlan: {
                select: {
                  id: true,
                  consultantProfileId: true,
                  recordingEnabled: true,
                },
              },
            },
          },
          class: {
            include: {
              classPlan: {
                select: {
                  id: true,
                  consultantProfileId: true,
                  recordingEnabled: true,
                },
              },
            },
          },
          trialSession: {
            select: { consultantProfileId: true, status: true },
          },
        },
      },
    },
  },
} satisfies Prisma.MeetingSessionInclude;

function loadMeetingSession(meetingId: string) {
  return prisma.meetingSession.findUnique({
    where: { streamCallId: meetingId },
    include: MEETING_SESSION_INCLUDE,
  });
}

/**
 * Whether a booking's own status permits joining its room at all, and what to
 * say when it does not (#1270).
 *
 * This used to be a DENYLIST of three values — CANCELLED, REJECTED, EXPIRED —
 * while the Join affordance in every dashboard is an ALLOWLIST,
 * `isConfirmedStatus` = {APPROVED, SCHEDULED, IN_PROGRESS}. Everything in
 * neither set passed the server gate while the UI hid the button: PENDING, a
 * DRAFT webinar, and — the one that mattered — `APPROVED_PENDING_PAYMENT` and
 * its trial twin `AWAITING_PAYMENT`. A consultant who typed /meetings/<id>
 * walked into a booking nobody had paid for. #1272 closed that in the UI only.
 * The two now read the same predicate, which is what the header of this file
 * says the whole module exists for.
 *
 * Completed-like statuses are the deliberate exception, and they are handed to
 * the time gate rather than refused here. `meetingPolicyRefusal` already owns
 * "has this session finished", including the 30-minute reconnect grace, and it
 * is stricter than a status check everywhere except inside that grace — where a
 * status check would be WRONG. #1278 deleted the bufferless
 * `app/api/cleanup/auto-complete-trials` route this paragraph used to cite as
 * the concrete hazard: it flipped a trial to COMPLETED the moment any one of
 * its slots ended. Trials now complete only through the hourly
 * `auto-complete-appointments` job, which waits a full hour past the last slot
 * and so lands outside the grace. The delegation stands regardless, because
 * status is a coarse eventually-consistent summary while the time gate reads
 * the slot rows and the meeting session itself.
 *
 * @returns The refusal message, or null when the status permits a join.
 */
function bookingStatusRefusal(status: string | null): string | null {
  if (!status) return null;
  if (isConfirmedStatus(status) || isCompletedLikeStatus(status)) return null;
  // Cancelled, rejected and expired are over for good; everything else that
  // lands here — pending, awaiting payment, a draft event — is a booking that
  // has not been confirmed yet, and says so in the same words the tentative
  // slot check uses.
  return isCancelledLikeStatus(status)
    ? "This booking is no longer active."
    : "This session is not confirmed yet.";
}

/**
 * How long after the scheduled run end a disconnected participant may still
 * re-enter. Calls overrun; without grace a reconnect at endsAt+1s would hit
 * a locked door mid-consultation. Past this — or once the host has ended the
 * call (meetingSession.endedAt) — the room is closed for good.
 */
const REJOIN_GRACE_MS = 30 * 60 * 1000;

/**
 * E2E-audit P1 fix — the SERVER-side policy gate. Identity ("are you on this
 * appointment?") was necessary but not sufficient: nothing refused a valid
 * participant days early, hours after the host ended the call, after
 * cancellation, or on an unpaid tentative booking — every one of those rules
 * lived only in React. This answers "is this session live/open yet?" from the
 * same run/window helpers the dashboards use, so the gate and the affordance
 * cannot drift.
 *
 * Returns null when joining is permitted; otherwise a user-facing refusal.
 */
async function meetingPolicyRefusal(args: {
  appointmentId: string;
  role: Exclude<MeetingRole, null>;
  streamCallId: string;
}): Promise<string | null> {
  const now = new Date();

  const slots = await prisma.slotOfAppointment.findMany({
    where: { appointmentId: args.appointmentId, deletedAt: null },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      isTentative: true,
      completionStatus: true,
      appointmentId: true,
      meetingSession: {
        select: { id: true, endedAt: true, endedReason: true },
      },
    },
  });

  const run = getCurrentOrNextSession(slots, now);
  if (!run) return "This session has no active time slot.";

  const state = getSessionJoinState(run, {
    joinWindowMs:
      args.role === "host"
        ? CONSULTANT_JOIN_WINDOW_MS
        : CONSULTEE_JOIN_WINDOW_MS,
    now,
  });

  switch (state) {
    case "disabled":
      return run.anchor.isTentative
        ? "This session is not confirmed yet."
        : "This session is no longer available.";
    case "countdown":
      return `Join opens ${
        (args.role === "host"
          ? CONSULTANT_JOIN_WINDOW_MS
          : CONSULTEE_JOIN_WINDOW_MS) / 60000
      } minutes before the start time.`;
    case "ended": {
      // A DELIBERATE end — the host closing the room, or a maintenance drain —
      // closes it for everyone, immediately. An inactivity timeout does not:
      // see isDeliberateEnd. #1270.
      if (run.slots.some((slot) => isDeliberateEnd(slot.meetingSession))) {
        return "This session has ended.";
      }

      // Inside the clock grace, a reconnect is fine.
      if (now.getTime() <= run.endsAt.getTime() + REJOIN_GRACE_MS) return null;

      // #1270 — past the clock grace, ask the room rather than the calendar.
      // Sessions overrun, and a fixed window locked a dropped participant out
      // of a call that was demonstrably still running with their counterpart
      // in it. Only reached on the path that was about to refuse, so the happy
      // path pays nothing for it.
      if (await callHasLiveParticipants(args.streamCallId)) return null;

      return "This session has ended.";
    }
    default:
      return null;
  }
}

/**
 * Does this call currently have anyone in it?
 *
 * #1270 — the rejoin grace used to be a fixed 30 minutes from the SCHEDULED
 * end, which locked a dropped participant out of a session that was visibly
 * still running. Sessions overrun; the calendar is a worse authority on
 * "is this over" than the room itself.
 *
 * Fails CLOSED on a Stream error, and that is the right direction here even
 * though it reads backwards. This probe only ever ADDS permission: it runs
 * solely on the path that was already about to refuse, because the scheduled
 * end plus the grace has passed. So "we could not ask the room" lands on the
 * same answer the caller would have got without the probe at all. Failing open
 * would be a new grant issued on the strength of an outage.
 */
async function callHasLiveParticipants(streamCallId: string): Promise<boolean> {
  if (!isStreamConfigured()) return false;
  try {
    // #1270 review — through the breaker, like every other server-side Stream
    // call in this cohort. Without it, during a Stream incident this probe runs
    // on the request thread for every refused join and waits out the SDK's
    // 30-second default, and its failures never feed the breaker that exists to
    // stop exactly that.
    const { call: state } = await withStreamCircuitBreaker(() =>
      getStreamVideoClient()
        .video.call(STREAM_CALL_TYPE, toCallId(streamCallId))
        .get(),
    );
    if (state.ended_at) return false;
    return (state.session?.participants?.length ?? 0) > 0;
  } catch {
    // Includes "call does not exist", which is a legitimate no.
    return false;
  }
}

export async function resolveMeetingAccess(
  meetingId: string,
  userId: string,
): Promise<MeetingAccess> {
  const meetingSession = await loadMeetingSession(meetingId);

  if (!meetingSession) {
    return {
      hasAccess: false,
      role: null,
      message: "Meeting not found",
      reason: "not_found",
    };
  }

  const streamCallId = meetingSession.streamCallId;
  const meetingSessionId = meetingSession.id;
  const appointment = meetingSession.slotOfAppointment.appointment;

  const userProfile = await prisma.user.findUnique({
    where: { id: userId },
    select: { consultantProfileId: true },
  });

  let isParticipant = meetingSession.slotOfAppointment.user.some(
    (u: { id: string }) => u.id === userId,
  );

  const consultantProfileId =
    appointment.consultation?.consultationPlan?.consultantProfileId ??
    appointment.subscription?.subscriptionPlan?.consultantProfileId ??
    appointment.webinar?.webinarPlan?.consultantProfileId ??
    appointment.class?.classPlan?.consultantProfileId ??
    appointment.trialSession?.consultantProfileId ??
    null;

  /**
   * Every grant funnels through the policy gate — identity alone is no longer
   * sufficient (see meetingPolicyRefusal above).
   */
  const grant = async (
    role: Exclude<MeetingRole, null>,
    message: string,
  ): Promise<MeetingAccess> => {
    // The booking's status lives on its parent row, not on Appointment.
    //
    // #1270 — the trial's status is now passed through as itself. It used to be
    // flattened to "CANCELLED" for two values and to null for every other one,
    // which is how AWAITING_PAYMENT — the trial equivalent of
    // APPROVED_PENDING_PAYMENT — reached the room without anyone paying.
    const bookingStatus =
      appointment.consultation?.status ??
      appointment.subscription?.status ??
      appointment.webinar?.status ??
      appointment.class?.status ??
      appointment.trialSession?.status ??
      null;
    const statusRefusal = bookingStatusRefusal(bookingStatus);
    if (statusRefusal || appointment.deletedAt) {
      return {
        hasAccess: false,
        role: null,
        message: statusRefusal ?? "This booking is no longer active.",
        reason: "unauthorized",
        streamCallId,
        meetingSessionId,
        appointment,
      };
    }
    const refusal = await meetingPolicyRefusal({
      appointmentId: appointment.id,
      role,
      streamCallId,
    });
    if (refusal) {
      return {
        hasAccess: false,
        role: null,
        message: refusal,
        reason: "unauthorized",
        streamCallId,
        meetingSessionId,
        appointment,
      };
    }
    return {
      hasAccess: true,
      role,
      message,
      reason: "granted",
      streamCallId,
      meetingSessionId,
      appointment,
    };
  };

  if (
    consultantProfileId &&
    userProfile?.consultantProfileId === consultantProfileId
  ) {
    return grant("host", "Access granted as meeting host");
  }

  // An accepted collaborator on the webinar/class hosts alongside the owner.
  if (userProfile?.consultantProfileId) {
    const webinarPlanId = appointment.webinar?.webinarPlan?.id;
    const classPlanId = appointment.class?.classPlan?.id;

    if (webinarPlanId || classPlanId) {
      const collab = await prisma.collaborator.findFirst({
        where: {
          consultantProfileId: userProfile.consultantProfileId,
          status: "ACCEPTED",
          ...(webinarPlanId ? { webinarPlanId } : { classPlanId }),
        },
        select: { id: true },
      });
      if (collab) {
        return grant("host", "Access granted as accepted collaborator");
      }
    }
  }

  // For classes/webinars the meeting hangs off the consultant's allocation slot
  // while the attendee is joined to a separate enrollment slot under the same
  // appointment, so a direct slot check misses them.
  if (!isParticipant && (appointment.class || appointment.webinar)) {
    // An existence probe, not a fan-out: a 200-attendee webinar used to load
    // every slot and every joined user id back into the process to answer a
    // question about one person.
    const enrolledSlot = await prisma.slotOfAppointment.findFirst({
      where: {
        appointmentId: appointment.id,
        user: { some: { id: userId } },
      },
      select: { id: true },
    });
    isParticipant = enrolledSlot !== null;
  }

  if (isParticipant) {
    return grant("participant", "Access granted as participant");
  }

  return {
    hasAccess: false,
    role: null,
    message: "You are not authorized to join this meeting",
    reason: "unauthorized",
    streamCallId,
    meetingSessionId,
    appointment,
  };
}
