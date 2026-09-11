/**
 * Shared API formatting utilities for schedule slots
 * Single source of truth for converting local slots to API format
 */

import {
  convertTimezoneToUtc,
  convertTimezoneToUtcWithOvernight,
  getLocalDateString,
  isOvernight,
  sortSlotsByTime,
} from "@/utils/dateTimeUtils";
import { dateToMinuteUtc } from "@/utils/slotAllocation/slotTimeUtils";
import { resolveOvernightStatus } from "@/utils/schedule/overnight";
import { isValidTimeRange } from "@/utils/timeSlotValidation";
import { DayOfWeek } from "@prisma/client";
import type { CustomSlot, SlotsType, WeeklySlot } from "./types";

/**
 * API format for weekly slots (dashboard → PUT /api/user/consultants/[id])
 */
export interface WeeklySlotApiFormat {
  dayOfWeekforStartTimeInUTC: string;
  dayOfWeekforEndTimeInUTC: string;
  startsAt: string;
  endsAt: string;
}

/**
 * API format for custom (date-specific) slots
 */
export interface CustomSlotApiFormat {
  startsAt: string;
  endsAt: string;
}

/**
 * Helper function to get the next day of the week
 */
const getNextDayOfWeek = (dayOfWeek: string): string => {
  const days = [
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ];
  const currentIndex = days.indexOf(dayOfWeek);
  return days[(currentIndex + 1) % days.length];
};

/**
 * Formats slots for API submission (dashboard save path).
 * Converts local times to UTC and handles overnight slot detection.
 * Overnight slots produce a single record with startDay !== endDay.
 *
 * THROWS on a formatting failure, deliberately. This used to carry three nested
 * catches that degraded instead: a per-slot one dropped the offending slot from
 * the payload, and an outer one returned `[]` for the whole schedule. The result
 * is a PUT body (SettingsTab.tsx), so degrading here does not mean "render less"
 * — it means SAVE less. A single throwing slot silently vanished from the
 * consultant's availability, and the outer catch wiped it entirely; SettingsTab
 * then refetched and displayed the wiped state as "what was actually saved". An
 * availability save has to be all-or-nothing, and the caller already has a
 * try/catch with a destructive toast to fail into. (#1125)
 *
 * @param slots - The slots to format (keyed by day or date)
 * @param isWeekly - Whether these are weekly recurring slots
 * @param timezone - The user's timezone (e.g., "America/New_York")
 * @returns Array of formatted slots ready for API submission
 */
export function formatSlotsForApi(
  slots: SlotsType,
  isWeekly: boolean,
  timezone: string = "UTC",
): (WeeklySlotApiFormat | CustomSlotApiFormat)[] {
  return Object.entries(slots)
    .filter(([key, daySlots]) => {
      // Ensure we have valid key and slots array
      return key && Array.isArray(daySlots) && daySlots.length > 0;
    })
    .flatMap(([key, daySlots]) => {
      // Sort slots chronologically before processing
      const sortedSlots = sortSlotsByTime(daySlots);

      const validSlots = sortedSlots.filter((slot) => {
        // Comprehensive slot validation
        return (
          slot &&
          typeof slot === "object" &&
          slot.isValid === true &&
          slot.startTime &&
          slot.endTime &&
          typeof slot.startTime === "string" &&
          typeof slot.endTime === "string" &&
          isValidTimeRange(slot.startTime, slot.endTime)
        );
      });

      if (isWeekly) {
        // flatMap because formatWeeklySlot returns an array
        return validSlots.flatMap((slot) =>
          formatWeeklySlot(slot, key, timezone),
        );
      }
      return validSlots.map((slot) => formatCustomSlot(slot, key, timezone));
    });
}

/**
 * Formats a single weekly slot for API submission.
 *
 * A thin adapter over `weeklySlotForSave`: the two save paths (this one, and
 * the onboarding server action) build exactly the same row and differ only in
 * the envelope they hand to their caller. `dayOfWeekforStartTimeInUTC` keeps
 * its historical name because the PUT body's Zod schema and the settings form
 * still speak it, but it carries `startDay` — the consultant's LOCAL day.
 */
