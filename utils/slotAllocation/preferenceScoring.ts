/**
 * Allocation preferences — scoring, never filtering (#1065).
 *
 * A consultee who releases a session without naming a time may still say how
 * they would like the replacement placed. The rule that makes that safe is the
 * whole point of this module:
 *
 *   **A preference orders candidates. It never removes one.**
 *
 * The dead client-side allocator this replaces got it backwards. It filtered:
 * `if (preferences.preferMorning && (hour < 9 || hour >= 12)) return false`.
 * Prefer-mornings against a consultant who only works afternoons therefore
 * answered "no slots available" with the whole afternoon free — the same shape
 * as the A1 defect where the search tested one candidate start per availability
 * row. The worst outcome of an unsatisfiable preference has to be a less-liked
 * time, never a failed allocation, so nothing here returns a boolean the caller
 * could use to drop a candidate.
 *
 * Bands are read in the event's scheduling timezone (ADR B9), not server-local
 * and not raw UTC: "morning" means the customer's morning.
 */

import type {
  ReschedulePreferredDays,
  ReschedulePreferredTimeOfDay,
} from "@prisma/client";

import { SlotCalculationService } from "./SlotCalculationService";

/**
 * What the initiator asked for. Both halves are independent and optional, so
 * "weekday mornings", "mornings", "weekends" and "no preference at all" are all
 * expressible without a combinatorial enum.
 */
export interface AllocationPreference {
  preferredTimeOfDay?: ReschedulePreferredTimeOfDay | null;
  preferredDays?: ReschedulePreferredDays | null;
}

/**
 * What one satisfied preference is worth.
 *
 * Both halves weigh the same, so a candidate's score is essentially how many of
 * the stated preferences it satisfies. Ranking one above the other would decide
 * on the customer's behalf whether "Saturday morning" beats "Tuesday morning"
 * for someone who asked for weekday mornings; an equal weight leaves that tie
 * to the existing chronological order, which prefers the sooner session.
 */
const FULL_MATCH = 2;

/**
 * What the late-night tail of EVENING is worth: something, but never as much as
 * a real evening.
 *
 * The bands have to be TOTAL — every hour must score, or an hour nobody claimed
 * becomes unreachable in the preferred sweep. But totality put 00:00-04:59 in
 * EVENING at full marks, and since ties break chronologically that handed a
 * consultee who asked for evenings a 2 AM session ahead of a 7 PM one. Scoring
 * the tail strictly below the core keeps the band total while making late night
 * the answer only when nothing else is available.
 */
const PARTIAL_MATCH = 1;

/**
 * Half-open hour bands, contiguous and covering the clock, so every candidate
 * falls in exactly one and no time is left unscoreable.
 */
const TIME_OF_DAY_SCORE: Record<
  ReschedulePreferredTimeOfDay,
  (hour: number) => number
> = {
  MORNING: (hour) => (hour >= 5 && hour < 12 ? FULL_MATCH : 0),
  AFTERNOON: (hour) => (hour >= 12 && hour < 17 ? FULL_MATCH : 0),
  // 17:00-23:59 is what anyone means by "evenings"; 00:00-04:59 is the tail
  // that keeps the band total without being what was asked for.
  EVENING: (hour) =>
    hour >= 17 ? FULL_MATCH : hour < 5 ? PARTIAL_MATCH : 0,
};

const WEEKEND_DAYS = new Set([0, 6]);

/** True when the preference expresses nothing — absent or all-null. */
export function isEmptyPreference(
  preference?: AllocationPreference | null,
): boolean {
  return !preference?.preferredTimeOfDay && !preference?.preferredDays;
}

/**
 * The score a candidate satisfying every stated preference would earn.
 *
 * Zero when nothing was asked for, which is what lets the callers keep their
 * original first-fit behaviour verbatim: every candidate already scores the
 * maximum, so the first placeable one wins and the search returns exactly where
 * it did before this existed.
 */
export function maxPreferenceScore(
  preference?: AllocationPreference | null,
): number {
  let max = 0;
  if (preference?.preferredTimeOfDay) max += FULL_MATCH;
  if (preference?.preferredDays) max += FULL_MATCH;
  return max;
}

/** Whether a weekday index (0 = Sunday) falls in the preferred part of the week. */
function weekdayMatches(
  weekday: number,
  preferredDays: ReschedulePreferredDays,
): boolean {
  const isWeekend = WEEKEND_DAYS.has(weekday);
  return preferredDays === "WEEKENDS" ? isWeekend : !isWeekend;
}

/**
 * Whether an instant falls in the preferred part of the week — true when no day
 * preference was stated, so callers can use it as a cheap "could this day ever
 * be a full match?" test without special-casing the empty preference.
 */
export function matchesPreferredDays(
  start: Date,
  preference: AllocationPreference | null | undefined,
  timeZone?: string,
): boolean {
  if (!preference?.preferredDays) return true;
  return weekdayMatches(
    SlotCalculationService.weekdayInTz(start, timeZone),
    preference.preferredDays,
  );
}

/**
 * How well a candidate start matches, from 0 to `maxPreferenceScore`.
 *
 * Higher is better and nothing is ever disqualified — a zero-scoring candidate
 * is still a perfectly allocatable one, just not the one anybody asked for.
 */
export function scoreCandidateStart(
  start: Date,
  preference: AllocationPreference | null | undefined,
  timeZone?: string,
): number {
  if (isEmptyPreference(preference)) return 0;

  // One Intl round-trip for both axes; this runs per candidate, per row, under
  // the allocation lock.
  const { hour, weekday } = SlotCalculationService.zonedClock(start, timeZone);

  let score = 0;

  const band = preference?.preferredTimeOfDay;
  if (band) score += TIME_OF_DAY_SCORE[band](hour);

  const days = preference?.preferredDays;
  if (days && weekdayMatches(weekday, days)) score += FULL_MATCH;

  return score;
}
