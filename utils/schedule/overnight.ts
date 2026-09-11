import type { DayOfWeek } from "@prisma/client";

/**
 * Canonical overnight-slot resolution (#503 item 2).
 *
 * Overnight status used to be computed four different ways (local HH:mm
 * comparison, UTC-minutes comparison, day-pair comparison, and the
 * isOvernightUTC flag) across formatting, validation, and overlap code —
 * an easy source of double-counted or missed midnight crossings. This
 * module is the single source of the rule; everything else delegates.
 *
 * Edge semantics, preserved from the call sites being unified:
 * - UTC-minutes shape: end <= start is overnight (a 24h slot is a full-day
 *   wrap, and end 00:00 stores as 0).
 * - Local HH:mm shape: end < start is overnight (a zero-length slot is
 *   invalid input, not a 24h slot — isValidTimeRange rejects it upstream).
 * - Day-pair shape: startDay !== endDay is overnight; legality of the pair
 *   (end must be the NEXT day) stays with validateWeeklySlotTimeOrder.
 */

// Type-only Prisma import keeps this module dependency-light (same idiom as
// lib/enterprise/transitions.ts) — Jest/jsdom must not drag in the client.
const DAY_ORDER: DayOfWeek[] = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
];

/** Check if endDay is the next day of the week after startDay. */
export function isNextDayOfWeek(
  startDay: DayOfWeek,
  endDay: DayOfWeek,
): boolean {
  const startIdx = DAY_ORDER.indexOf(startDay);
  const endIdx = DAY_ORDER.indexOf(endDay);
  if (startIdx === -1 || endIdx === -1) return false;
  return (startIdx + 1) % 7 === endIdx;
}

/** Local "HH:mm" pair crosses midnight (strict — zero-length is not overnight). */
export function localTimesCrossMidnight(
  startTime: string,
  endTime: string,
): boolean {
  if (!startTime || !endTime) return false;
  const [startHour, startMinute] = startTime.split(":").map(Number);
  const [endHour, endMinute] = endTime.split(":").map(Number);
  if (
    isNaN(startHour) ||
    isNaN(startMinute) ||
    isNaN(endHour) ||
    isNaN(endMinute)
  ) {
    return false;
  }
  return endHour * 60 + endMinute < startHour * 60 + startMinute;
}

export interface OvernightStatus {
  /** The slot crosses midnight in its own (authoritative) frame. */
  isOvernight: boolean;
  /** The slot is known to cross midnight specifically in UTC. */
  crossesMidnightUtc: boolean;
}

type DbWeeklyShape = { startDay: DayOfWeek; endDay: DayOfWeek };
type UtcMinutesShape = { startTimeUtc: number; endTimeUtc: number };
type LocalUiShape = {
  startTime: string;
  endTime: string;
  isOvernightUTC?: boolean;
};

export function resolveOvernightStatus(
  slot: DbWeeklyShape | UtcMinutesShape | LocalUiShape,
): OvernightStatus {
  if ("startDay" in slot) {
    const crosses = slot.startDay !== slot.endDay;
    return { isOvernight: crosses, crossesMidnightUtc: crosses };
  }
  if ("startTimeUtc" in slot) {
    const crosses = slot.endTimeUtc <= slot.startTimeUtc;
    return { isOvernight: crosses, crossesMidnightUtc: crosses };
  }
  // Local UI shape: overnight if the local times wrap OR the slot was
  // overnight in UTC but appears same-day after timezone conversion.
  const localCross = localTimesCrossMidnight(slot.startTime, slot.endTime);
  return {
    isOvernight: localCross || !!slot.isOvernightUTC,
    crossesMidnightUtc: !!slot.isOvernightUTC,
  };
}