function formatWeeklySlot(
  slot: { startTime: string; endTime: string; isOvernightUTC?: boolean },
  dayKey: string,
  timezone: string,
): WeeklySlotApiFormat[] {
  const row = weeklySlotForSave(slot, dayKey, timezone);
  return [
    {
      dayOfWeekforStartTimeInUTC: row.startDay,
      dayOfWeekforEndTimeInUTC: row.endDay,
      startsAt: row.startsAtUtc,
      endsAt: row.endsAtUtc,
    },
  ];
}

/**
 * Formats a single custom (date-specific) slot for API submission.
 * Overnight handling delegates to convertTimezoneToUtcWithOvernight.
 */
function formatCustomSlot(
  slot: { startTime: string; endTime: string },
  dateKey: string,
  timezone: string,
): CustomSlotApiFormat {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateKey)) {
    throw new Error(`Invalid date format: ${dateKey}`);
  }

  const startTimeUtc = convertTimezoneToUtcWithOvernight(
    slot.startTime,
    dateKey,
    timezone,
    false, // isEndTime
  );

  const endTimeUtc = convertTimezoneToUtcWithOvernight(
    slot.endTime,
    dateKey,
    timezone,
    true, // isEndTime
    slot.startTime, // startTimeStr for overnight detection
  );

  // Throws rather than returning null, which the caller then filtered away.
  // `convertTimezoneToUtcWithOvernight` returns "" for both an unparseable time
  // and a caught conversion error, so a null here was indistinguishable from
  // "this slot is fine but omitted" — and it was omitted from a SAVE payload.
  // Dropping a boundary the consultant typed is not a degradation we get to
  // make on their behalf. (#1125)
  if (!startTimeUtc || !endTimeUtc) {
    throw new Error(
      `Could not convert slot ${slot.startTime}-${slot.endTime} on ${dateKey} to UTC in ${timezone}`,
    );
  }

  return {
    startsAt: startTimeUtc,
    endsAt: endTimeUtc,
  };
}

/** A save-ready weekly row, plus the UTC instants the PUT body speaks in. */
export type WeeklySlotForSave = WeeklySlot & {
  startsAtUtc: string;
  endsAtUtc: string;
};

/**
 * Builds the one canonical weekly row from a local HH:MM slot and the day key
 * the consultant typed it under.
 *
 * #1343 — there were two builders and they disagreed about what `startDay`
 * means. This one shifted the day forward or back by the UTC day the converted
 * instant landed on, storing the UTC day; `buildWeeklySlotsForSave` stored the
 * local day; the validator, the allocator and the settings loader all read the
 * local day. For a consultant in IST every row starting before 05:30 local
 * therefore walked back one weekday on every save — Monday 01:00 was saved as
 * Sunday, reloaded into Sunday's form row, and saved again as Saturday. The
 * day key IS the day the consultant meant, so it is stored verbatim and the
 * UTC weekday is derived per occurrence from the row's frozen offset
 * (`utils/schedule/weekly-projection.ts`).
 *
 * `endDay` still records whether the row crosses midnight IN UTC, because that
 * is what `validateWeeklySlotTimeOrder` and the overlap SQL require of the
 * stored pair: an IST 23:00→02:00 slot is same-day in UTC (17:30→20:30) and is
 * stored as one same-day row.
 *
 * THROWS on a conversion failure rather than dropping the slot — see
 * `formatSlotsForApi`'s contract note (#1125); both save paths feed a payload,
 * so degrading here means saving less than the consultant typed.
 */
