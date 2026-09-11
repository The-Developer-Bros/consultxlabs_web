/**
 * Shared slot/session time predicates. Single source of truth for the join
 * window — previously duplicated (with different windows and strictness) in
 * the consultee useEventActions hook and the consultant joinState util.
 */

import {
  toDate,
  toDateOrNull,
  type AppointmentKind,
  type SessionVM,
} from "./view-model";

export const DEFAULT_MEETING_DURATION_MS = 60 * 60 * 1000;

/**
 * Consultee join window (pre-start).
 *
 * #1270 — this and its consultant sibling are the ONLY two join windows in the
 * product. Six surfaces used to declare their own, landing on four different
 * answers, so the same booking opened at four different times depending on
 * which page the user happened to be looking at. Every caller imports one of
 * these two; nobody re-declares a literal.
 */
export const CONSULTEE_JOIN_WINDOW_MS = 10 * 60 * 1000;
/** Consultant join window (pre-start) — hosts get in earlier to set up. */
export const CONSULTANT_JOIN_WINDOW_MS = 15 * 60 * 1000;

export type SlotJoinState = "disabled" | "countdown" | "joinable" | "ended";

/**
 * Structural slot shape the session helpers below accept. Deliberately looser
 * than `SlotLike`: the join surfaces also hand us `lib/meeting`'s `MeetingSlot`
 * and planner rows, which carry no `completionStatus` and an optional
 * `isTentative`.
 */
export interface SessionSlotLike {
  id: string;
  appointmentId?: string | null;
  startsAt: Date | string;
  endsAt?: Date | string | null;
  isTentative?: boolean | null;
  completionStatus?: string | null;
  meetingSession?: {
    id: string;
    endedAt: Date | string | null;
    /**
     * #1270 — REQUIRED, not optional, and deliberately so. `isDeliberateEnd`
     * treats an absent reason as deliberate, which is the safe reading for a
     * historical row written before the column existed. But it is the WRONG
     * reading for a projection that simply forgot to select it: every
     * timed-out session would read as deliberately ended and lock people out
     * of their own booking, which is the bug this predicate exists to prevent.
     * Making it required means a query that omits it fails to compile instead.
     */
    endedReason: string | null;
  } | null;
}

/**
 * One real session: the contiguous run of 30-minute slot rows that a single
 * booking was chunked into (#1061). `anchor` is the run's first row and is the
 * only row the video room may ever be keyed to.
 */
export interface SessionRun<T extends SessionSlotLike> {
  anchor: T;
  slots: T[];
  startsAt: Date;
  endsAt: Date;
}

const DEAD_COMPLETION_STATUSES = new Set(["CANCELLED", "RESCHEDULED"]);

/**
 * Non-live for run math / planner rewrites.
 *
 * `completionStatus` alone used to be enough, but A10 also soft-deletes via
 * `deletedAt`. A tombstoned row with a still-"SCHEDULED" status would otherwise
 * count as live: its users got re-attached on rewrite, and a `notIn` delete
 * could hard-delete the tombstone. Treat either signal as dead.
 */
export function isDeadSlot(slot: {
  completionStatus?: string | null;
  deletedAt?: Date | string | null;
}): boolean {
  if (slot.deletedAt) return true;
  return (
    !!slot.completionStatus &&
    DEAD_COMPLETION_STATUSES.has(slot.completionStatus)
  );
}

/**
 * Slot-derived half of "may this booking be rescheduled".
 *
 * The status, role and route checks genuinely differ per side and stay with
 * their adapter. These three do not, and they drifted: the consultant's menu
 * offered Reschedule on a booking with nothing allocated and on one already
 * awaiting a new time, both of which the API then rejects.
 */
export function slotsAllowReschedule(
  slots: Array<{
    isTentative?: boolean | null;
    completionStatus?: string | null;
  }>,
): boolean {
  // An APPROVED booking with nothing allocated ("Not scheduled · 0/0") has no
  // time to move, and the proposal window is derived from the earliest released
  // session — so this fails with PROPOSAL_WINDOW_CLOSED rather than opening an
  // empty picker.
  if (slots.length === 0) return false;
  // Tentative means the request is still awaiting allocation, not booked.
  if (slots[0]?.isTentative) return false;
  // A released slot awaiting a new time IS the open reschedule: at most one may
  // be live per appointment (the nullable-unique openForAppointmentId, claimed
  // by preference-only rows too — #1065), so offering the action again only
  // earns a 409.
  return !slots.some((slot) => slot.completionStatus === "RESCHEDULED");
}

