/**
 * One shared reading of "who was actually in the session" (#1504).
 *
 * Two hourly jobs decide the fate of a past consultation, and they used to
 * decide it from different facts. `auto-complete-appointments` (:07, one-hour
 * buffer) looked only at the clock and moved every APPROVED/SCHEDULED booking
 * to COMPLETED; `detect-consultant-no-shows` (:57, two-hour grace) looked at
 * the `MeetingAttendance` rows and is the only path that cancels and refunds a
 * consultant who never joined. Because the completing job's window opens an
 * hour earlier and both read the same two statuses, the completing job always
 * claimed the booking first and the refund became unreachable in production.
 *
 * The fix is that both jobs now ask this module the same question, so the
 * candidate set is partitioned rather than raced: a booking the consultant
 * attended belongs to auto-complete, and a booking in the no-show shape belongs
 * to the detector until the handoff deadline below.
 *
 * The evidence is the per-attendee `MeetingAttendance` rows that
 * `lib/stream/session-handlers.ts` stamps from Stream's participant webhooks.
 * A row is only ever written on a join, so an absent row is the claim "this
 * person never arrived" — a claim the detector separately corroborates against
 * Stream's own call report before it moves any money.
 */

/**
 * How long after the last slot ends a missing consultant is still allowed to be
 * a late join or a delayed webhook rather than a no-show. Deliberately generous
 * because the detector's remedy is an automatic refund, and money is hard to
 * put back.
 */
export const NO_SHOW_GRACE_MINUTES = 120;

/**
 * When auto-complete stops waiting for the detector and completes an unattended
 * booking anyway.
 *
 * The detector declines candidates it cannot decide — Stream contradicts our
 * attendance rows, the booking has no Stream call to ask about, or the run
 * simply errored — and it leaves those bookings APPROVED. Without a deadline
 * those rows would be claimed by neither job and would sit live forever, which
 * is a worse failure than completing them. Two hours past the grace window
 * gives the hourly detector at least one and normally two full runs in which
 * the booking was visible to it, so by the time this expires the detector has
 * either cancelled the booking or decided not to.
 */
export const NO_SHOW_HANDOFF_MINUTES = NO_SHOW_GRACE_MINUTES + 120;

/** The subset of a `MeetingSession` this module needs: who joined it. */
export interface AttendedSession {
  attendances: { userId: string }[];
}

/** The subset of a `SlotOfAppointment` this module needs: its session, if any. */
export interface SlotWithSession<S extends AttendedSession = AttendedSession> {
  meetingSession: S | null;
}

/** The two parties whose presence decides a consultation's outcome. */
export interface SessionParties {
  consultantUserId: string;
  consulteeUserId: string;
}

/**
 * What the attendance rows say about a past consultation.
 *
 * - `consultant-attended`: the consultant has a join on at least one session,
 *   so the booking was delivered and auto-complete owns it.
 * - `consultant-absent`: the consultee joined and the consultant did not — the
 *   refundable no-show shape, which the detector owns.
 * - `inconclusive`: no session rows at all (an offline session, or a call that
 *   was never created), or the consultee has no join either (nobody turned up,
 *   which the detector raises as a support ticket instead of deciding). Neither
 *   is a consultant-fault refund, so auto-complete owns these as before.
 */
export type AttendanceVerdict =
  | "consultant-attended"
  | "consultant-absent"
  | "inconclusive";

/** Every session that actually happened on a booking's slots. */
export function meetingSessionsOf<S extends AttendedSession>(
  slots: readonly SlotWithSession<S>[],
): S[] {
  return slots
    .map((slot) => slot.meetingSession)
    .filter((session): session is S => !!session);
}

/** Did this user join any of these sessions? */
export function attendedAnySession(
  sessions: readonly AttendedSession[],
  userId: string,
): boolean {
  return sessions.some((session) =>
    session.attendances.some((a) => a.userId === userId),
  );
}

/**
 * The single predicate both hourly jobs read. Callers must not re-derive it:
 * the whole defect in #1504 was two jobs holding different opinions about the
 * same booking.
 */
export function classifyConsultantAttendance(
  slots: readonly SlotWithSession[],
  parties: SessionParties,
): AttendanceVerdict {
  const sessions = meetingSessionsOf(slots);
  if (sessions.length === 0) return "inconclusive";
  if (attendedAnySession(sessions, parties.consultantUserId)) {
    return "consultant-attended";
  }
  // Positive evidence that the consultee showed up is required: a session
  // nobody joined is a technical failure to be triaged, not a consultant's
  // fault, and the platform only promises a refund for the latter.
  return attendedAnySession(sessions, parties.consulteeUserId)
    ? "consultant-absent"
    : "inconclusive";
}

/**
 * Has the detector had its chance at this booking?
 *
 * `true` means auto-complete may complete it even in the no-show shape, because
 * the detector has been able to see it for long enough that its silence is a
 * decision rather than a schedule.
 */
export function isPastNoShowHandoff(
  lastSlotEndsAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  // A booking whose slot end we cannot read cannot be held back on a deadline
  // we cannot compute; treat it as past the handoff so it can never strand.
  if (!lastSlotEndsAt) return true;
  return (
    now.getTime() - lastSlotEndsAt.getTime() >=
    NO_SHOW_HANDOFF_MINUTES * 60 * 1000
  );
}
