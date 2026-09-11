import type { DayOfWeek } from "@prisma/client";
import { resolveOvernightStatus } from "@/utils/schedule/overnight";

/**
 * Projecting a weekly availability row onto real dates (#1342, #1343).
 *
 * `SlotOfAvailabilityWeekly.startDay` is the day the CONSULTANT published, in
 * their own local calendar; `startTimeUtc`/`endTimeUtc` are minutes since
 * midnight UTC and `utcOffsetMinutes` is the offset frozen at write time. The
 * UTC weekday a row lands on is therefore derived, never stored and never
 * taken from whoever happens to be looking: an IST Monday 01:00 row is a UTC
 * Sunday 19:30 instant, and a New York viewer looking at the same row must see
 * the same instant. That derivation existed in three copies (the validator and
 * two allocator helpers) and was missing entirely from the grid, which matched
 * on the VIEWER's weekday instead — the grid then painted the row a day away
 * from where checkout would accept it.
 *
 * Same posture as `utils/schedule/overnight.ts`: type-only Prisma import, no
 * Sentry, no prisma, no date-fns, so the client bundle, jsdom tests and the
 * allocator can all share one generator.
 */

/** DayOfWeek to JS `getUTCDay()` index. */
export const DAY_INDEX: Record<DayOfWeek, number> = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

/** DayOfWeek values in `getUTCDay()` order. */
export const DAY_BY_INDEX: DayOfWeek[] = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
];

const MINUTES_PER_DAY = 1440;
const MS_PER_MINUTE = 60_000;

export interface WeeklyRowTimes {
  /** The consultant's LOCAL day (#1343). */
  startDay: DayOfWeek;
  /**
   * Optional: whether a row crosses midnight is decided by the minutes below,
   * because `validateWeeklySlotTimeOrder` only lets a row store
   * `startDay !== endDay` together with `startTimeUtc > endTimeUtc`. Callers
   * that hold only the start day (the validator) can omit it.
   */
  endDay?: DayOfWeek;
  startTimeUtc: number;
  endTimeUtc: number;
  utcOffsetMinutes?: number | null;
}

/** JS day index for a DayOfWeek string, or -1 when it is not one. */
export function dayIndexOf(day: string): number {
  const index = (DAY_INDEX as Record<string, number | undefined>)[day];
  return index === undefined ? -1 : index;
}

/**
 * The UTC weekday the row's start instant falls on, derived from the local day
 * through the row's own frozen offset:
 * `utcDay = (localDay − floor((startTimeUtc + offset) / 1440)) mod 7`.
 * Returns -1 for an unrecognised day so callers can drop the row.
 */
export function utcStartDayIndex(
  row: Pick<WeeklyRowTimes, "startDay" | "startTimeUtc" | "utcOffsetMinutes">,
): number {
  const localDay = dayIndexOf(row.startDay);
  if (localDay === -1) return -1;
  const localStartMinutes = row.startTimeUtc + (row.utcOffsetMinutes ?? 0);
  const dayAdjust = Math.floor(localStartMinutes / MINUTES_PER_DAY);
  return (((localDay - dayAdjust) % 7) + 7) % 7;
}

/**
 * How long the row runs, in minutes. Overnight is read off the UTC minutes
 * rather than the day pair so this agrees with `isMinuteWithinWeeklySlot`,
 * which is the rule checkout enforces: a legacy row whose day pair and minutes
 * disagree would otherwise be generated at one length and validated at
 * another (#1342).
 */
export function weeklyRowDurationMinutes(
  row: Pick<WeeklyRowTimes, "startTimeUtc" | "endTimeUtc">,
): number {
  const { isOvernight } = resolveOvernightStatus({
    startTimeUtc: row.startTimeUtc,
    endTimeUtc: row.endTimeUtc,
  });
  return isOvernight
    ? MINUTES_PER_DAY - row.startTimeUtc + row.endTimeUtc
    : row.endTimeUtc - row.startTimeUtc;
}