/**
 * Whether Manage Timings may be offered at all — the menu item AND the page,
 * since that URL is linkable (#1082).
 *
 * Manage Timings writes new times straight onto the calendar: no notice
 * requirement, no acceptance from anyone. That is honest only while nobody
 * else has committed to a time, so the deciding question is whether a
 * counterparty already holds one — not who owns the calendar.
 *
 * The exact complement of `slotsAllowReschedule` for the surfaces that offer
 * both, so a consultant is never handed the unilateral surface and the
 * negotiated one for the same booking.
 */
export function allowsManageTimings(
  kind: AppointmentKind,
  slots: Array<{ isTentative?: boolean | null }>,
): boolean {
  // A webinar or class is a published schedule attendees buy into rather than
  // a time anyone negotiated, so the organiser keeps this surface even once
  // the instance is confirmed — there is no single counterparty to propose to,
  // and asking every attendee to accept is not a coherent flow.
  if (kind === "WEBINAR" || kind === "CLASS") return true;
  // Nothing placed: an offering that was never scheduled, or a booking whose
  // sessions are not allocated yet. Still the consultant's own calendar.
  if (slots.length === 0) return true;
  // EVERY upcoming slot, not just the earliest. A partial reschedule releases
  // one session of a multi-session booking and leaves the rest confirmed, so
  // the first slot chronologically can be the released one while a consultee
  // still holds a committed time later in the same booking. Reading only
  // `slots[0]` handed back the unilateral surface in exactly that case.
  return slots.every((slot) => Boolean(slot.isTentative));
}

/**
 * Whether Unschedule may be offered — pulling a placed group event off the
 * calendar and back into the allocate queue, without cancelling it (#1082).
 *
 * Orthogonal to the Timings/Reschedule pair rather than a third branch of it.
 * A confirmed webinar offers Timings AND this; a 1:1 never offers it, because
 * releasing a time a counterparty holds is the negotiation Reschedule already
 * runs. It is emphatically NOT Cancel: the booking stays sold, attendees stay
 * enrolled, and no money, earnings or ledger row moves.
 */
export function allowsUnschedule(
  kind: AppointmentKind,
  slots: Array<{ isTentative?: boolean | null }>,
): boolean {
  if (kind !== "WEBINAR" && kind !== "CLASS") return false;
  // Nothing placed yet — an offering that was never scheduled, or one already
  // unscheduled (the release leaves every slot tentative). No date to withdraw,
  // and Timings is the surface for setting one.
  return slots.some((slot) => !slot.isTentative);
}

/**
 * The slots a time-change decision acts on: still ahead of now, chronological.
 * A finished session is not what "has someone committed to a time" is asking
 * about, and the first entry has to be the earliest for the tentative test.
 */
export function upcomingSlots<
  T extends { startsAt: Date | string; endsAt: Date | string },
>(slots: T[], now: Date = new Date()): T[] {
  const cutoff = now.getTime();
  return slots
    .filter((slot) => toDate(slot.endsAt).getTime() >= cutoff)
    .sort(
      (a, b) => toDate(a.startsAt).getTime() - toDate(b.startsAt).getTime(),
    );
}

function slotTimes(slot: SessionSlotLike): { start: number; end: number } {
  const start = toDate(slot.startsAt).getTime();
  const endsAt = toDateOrNull(slot.endsAt ?? null);
  return {
    start,
    end: endsAt ? endsAt.getTime() : start + DEFAULT_MEETING_DURATION_MS,
  };
}

/**
 * Per-row join state. Retained as the primitive; every join surface goes
 * through the session-shaped helpers below, because a row is half an hour and
 * a session is not (#1061).
 */
export function getSlotJoinState(
  slot: SessionSlotLike,
  opts?: { joinWindowMs?: number; now?: Date },
): SlotJoinState {
  if (slot.isTentative) return "disabled";
  if (isDeadSlot(slot)) return "disabled";
  // Session manually ended early by the host.
  if (isDeliberateEnd(slot.meetingSession)) return "ended";

  const joinWindowMs = opts?.joinWindowMs ?? CONSULTEE_JOIN_WINDOW_MS;
  const now = (opts?.now ?? new Date()).getTime();
  const { start, end } = slotTimes(slot);

  if (now > end) return "ended";
  if (now >= start - joinWindowMs) return "joinable";
  return "countdown";
}

function buildRun<T extends SessionSlotLike>(slots: T[]): SessionRun<T> {
  const first = slots[0];
  const last = slots[slots.length - 1];
  return {
    anchor: first,
    slots,
    startsAt: new Date(slotTimes(first).start),
    endsAt: new Date(slotTimes(last).end),
  };
}

