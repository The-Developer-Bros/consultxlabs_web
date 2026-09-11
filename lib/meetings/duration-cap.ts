/**
 * How long Stream should let a call run before ending it server-side.
 *
 * A pure policy calculation, in its own module rather than inside the
 * `"use server"` action that uses it — so it can be tested without dragging
 * Prisma and the Stream client into the test process, and so the reasoning
 * below has one home.
 */
import { CONSULTANT_JOIN_WINDOW_MS } from "@/lib/appointments/slots";

/**
 * Grace added on top of the booked run before Stream's own duration cap fires.
 *
 * Matches `REJOIN_GRACE_MS` in `lib/meetings/access.ts`. The server already
 * admits a rejoin for thirty minutes past the scheduled end, and a hard cap
 * that expired inside that window would refuse the reconnection the join gate
 * had just authorised.
 */
const CALL_DURATION_GRACE_MS = 30 * 60 * 1000;

/**
 * Floor and ceiling on the computed cap.
 *
 * The floor exists because the cap is derived from data that can be missing or
 * wrong — a null call profile, a zero-length slot — and a cap that is too SHORT
 * ends a paid session early, which is the failure mode #1160 warns about. The
 * ceiling exists because a corrupt booking should not be able to disable the
 * bill bound entirely; twelve hours is far past any real consultation and still
 * finite.
 */
const MIN_CALL_DURATION_MS = 2 * 60 * 60 * 1000;
const MAX_CALL_DURATION_MS = 12 * 60 * 60 * 1000;

/**
 * How long Stream should let a session run before ending it server-side, or
 * `null` when we cannot answer safely.
 *
 * Generous by construction. The timer counts from FIRST JOIN, not from
 * `starts_at`, so every minute someone can legitimately be in the room early
 * has to be inside the budget or the cap eats the end of a paid session.
 *
 * booked run  +  earliest legitimate arrival  +  overrun grace
 *
 * The middle term is `CONSULTANT_JOIN_WINDOW_MS`, the wider of the two windows
 * — the consultant can arrive 15 minutes before the consultee. The last term
 * matches the server's own `REJOIN_GRACE_MS`, so the cap cannot expire while
 * `lib/meetings/access.ts` still considers a rejoin valid; a timer that fired
 * inside the window the join gate is still honouring would be the worst of both.
 *
 * ## No profile means NO CAP, not a guessed one
 *
 * An earlier revision fell back to `DEFAULT_MEETING_DURATION_MS` when the call
 * profile could not be resolved, and then floored the result at two hours. That
 * reintroduced the exact failure this feature exists to prevent. A four-hour
 * webinar whose profile read failed — a DB blip, or the consent refusal that
 * now also returns `null` — would have been sent a two-hour cap and terminated
 * by the SFU two hours before its booked end, mid-session, for everyone.
 *
 * The floor was written to stop a mis-derived run producing a cap that is too
 * short. It cannot do that job for a run we never derived at all: 60 minutes is
 * not a conservative estimate of an unknown booking, it is a guess that is
 * wrong in the dangerous direction for every booking longer than it.
 *
 * So an unresolved profile returns `null` and the caller omits
 * `max_duration_seconds` entirely — which is precisely the behaviour before
 * this feature existed, since the call type carries no limit of its own. Losing
 * a billing backstop on a session we could not describe is a far better trade
 * than ending a real one early.
 */
export function resolveMaxCallDurationSeconds(
  callProfile: { endsAt: Date } | null,
  startsAt: Date,
): number | null {
  if (!callProfile) return null;

  const bookedMs = Math.max(
    callProfile.endsAt.getTime() - startsAt.getTime(),
    0,
  );

  const budgetMs =
    bookedMs + CONSULTANT_JOIN_WINDOW_MS + CALL_DURATION_GRACE_MS;

  const clamped = Math.min(
    Math.max(budgetMs, MIN_CALL_DURATION_MS),
    MAX_CALL_DURATION_MS,
  );
  // Ceil, not floor. Flooring loses up to a second whenever either `Date`
  // carries milliseconds, and the whole design of this number is that it errs
  // long. A second is immaterial; the direction is the point.
  return Math.ceil(clamped / 1000);
}