export function weeklySlotForSave(
  slot: { startTime: string; endTime: string; isOvernightUTC?: boolean },
  dayKey: string,
  timezone: string,
): WeeklySlotForSave {
  const dayOfWeek = dayKey.toUpperCase();
  const validDays: string[] = Object.values(DayOfWeek);
  if (!validDays.includes(dayOfWeek)) {
    throw new Error(`Invalid day of week: ${dayOfWeek}`);
  }
  const startDay = dayOfWeek as DayOfWeek;

  const baseDate = "1970-01-01";
  const nextDate = "1970-01-02";
  // #503 item 2 — canonical resolver replaces the inline OR of two rules.
  const { isOvernight: overnight } = resolveOvernightStatus({
    startTime: slot.startTime,
    endTime: slot.endTime,
    isOvernightUTC: slot.isOvernightUTC,
  });

  // convertTimezoneToUtc returns "" for both an unparseable time and a caught
  // conversion error (an unusable timezone reaches it that way), so an empty
  // string can never be distinguished from a slot legitimately omitted. (#1125)
  const startsAtUtc = convertTimezoneToUtc(slot.startTime, baseDate, timezone);
  if (!startsAtUtc) {
    throw new Error(
      `Could not convert weekly slot start ${slot.startTime} on ${dayOfWeek} to UTC in ${timezone}`,
    );
  }

  const endsAtUtc = convertTimezoneToUtc(
    slot.endTime,
    overnight ? nextDate : baseDate,
    timezone,
  );
  if (!endsAtUtc) {
    throw new Error(
      `Could not convert weekly slot end ${slot.endTime} on ${dayOfWeek} to UTC in ${timezone}`,
    );
  }

  // UTC minutes are correct regardless of which epoch date carried them.
  const startTimeUtc = dateToMinuteUtc(new Date(startsAtUtc));
  const endTimeUtc = dateToMinuteUtc(new Date(endsAtUtc));

  const crossesMidnightUtc = resolveOvernightStatus({
    startTimeUtc,
    endTimeUtc,
  }).isOvernight;

  return {
    startDay,
    endDay: crossesMidnightUtc
      ? (getNextDayOfWeek(startDay) as DayOfWeek)
      : startDay,
    startTimeUtc,
    endTimeUtc,
    startsAtUtc,
    endsAtUtc,
  };
}

/**
 * Converts a SlotsType map (local HH:MM) into WeeklySlot records (UTC minutes, 0–1439)
 * ready for the onboarding server action.
 *
 * Overnight slots produce a single record with startDay !== endDay.
 */
export function buildWeeklySlotsForSave(
  slots: SlotsType,
  timezone: string,
): WeeklySlot[] {
  return Object.entries(slots).flatMap(([day, daySlots]) =>
    sortSlotsByTime(daySlots)
      .filter((s) => s.startTime && s.endTime && s.isValid)
      .map((slot) => {
        const { startDay, endDay, startTimeUtc, endTimeUtc } =
          weeklySlotForSave(slot, day, timezone);
        return { startDay, endDay, startTimeUtc, endTimeUtc };
      }),
  );
}

/**
 * Converts a SlotsType map (local HH:MM, keyed by YYYY-MM-DD) into CustomSlot
 * records (ISO strings) ready for the onboarding server action.
 *
 * Overnight slots produce a single record where endsAt is on the next calendar day.
 */
export function buildCustomSlotsForSave(
  slots: SlotsType,
  timezone: string,
): CustomSlot[] {
  return Object.entries(slots).flatMap(([dateString, daySlots]) => {
    const nextDateObj = new Date(dateString);
    nextDateObj.setDate(nextDateObj.getDate() + 1);
    const nextDateStr = getLocalDateString(nextDateObj);

    return sortSlotsByTime(daySlots)
      .filter((s) => s.startTime && s.endTime && s.isValid)
      .flatMap((slot): CustomSlot[] => {
        const overnight = isOvernight(slot.startTime, slot.endTime);
        const startUTC = convertTimezoneToUtc(
          slot.startTime,
          dateString,
          timezone,
        );
        const endUTC = convertTimezoneToUtc(
          slot.endTime,
          overnight ? nextDateStr : dateString,
          timezone,
        );
        if (!startUTC || !endUTC) return [];

        // Both overnight and same-day: single record
        return [{ startsAt: startUTC, endsAt: endUTC }];
      });
  });
}
