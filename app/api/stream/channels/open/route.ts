/**
 * Resolve-or-create the channel behind a search result, server-side.
 *
 * ## Why this route exists
 *
 * `ChannelSearch` used to open a result by calling
 * `client.channel(type, id).watch()` on an id the browser had computed. In
 * `stream-chat`, `watch()` posts to the channel **query** endpoint — the same
 * endpoint `create()` posts to; `channel.create()` is literally
 * `query({ created_by_id })`. So `watch()` on an id that does not exist yet
 * CREATES it. Created that way, with no `members` array, the caller becomes
 * `created_by` and is *not* a member.
 *
 * That one behaviour produced every symptom of the reported bug at once: the
 * header showed the raw `dm-…` id (channelUtils has no branch for a DM with
 * zero counterparties), it said "No members", the message sent fine, and the
 * thread vanished on reload because the sidebar queries
 * `{ members: { $in: [me] } }`. It was reported as "I can talk to myself" but
 * reproduces identically against a stranger — the phantom channel is not a
 * property of the pair, it is a property of the id not existing.
 *
 * The id did not exist because search matches `APPROVED_PENDING_PAYMENT` and
 * `COMPLETED` bookings, while channel creation only ever fired at approval and
 * payment-success. Widening `DM_ELIGIBLE_STATUSES` fixes the *set*; this route
 * fixes the *mechanism*, so a future gap cannot be papered over by the client
 * inventing a channel.
 *
 * ## Contract
 *
 * The client sends WHO or WHAT it wants to talk to, never a channel id. The id
 * is re-derived here from the caller's session plus the target. A client-
 * supplied channel id would be an authorization bypass by construction: the id
 * is a pure function of the two user ids, so anyone able to name a pair could
 * name their channel.
 *
 * Both arms are idempotent — an existing channel is returned untouched.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import * as Sentry from "@sentry/nextjs";

import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { CLASS_PREFIX, WEBINAR_PREFIX } from "@/lib/stream-channel-ids";
import {
  canDirectMessage,
  DmNotPermittedError,
  pairBookingContexts,
} from "@/lib/stream/dm-eligibility";
import {
  DM_ELIGIBLE_STATUSES,
  OPENABLE_EVENT_STATUSES,
} from "@/lib/stream/dm-eligibility-statuses";
import { DEFAULT_RETENTION_DAYS, isPastRetention } from "@/lib/stream/channel-lifecycle";
import { applyRateLimit, streamApiLimiter } from "@/lib/rate-limit";
import { createDirectMessageChannel } from "@/actions/stream/chat/channel.action";
import { addUserToEventChannel } from "@/actions/stream/chat/event-channel.action";
import { streamLogger } from "@/lib/stream-logger";

const bodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("dm"),
    counterpartyUserId: z.string().min(1),
    /** Funding context. Absent or null = personal. */
    organizationId: z.string().min(1).nullable().optional(),
  }),
  z.object({
    kind: z.literal("event"),
    eventType: z.enum(["webinar", "class"]),
    eventId: z.string().min(1),
  }),
]);

/**
 * Is the caller a participant in this event — an attendee on one of its slots,
 * or the host consultant?
 *
 * Deliberately NOT `authorizeEventAccess` from lib/auth-helpers: for webinars
 * and classes that helper authorizes the plan owner and ACCEPTED collaborators
 * only, and returns 403 for attendees. Attendees are exactly who needs the
 * event chat. This mirrors the predicate the search route already applies, so
 * the two cannot disagree about which rows are clickable.
 *
 * The retention guard (second query) is F-HIGH-2's other half: dev's fix keeps
 * past-retention events out of the sync expected-set, but create-on-miss here
 * would resurrect the hard-deleted channel anyway — writable until the expire
 * cron's next pass re-freezes it. An event whose last slot ended more than
 * `retentionDays` ago is not openable, full stop.
 */
async function isEventParticipant(
  eventType: "webinar" | "class",
  eventId: string,
  userId: string,
): Promise<boolean> {
  if (eventType === "webinar") {
    const hit = await prisma.webinar.findFirst({
      where: {
        id: eventId,
        status: { in: [...OPENABLE_EVENT_STATUSES] },
        OR: [
          {
            appointment: {
              deletedAt: null,
              slotsOfAppointment: {
                some: { deletedAt: null, user: { some: { id: userId } } },
              },
            },
          },
          { webinarPlan: { consultantProfile: { userId } } },
        ],
      },
      select: {
        id: true,
        appointment: {
          select: {
            organization: { select: { streamRecordingRetentionDays: true } },
            slotsOfAppointment: {
              orderBy: { endsAt: "desc" },
              take: 1,
              select: { endsAt: true },
            },
          },
        },
      },
    });
    if (!hit) return false;
    return !isPastRetention(
      hit.appointment?.slotsOfAppointment[0]?.endsAt ?? null,
      hit.appointment?.organization?.streamRecordingRetentionDays ??
        DEFAULT_RETENTION_DAYS,
    );
  }

  const hit = await prisma.class.findFirst({
    where: {
      id: eventId,
      status: { in: [...OPENABLE_EVENT_STATUSES] },
      OR: [
        {
          appointments: {
            some: {
              deletedAt: null,
              slotsOfAppointment: {
                some: { deletedAt: null, user: { some: { id: userId } } },
              },
            },
          },
        },
        { classPlan: { consultantProfile: { userId } } },
      ],
    },
    select: {
      id: true,
      appointments: {
        // A class spans one appointment per cohort but ONE channel; age is the
        // latest end across cohorts, carrying that cohort's org dial — same
        // collapse rule as the expire cron. Each appointment contributes only
        // its own latest slot (orderBy+take below), so this stays one row per
        // cohort.
        select: {
          organization: { select: { streamRecordingRetentionDays: true } },
          slotsOfAppointment: {
            orderBy: { endsAt: "desc" },
            take: 1,
            select: { endsAt: true },
          },
        },
      },
    },
  });
  if (!hit) return false;
  const latestCohort = hit.appointments.reduce<
    | {
        endsAt: Date;
        retentionDays: number;
      }
    | null
  >((latest, apt) => {
    const aptLatest = apt.slotsOfAppointment[0]?.endsAt;
    if (!aptLatest) return latest;
    const retentionDays =
      apt.organization?.streamRecordingRetentionDays ?? DEFAULT_RETENTION_DAYS;
    if (!latest || aptLatest > latest.endsAt) {
      return { endsAt: aptLatest, retentionDays };
    }
    return latest;
  }, null);
  return !isPastRetention(
    latestCohort?.endsAt ?? null,
    latestCohort?.retentionDays ?? DEFAULT_RETENTION_DAYS,
  );
}