/**
 * Every occurrence of the row inside `[rangeStartUtc, rangeEndUtc)`, as
 * half-open UTC instants. This is the one generator every surface shares — the
 * grid, the allocator's next-occurrence and day-match helpers, and the pin that
 * asserts the grid and the validator agree.
 *
 * The walk starts one UTC day before the range so an overnight occurrence that
 * began before it keeps its tail, and each candidate is kept only when it
 * actually overlaps the range.
 */
export function weeklyRowOccurrencesInRange(
  row: WeeklyRowTimes,
  rangeStartUtc: Date,
  rangeEndUtc: Date,
): { start: Date; end: Date }[] {
  const occurrences: { start: Date; end: Date }[] = [];
  if (
    !rangeStartUtc ||
    !rangeEndUtc ||
    isNaN(rangeStartUtc.getTime()) ||
    isNaN(rangeEndUtc.getTime()) ||
    rangeEndUtc.getTime() <= rangeStartUtc.getTime()
  ) {
    return occurrences;
  }

  const targetDay = utcStartDayIndex(row);
  if (targetDay === -1) return occurrences;

  const durationMinutes = weeklyRowDurationMinutes(row);
  if (durationMinutes <= 0) return occurrences;

  const cursor = new Date(
    Date.UTC(
      rangeStartUtc.getUTCFullYear(),
      rangeStartUtc.getUTCMonth(),
      rangeStartUtc.getUTCDate(),
    ),
  );
  cursor.setUTCDate(cursor.getUTCDate() - 1);

  while (cursor.getTime() < rangeEndUtc.getTime()) {
    if (cursor.getUTCDay() === targetDay) {
      const start = new Date(
        cursor.getTime() + row.startTimeUtc * MS_PER_MINUTE,
      );
      const end = new Date(start.getTime() + durationMinutes * MS_PER_MINUTE);
      if (
        end.getTime() > rangeStartUtc.getTime() &&
        start.getTime() < rangeEndUtc.getTime()
      ) {
        occurrences.push({ start, end });
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return occurrences;
}

export interface WeeklyRowLocalColumns {
  timezone: string;
  localStartMinutes: number;
  localEndMinutes: number;
  localStartDay: DayOfWeek;
  localEndDay: DayOfWeek;
}

/**
 * The five DST columns (`timezone`, `localStartMinutes`, `localEndMinutes`,
 * `localStartDay`, `localEndDay`) for a row that is about to be written.
 *
 * #872 — these are dual-written from 2026-09-05 and read by nothing until the
 * reader flip, so every write path computes them here rather than inline.
 * `localEndDay` is derived from the local minutes instead of copied from the
 * stored `endDay`: `endDay` records whether the row crosses midnight in UTC,
 * which is a different question — an IST 22:00–02:00 row is same-day in UTC
 * and cross-day locally.
 */
export function weeklyRowLocalColumns(
  row: WeeklyRowTimes,
  timezone: string,
  utcOffsetMinutes: number,
): WeeklyRowLocalColumns {
  const toLocal = (minuteUtc: number) =>
    (((minuteUtc + utcOffsetMinutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) %
    MINUTES_PER_DAY;
  const localStartMinutes = toLocal(row.startTimeUtc);
  const localEndMinutes = toLocal(row.endTimeUtc);
  const localStartDayIndex = dayIndexOf(row.startDay);
  const crossesLocalMidnight = localEndMinutes <= localStartMinutes;
  const localEndDayIndex =
    localStartDayIndex === -1
      ? -1
      : crossesLocalMidnight
        ? (localStartDayIndex + 1) % 7
        : localStartDayIndex;

  return {
    timezone,
    localStartMinutes,
    localEndMinutes,
    localStartDay: row.startDay,
    localEndDay: DAY_BY_INDEX[localEndDayIndex] ?? row.startDay,
  };
}
