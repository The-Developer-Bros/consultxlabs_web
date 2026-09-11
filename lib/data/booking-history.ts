/**
 * The read side of the booking audit trail — #1319 PR 8, closing the #448
 * "no staff booking surface exists" ask.
 *
 * #1322 gave every guarded transition an append-only `BookingStatusHistory`
 * row; nothing read them. This is that reader, and it is deliberately the only
 * one: `getBookingTimeline` merges the status log with the reschedule
 * proposals raised against the same appointment into a single newest-first
 * list, which is what the #448 "RescheduleLog" ask asked for. No new table
 * exists or is needed — the two sources already hold the whole story.
 *
 * Two rules shape the query below.
 *
 * `BookingStatusHistory.appointmentId` is nullable, and the `appointmentId` arm
 * of the OR below is the one that resolves a row directly. As of #1333 every
 * helper in `lib/booking/transitions.ts` fills it from the row's own pre-image,
 * so new rows carry it — but two cases still leave it NULL and both are by
 * design: a subscription or class that owns several live appointments has no
 * single id to stamp, and a trial that has not been placed yet has no
 * appointment at all. Every row written before #1333 is NULL too, and there is
 * no backfill (doctrine rule 6).
 *
 * So the entity arms are not a fallback that could be retired — they are what
 * makes the trail complete. The reader collects the appointment's own
 * polymorphic keys — its request/event/trial id, every one of its slot ids, and
 * every reschedule request id — and matches each of them against `entityId`
 * PAIRED with the entity type its writer stamps, because `entityId` alone is
 * unconstrained and would admit a same-id row of another type.
 *
 * Reading it is privileged-only. ADR 20
 * (`docs/enterprise/70-design-decisions/20-org-visibility-into-member-sessions.md`)
 * gives organization roles no per-session drill-in at all, so the scope
 * parameter is narrowed to the single privileged kind at the type level rather
 * than branched on at runtime, and every user the trail names is read through
 * a select allow-list that stops at id and name (#946 — no email, ever).
 */

import type {
  BookingHistoryEntity,
  RescheduleInitiatorRole,
} from "@prisma/client";

import type { Scope } from "@/lib/api/scope/parse";
import prisma from "@/lib/prisma";

/**
 * The only `Scope` that may read another person's audit trail. Narrowing the
 * parameter this way makes an org or personal caller a compile error rather
 * than a runtime branch someone could later widen by accident (ADR 20).
 */
export type PrivilegedScope = Extract<Scope, { kind: "all" }>;

/** Attribution carries a name, never an email or an avatar (#946). */
export interface BookingTimelineActor {
  id: string;
  name: string | null;
}

export interface BookingTimelineEntry {
  id: string;
  /**
   * `status` is one `BookingStatusHistory` row — a state machine edge that
   * fired. `reschedule` is one `RescheduleRequest` — the proposal itself,
   * stamped at the moment it was raised.
   */
  kind: "status" | "reschedule";
  entity: BookingHistoryEntity;
  entityId: string;
  /**
   * Null on reschedule rows: a proposal is raised, it does not move out of a
   * prior state. On status rows this is the pre-image the CAS observed, which
   * is `"UNKNOWN"` when a concurrent writer moved the row between the pre-read
   * and the update (the documented A12 limitation) and `"CREATED"` on the one
   * row that is not a transition at all (#1333).
   */
  from: string | null;
  /** On reschedule rows this is where the proposal ended up, not a transition. */
  to: string;
  reason: string | null;
  actor: BookingTimelineActor | null;
  /** ISO-8601, so the payload is JSON-safe verbatim on both paths. */
  createdAt: string;
  /** Reschedule rows only — how many concrete times the proposal named. */
  proposedSlotCount?: number;
  /** Reschedule rows only — 1 is the opening proposal, 2 the single counter. */
  round?: number;
  /** Reschedule rows only — which side raised it. */
  initiatorRole?: RescheduleInitiatorRole;
  /** Reschedule rows only — null while the proposal is still open. */
  resolvedAt?: string | null;
}

export interface BookingTimeline {
  appointmentId: string;
  /** Newest first. */
  entries: BookingTimelineEntry[];
  /** True when older events exist beyond `TIMELINE_LIMIT` and were dropped. */
  truncated: boolean;
}

/**
 * A year-long subscription with a weekly session accumulates hundreds of slot
 * transitions, and this feeds a modal. Operators want the recent story; the
 * flag below tells them when there is more behind it.
 */
const TIMELINE_LIMIT = 200;

/** Deterministic, collation-independent tie-break for equal timestamps. */
function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * The merged audit trail for one appointment, newest first, or `null` when no
 * such appointment exists.
 *
 * A soft-deleted appointment is deliberately still readable: the tombstone is
 * precisely the case an operator opens this surface to explain (#448, and rule
 * 2 of the booking doctrine — nothing is deleted, so nothing disappears from
 * the audit trail either).
 */