export async function POST(request: NextRequest) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const userId = auth.session.user.id;

  // Keyed on the user, after auth, before any Prisma or Stream work. This route
  // is cheap to call and expensive to serve — an eligibility check plus a Stream
  // create — and `streamApiLimiter` already existed for exactly this and had no
  // callers. Route-slugged, per the helper's own guidance on sharing a limiter.
  const limited = await applyRateLimit(streamApiLimiter, `open:${userId}`);
  if (limited) return limited;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  try {
    if (body.kind === "dm") {
      const { counterpartyUserId } = body;
      const requestedOrgId = body.organizationId ?? null;

      // Covers the self case too — `canDirectMessage` returns false for
      // `a === b` before it touches the database.
      if (!(await canDirectMessage(userId, counterpartyUserId))) {
        streamLogger.warn("Refused DM open — no booking link", {
          userId,
          counterpartyUserId,
        });
        return NextResponse.json(
          {
            error:
              "Direct messages are only available between people who share a booking.",
            eligibleStatuses: DM_ELIGIBLE_STATUSES,
          },
          { status: 403 },
        );
      }

      // Funding-context forgery guard. The channel id is re-derived
      // server-side, but it is a function of the pair AND the funding context —
      // so an org id accepted unchecked would let anyone mint
      // `dmo-<digest(arbitrary)>-…` channels tagged to an organization they
      // have no relation to, and omitting it for an org-funded booking would
      // mint a personal-id channel the reconciler immediately classifies stale.
      // The allowed contexts come from the same rows (and the same
      // `bookingOrgId` precedence) the reconciler's expected-set is built from.
      const contexts = await pairBookingContexts(userId, counterpartyUserId);
      let organizationId: string | null;
      if (requestedOrgId !== null) {
        if (!contexts.organizations.includes(requestedOrgId)) {
          return NextResponse.json(
            {
              error:
                "No booking ties this conversation to that organization.",
            },
            { status: 403 },
          );
        }
        organizationId = requestedOrgId;
      } else if (contexts.personalAllowed) {
        organizationId = null;
      } else if (contexts.organizations.length === 1) {
        // Personal context requested, but every eligible booking is org-funded:
        // deriving the single real context here instead of minting a channel
        // the reconciler would evict on the next sync.
        organizationId = contexts.organizations[0];
      } else {
        return NextResponse.json(
          {
            error:
              "This conversation exists in multiple organizations — specify which one.",
          },
          { status: 400 },
        );
      }

      // Idempotent: Stream's create is an upsert for an existing id, and the
      // member list is passed atomically so the pair is always both members —
      // which is the whole difference from what `watch()` was doing.
      //
      // The returned `channelId` is used rather than re-deriving it with
      // `getDmChannelId`. Same inputs, same helper, so the two agreed — but
      // deriving an id twice is two chances to derive it differently, and this
      // codebase has already lost conversation history once to exactly that
      // (#1134 P0-3, the `localeCompare` re-keying). One derivation, one source.
      const { channelId } = await createDirectMessageChannel(
        userId,
        counterpartyUserId,
        organizationId,
      );

      return NextResponse.json({ channelType: "messaging", channelId });
    }

    const { eventType, eventId } = body;
    if (!(await isEventParticipant(eventType, eventId, userId))) {
      return NextResponse.json(
        { error: "You are not a participant in this event." },
        { status: 403 },
      );
    }

    // Creates the channel with the full roster if absent, adds the caller if
    // present. Also idempotent.
    //
    // #1270 — the result is load-bearing now that a DPDP consent refusal is a
    // skip rather than a throw. Returning 200 here would hand the client a
    // channel id it is not a member of, and the failure would surface later as
    // an empty, un-postable thread.
    const admission = await addUserToEventChannel(eventType, eventId, userId);
    if (!admission.success) {
      return NextResponse.json(
        {
          error:
            "Chat is unavailable because data-processing consent for messaging has not been granted.",
        },
        { status: 403 },
      );
    }

    const channelId =
      eventType === "webinar"
        ? `${WEBINAR_PREFIX}${eventId}`
        : `${CLASS_PREFIX}${eventId}`;
    return NextResponse.json({ channelType: "team", channelId });
  } catch (error) {
    // A refusal is an answer, not an incident. This is currently unreachable —
    // the DM branch checks `canDirectMessage` before calling — but
    // `createDirectMessageChannel` asserts eligibility itself, so a future
    // caller, or a booking cancelled between the check and the create, would
    // otherwise page someone at 3am for a gate doing its job.
    if (error instanceof DmNotPermittedError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Failed to open channel", error, { userId });
    return NextResponse.json(
      { error: "Failed to open conversation" },
      { status: 500 },
    );
  }
}