/**
 * Split slot rows into sessions — runs of back-to-back rows inside the same
 * appointment (#1061). A booking longer than 30 minutes is stored as N rows;
 * treating any one of them as the session is what let the two sides of a call
 * land in different Stream rooms.
 *
 * Cancelled/rescheduled rows are dropped: they can never be joined, and they
 * must not bridge two runs that are not actually contiguous. A change of
 * `isTentative` also breaks the run — an unallocated placeholder is not part
 * of the confirmed session sitting next to it.
 */
export function groupSlotsIntoRuns<T extends SessionSlotLike>(
  slots: T[],
): SessionRun<T>[] {
  const byAppointment = new Map<string, T[]>();
  for (const slot of slots) {
    if (isDeadSlot(slot)) continue;
    // A row with no appointment cannot be grouped with anything, so it is its
    // own session rather than being pooled with every other orphan.
    const key = slot.appointmentId ?? `slot:${slot.id}`;
    const bucket = byAppointment.get(key);
    if (bucket) bucket.push(slot);
    else byAppointment.set(key, [slot]);
  }

  const runs: SessionRun<T>[] = [];
  for (const bucket of byAppointment.values()) {
    const sorted = [...bucket].sort(
      (a, b) => slotTimes(a).start - slotTimes(b).start,
    );
    let current: T[] = [];
    for (const slot of sorted) {
      const prev = current[current.length - 1];
      const contiguous =
        !!prev &&
        slotTimes(prev).end === slotTimes(slot).start &&
        !!prev.isTentative === !!slot.isTentative;
      if (prev && !contiguous) {
        runs.push(buildRun(current));
        current = [];
      }
      current.push(slot);
    }
    if (current.length > 0) runs.push(buildRun(current));
  }

  return runs.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * Reasons a session is over FOR GOOD, as opposed to merely not currently live.
 *
 * #1270 — every gate used to read `endedAt` alone, and `endedAt` is written by
 * four different things. Stream fires `call.session_ended` after
 * `inactivity_timeout_seconds` (30s on the live call type) once the LAST
 * participant leaves, which stamps `session_timeout`. So both people in a 1:1
 * losing signal for half a minute — a wifi handoff, a tunnel, a closed lid —
 * ended their paid consultation permanently, for both of them, mid-session.
 * The reconciler's guesses (`reconciled_no_end`, `stream_not_found`) had the
 * same effect.
 *
 * A deliberate end is the host closing the room, or maintenance draining it.
 * Everything else means "nobody is in there right now", which is a very
 * different question from "you may not come back".
 */
const DELIBERATE_END_REASONS = new Set(["call_ended", "maintenance"]);

export function isDeliberateEnd(
  session?: {
    endedAt: Date | string | null;
    endedReason?: string | null;
  } | null,
): boolean {
  if (!session?.endedAt) return false;
  // A row with no reason predates the reason column; treat it as deliberate,
  // which is the conservative reading for historical data.
  return session.endedReason
    ? DELIBERATE_END_REASONS.has(session.endedReason)
    : true;
}

/** The run containing `slotId`, or null when the row is dead/absent. */
export function findSessionRun<T extends SessionSlotLike>(
  slots: T[],
  slotId: string,
): SessionRun<T> | null {
  return (
    groupSlotsIntoRuns(slots).find((run) =>
      run.slots.some((slot) => slot.id === slotId),
    ) ?? null
  );
}

/** Join state for a whole session, evaluated over `[firstStart, lastEnd]`. */
export function getSessionJoinState<T extends SessionSlotLike>(
  run: SessionRun<T>,
  opts?: { joinWindowMs?: number; now?: Date },
): SlotJoinState {
  if (run.anchor.isTentative) return "disabled";
  // #1061 — the host ends ONE call for the run, and only the row that carried
  // the MeetingSession learns about it. Which row that was must not decide
  // whether Join re-lights into a fresh empty room for the rest of the hour.
  if (run.slots.some((slot) => isDeliberateEnd(slot.meetingSession)))
    return "ended";

  const joinWindowMs = opts?.joinWindowMs ?? CONSULTEE_JOIN_WINDOW_MS;
  const now = (opts?.now ?? new Date()).getTime();

  if (now > run.endsAt.getTime()) return "ended";
  if (now >= run.startsAt.getTime() - joinWindowMs) return "joinable";
  return "countdown";
}

/** Earliest session currently inside its join window, or null. */
export function getJoinableSession<T extends SessionSlotLike>(
  slots: T[],
  opts?: { joinWindowMs?: number; now?: Date },
): SessionRun<T> | null {
  for (const run of groupSlotsIntoRuns(slots)) {
    if (getSessionJoinState(run, opts) === "joinable") return run;
  }
  return null;
}

/**
 * The session that is live or next up, else the most recent past one. Used by
 * surfaces that must render *a* session even outside the join window.
 */
export function getCurrentOrNextSession<T extends SessionSlotLike>(
  slots: T[],
  now: Date = new Date(),
): SessionRun<T> | null {
  const runs = groupSlotsIntoRuns(slots);
  if (runs.length === 0) return null;
  return (
    runs.find((run) => run.endsAt.getTime() >= now.getTime()) ??
    runs[runs.length - 1]
  );
}

/**
 * Anchor row of the earliest joinable session — the row the Stream call is
 * keyed to. Returns a row rather than the run because every caller feeds it
 * straight to `getOrCreateAppointmentMeeting` (#1061).
 */
export function getJoinableSlot<T extends SessionSlotLike>(
  slots: T[],
  opts?: { joinWindowMs?: number; now?: Date },
): T | null {
  return getJoinableSession(slots, opts)?.anchor ?? null;
}

/**
 * Join state for a mapper-emitted `SessionVM`.
 *
 * The mappers already collapse a booking's slot rows into runs (#1061), so one
 * `SessionVM` IS one session — this only re-shapes it into the structural form
 * the shared predicate reads. It exists because the timeline used to answer
 * "is this joinable?" from the clock alone and therefore could not see a call
 * the host had already ended (#1270).
 */
export function getSessionVMJoinState(
  session: SessionVM,
  opts?: { joinWindowMs?: number; now?: Date },
): SlotJoinState {
  const [run] = groupSlotsIntoRuns<SessionSlotLike>([
    {
      id: session.slotId,
      appointmentId: session.appointmentId,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      isTentative: session.isTentative,
      completionStatus: session.completionStatus,
      meetingSession: session.meetingEndedAt
        ? {
            id: session.slotId,
            endedAt: session.meetingEndedAt,
            endedReason: session.meetingEndedReason,
          }
        : null,
    },
  ]);
  // Cancelled and rescheduled rows never survive the grouping, so no run at
  // all is the same answer as a tentative one: there is nothing to join.
  if (!run) return "disabled";
  return getSessionJoinState(run, opts);
}

function sessionEnd(session: SessionVM): number {
  if (session.meetingEndedAt) return session.meetingEndedAt.getTime();
  return session.endsAt
    ? session.endsAt.getTime()
    : session.startsAt.getTime() + DEFAULT_MEETING_DURATION_MS;
}

/** Sessions that still count (not cancelled/rescheduled away). */
export function activeSessions(sessions: SessionVM[]): SessionVM[] {
  return sessions.filter((s) => !isDeadSlot(s));
}

export function isSessionOver(session: SessionVM, now = new Date()): boolean {
  return sessionEnd(session) < now.getTime();
}

/** True when the timeline has sessions and every active one is over. */
export function allSessionsOver(
  sessions: SessionVM[],
  now = new Date(),
): boolean {
  const active = activeSessions(sessions);
  if (sessions.length === 0) return false;
  if (active.length === 0) return true;
  return active.every((s) => isSessionOver(s, now));
}

/**
 * Day-group / sort anchor: the next active session that hasn't ended, else
 * the most recent active session (so past rows group under their real date).
 */
export function getAnchorTime(
  sessions: SessionVM[],
  now = new Date(),
): Date | null {
  const active = activeSessions(sessions);
  if (active.length === 0) return null;
  const upcoming = active.find((s) => !isSessionOver(s, now));
  return upcoming?.startsAt ?? active[active.length - 1]?.startsAt ?? null;
}

/**
 * Short human proximity label for an upcoming anchor ("in 45 min", "Today",
 * "Tomorrow", "in 5 days"). Returns null for past/absent anchors — rows show
 * the absolute time regardless; this is the urgency accent next to it.
 */
export function getProximityLabel(
  anchor: Date | null,
  now = new Date(),
): string | null {
  if (!anchor) return null;
  const diffMs = anchor.getTime() - now.getTime();
  if (diffMs <= 0) return null;

  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 60) return `in ${Math.max(diffMinutes, 1)} min`;

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Math.round, not floor: across a DST boundary a "day" between local
  // midnights is 23/25h and floor would undercount it.
  const dayDiff = Math.round(
    (new Date(
      anchor.getFullYear(),
      anchor.getMonth(),
      anchor.getDate(),
    ).getTime() -
      todayStart.getTime()) /
      86_400_000,
  );
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Tomorrow";
  if (dayDiff < 7) return `in ${dayDiff} days`;
  const weeks = Math.ceil(dayDiff / 7);
  return `in ${weeks} ${weeks === 1 ? "week" : "weeks"}`;
}