export async function getBookingTimeline(
  appointmentId: string,
  scope: PrivilegedScope,
): Promise<BookingTimeline | null> {
  // The type signature is the real gate; this catches an untyped caller and a
  // future `Scope` variant that widens `all` (ADR 20 — fail closed).
  if (scope?.kind !== "all") {
    throw new Error(
      'getBookingTimeline is privileged-only: pass { kind: "all" }. Organization and personal scopes get no session drill-in (ADR 20).',
    );
  }

  // One round trip for the appointment's polymorphic keys AND its reschedule
  // proposals — PG_POOL_MAX=1 serialises Prisma reads on this host, so a
  // nested select beats two awaits.
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      consultationId: true,
      subscriptionId: true,
      webinarId: true,
      classId: true,
      trialSession: { select: { id: true } },
      // Every slot, including the CANCELLED and RESCHEDULED tombstones: a
      // released slot is exactly what the operator came here to see.
      slotsOfAppointment: { select: { id: true } },
      rescheduleRequests: {
        select: {
          id: true,
          status: true,
          round: true,
          reason: true,
          initiatorRole: true,
          createdAt: true,
          resolvedAt: true,
          // Allow-list, not `include`: the initiator is a person, so the
          // select stops at id and name (#946).
          initiatedBy: { select: { id: true, name: true } },
          _count: { select: { proposedSlots: true } },
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!appointment) return null;

  // Each key is carried with the entity type its writer stamps beside it —
  // `lib/booking/transitions.ts` appends exactly one entity per call site, so
  // this table is the read side of that pairing.
  const keysByEntity: {
    entity: BookingHistoryEntity;
    ids: (string | null | undefined)[];
  }[] = [
    { entity: "CONSULTATION", ids: [appointment.consultationId] },
    { entity: "SUBSCRIPTION", ids: [appointment.subscriptionId] },
    { entity: "WEBINAR", ids: [appointment.webinarId] },
    { entity: "CLASS", ids: [appointment.classId] },
    { entity: "TRIAL", ids: [appointment.trialSession?.id] },
    {
      entity: "SLOT",
      ids: appointment.slotsOfAppointment.map((slot) => slot.id),
    },
    {
      entity: "RESCHEDULE_REQUEST",
      ids: appointment.rescheduleRequests.map((request) => request.id),
    },
  ];

  const entityMatches = keysByEntity
    .map(({ entity, ids }) => ({
      entity,
      entityId: { in: ids.filter((id): id is string => Boolean(id)) },
    }))
    // An empty `in` matches nothing anyway; dropping the arm keeps the OR to
    // the entities this appointment actually has.
    .filter((match) => match.entityId.in.length > 0);

  const history = await prisma.bookingStatusHistory.findMany({
    where: {
      OR: [
        { appointmentId: appointment.id },
        // One `{ entity, entityId }` pair per source, never a bare id list:
        // `entityId` is polymorphic and unconstrained, so a bare list would
        // admit a row of a different type that happened to carry the same id.
        ...entityMatches,
      ],
    },
    select: {
      id: true,
      entity: true,
      entityId: true,
      fromStatus: true,
      toStatus: true,
      reason: true,
      createdAt: true,
      actorUser: { select: { id: true, name: true } },
    },
    // `take` cuts the window in the database, before the merge below, so equal
    // timestamps need a second key or the row at the cutoff changes between
    // reads. Ascending id matches the in-memory tie-break.
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    // One over the limit, so "there is more" is measured rather than guessed.
    take: TIMELINE_LIMIT + 1,
  });

  const statusEntries: BookingTimelineEntry[] = history
    .slice(0, TIMELINE_LIMIT)
    .map((row) => ({
      id: row.id,
      kind: "status" as const,
      entity: row.entity,
      entityId: row.entityId,
      from: row.fromStatus,
      to: row.toStatus,
      reason: row.reason,
      actor: row.actorUser
        ? { id: row.actorUser.id, name: row.actorUser.name }
        : null,
      createdAt: row.createdAt.toISOString(),
    }));

  const rescheduleEntries: BookingTimelineEntry[] =
    appointment.rescheduleRequests.map((request) => ({
      id: request.id,
      kind: "reschedule" as const,
      entity: "RESCHEDULE_REQUEST",
      entityId: request.id,
      from: null,
      to: request.status,
      reason: request.reason,
      actor: request.initiatedBy
        ? { id: request.initiatedBy.id, name: request.initiatedBy.name }
        : null,
      createdAt: request.createdAt.toISOString(),
      proposedSlotCount: request._count.proposedSlots,
      round: request.round,
      initiatorRole: request.initiatorRole,
      resolvedAt: request.resolvedAt ? request.resolvedAt.toISOString() : null,
    }));

  const merged = [...statusEntries, ...rescheduleEntries].sort((a, b) => {
    const delta = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    return delta !== 0 ? delta : compareIds(a.id, b.id);
  });

  // Measured on both sources: the status log over-fetches by one, and the
  // proposals merged into it can push the list past the limit on their own.
  const truncated =
    history.length > TIMELINE_LIMIT || merged.length > TIMELINE_LIMIT;

  return {
    appointmentId: appointment.id,
    entries: merged.slice(0, TIMELINE_LIMIT),
    truncated,
  };
}
