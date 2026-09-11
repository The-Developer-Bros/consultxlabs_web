import { DayOfWeek } from "@prisma/client";
import { addDays, isBefore, startOfDay } from "date-fns";
import { toZonedTime, fromZonedTime } from "date-fns-tz";
import { TSlotTiming } from "@/types/slots";
import { weeklyRowOccurrencesInRange } from "@/utils/schedule/weekly-projection";

// Booking status constants and types
export const BOOKING_STATUS = {
  AVAILABLE: "available",
  PARTIALLY_BOOKED: "partially-booked",
  FULLY_BOOKED: "fully-booked",
} as const;

export type BookingStatus =
  (typeof BOOKING_STATUS)[keyof typeof BOOKING_STATUS];

// Booking threshold constant
export const FULLY_BOOKED_THRESHOLD = 0.99;

// Helper mappings
export const dayMap: Record<number, DayOfWeek> = {
  0: DayOfWeek.SUNDAY,
  1: DayOfWeek.MONDAY,
  2: DayOfWeek.TUESDAY,
  3: DayOfWeek.WEDNESDAY,
  4: DayOfWeek.THURSDAY,
  5: DayOfWeek.FRIDAY,
  6: DayOfWeek.SATURDAY,
};

export const dayToNumber: Record<DayOfWeek, number> = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

/**
 * A weekly availability row as the grid consumes it — the stored columns, not
 * a pair of synthetic 1970 dates. #1342: the old shape called `startDay`
 * "dayOfWeekforStartTimeInUTC", which is what led the grid to match it against
 * the VIEWER's weekday, and it dropped `utcOffsetMinutes` so the row's own
 * projection could not be computed at all.
 */
export interface WeeklySlot {
  id: string;
  startDay: DayOfWeek;
  endDay: DayOfWeek;
  startTimeUtc: number;
  endTimeUtc: number;
  utcOffsetMinutes: number | null;
}

export interface CustomSlot {
  id: string;
  startsAt: Date;
  endsAt: Date;
}

export interface AppointmentSlot {
  startsAt: Date;
  endsAt: Date;
}

/**
 * Whether a stored slot row is shape-valid, including the legacy
 * "ends at midnight" overnight form.
 *
 * end > start is always valid. end <= start is only legitimate as the
 * legacy same-day-midnight storage of an overnight row (10:00 → 00:00
 * meaning 10:00 → 24:00): the end must be exactly UTC midnight AND fewer
 * than 24h before the start. Every earlier version of this check admitted
 * any end-at-midnight row no matter how far back it sat, so a corrupt
 * multi-day-negative row (e.g. Aug 25 10:00 → Aug 21 00:00) passed as
 * "legitimate overnight" and was painted onto the grid instead of being
 * dropped as the corruption it is.
 */
export function isValidOvernightSlot(startTime: Date, endTime: Date): boolean {
  if (endTime > startTime) return true;

  const endsAtMidnightUtc =
    endTime.getUTCHours() === 0 &&
    endTime.getUTCMinutes() === 0 &&
    endTime.getUTCSeconds() === 0 &&
    endTime.getUTCMilliseconds() === 0;
  if (!endsAtMidnightUtc) return false;

  const gapMs = startTime.getTime() - endTime.getTime();
  return gapMs > 0 && gapMs < 24 * 60 * 60 * 1000;
}

// #907 — the availability pipeline checks each 30-min window against the booked
// slots; scanning the full appointment array per window is O(windows × appts)
// and dominated cold wall-clock for wide ranges. Bucket booked slots by 30-min
// interval once so each window only compares against the handful that can
// actually overlap it. Every SlotOfAppointment is exactly 30 min and 30-min
// aligned, so a 30-min bucket is exact; the multi-bucket span below keeps it
// correct even for legacy/longer rows.
// #997 Phase 2 — exported so the availability-with-allocation route can bucket
// its OWN overlap-metadata index (title/participant for tooltips) using the
// exact same alignment as isSlotAllocated/getSlotBookingStatus below.
export const THIRTY_MIN_MS = 30 * 60 * 1000;
export type AppointmentIndex = Map<number, AppointmentSlot[]>;

export function buildAppointmentIndex(
  appointmentSlots: AppointmentSlot[],
): AppointmentIndex {
  const index: AppointmentIndex = new Map();
  if (!Array.isArray(appointmentSlots)) return index;
  for (const slot of appointmentSlots) {
    if (!slot || !slot.startsAt || !slot.endsAt) continue;
    const startMs = new Date(slot.startsAt).getTime();
    const endMs = new Date(slot.endsAt).getTime();
    if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs) continue;
    const firstBucket = Math.floor(startMs / THIRTY_MIN_MS);
    const lastBucket = Math.floor((endMs - 1) / THIRTY_MIN_MS);
    for (let b = firstBucket; b <= lastBucket; b++) {
      const bucket = index.get(b);
      if (bucket) bucket.push(slot);
      else index.set(b, [slot]);
    }
  }
  return index;
}

// Booked slots that can overlap [startMs, endMs). De-duped because a >30-min row
// lands in multiple buckets.
function candidatesFor(
  index: AppointmentIndex,
  startMs: number,
  endMs: number,
): AppointmentSlot[] {
  const firstBucket = Math.floor(startMs / THIRTY_MIN_MS);
  const lastBucket = Math.floor((endMs - 1) / THIRTY_MIN_MS);
  if (lastBucket <= firstBucket) return index.get(firstBucket) ?? [];
  const seen = new Set<AppointmentSlot>();
  const out: AppointmentSlot[] = [];
  for (let b = firstBucket; b <= lastBucket; b++) {
    const bucket = index.get(b);
    if (!bucket) continue;
    for (const slot of bucket) {
      if (!seen.has(slot)) {
        seen.add(slot);
        out.push(slot);
      }
    }
  }
  return out;
}

// #907 — the cold-time hotspot was re-constructing an Intl.DateTimeFormat on
// every per-window formatInTimeZone/toZonedTime call (tens of thousands for a
// month-wide range). Building each formatter ONCE per timezone and reusing it
// via formatToParts removes that construction cost while staying per-instant
// exact (incl. DST transition days, which a day-cached arithmetic offset gets
// wrong). `timeP` reassembles the parts with a normal space so it matches
// date-fns "p" (en-US "h:mm a") byte-for-byte — Intl alone uses a narrow no-break
// space (U+202F) on newer ICU, which would silently change the API response.
const WEEKDAY_TO_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

// #997 Phase 2 — exported so route.ts can localize synthetic (orphan)
// appointment-only intervals with the exact same dateKey/timeP format used here.
export function makeLocalizer(timezone: string) {
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const dateFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const weekdayFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  });
  const partVal = (parts: Intl.DateTimeFormatPart[], type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return {
    timeP: (d: Date): string => {
      const parts = timeFmt.formatToParts(d);
      return `${partVal(parts, "hour")}:${partVal(parts, "minute")} ${partVal(parts, "dayPeriod")}`;
    },
    dateKey: (d: Date): string => {
      const parts = dateFmt.formatToParts(d);
      return `${partVal(parts, "year")}-${partVal(parts, "month")}-${partVal(parts, "day")}`;
    },
    dayIndex: (d: Date): number => WEEKDAY_TO_INDEX[weekdayFmt.format(d)] ?? 0,
  };
}

export interface ProcessedSlot {
  start: Date;
  end: Date;
  availabilityId: string;
  type: "WEEKLY" | "CUSTOM"; // Keep as is to match TSlotTiming
}

/**
 * Checks if two time ranges overlap with support for partial, full, and eclipsing overlaps
 */
export function hasTimeOverlap(
  start1: Date,
  end1: Date,
  start2: Date,
  end2: Date,
): boolean {
  return start1 < end2 && start2 < end1;
}

/**
 * Process weekly slots for a specific date range.
 *
 * #1342 — the range is walked in UTC and each row is projected through its own
 * frozen offset by the shared generator, so the instants this returns are the
 * ones checkout's validator accepts and do not depend on who is looking. The
 * old body walked the range in the VIEWER's timezone, bucketed a row onto the
 * viewer's weekday and rebuilt the local wall-clock from the stored instant, so
 * a New York viewer was shown an IST pre-05:30 row one day away from the day it
 * publishes — and checkout rejected every booking made on it. Display zoning
 * happens downstream in `splitSlotsByDay` and `groupSlotsByDate`, which is why
 * the timezone argument is gone.
 */
export function processWeeklySlots(
  weeklySlots: WeeklySlot[],
  startDate: Date,
  endDate: Date,
): ProcessedSlot[] {
  const processedSlots: ProcessedSlot[] = [];

  // Defensive: Validate input parameters
  if (!Array.isArray(weeklySlots)) {
    console.warn("⚠️ processWeeklySlots: weeklySlots is not an array");
    return processedSlots;
  }

  if (
    !startDate ||
    !endDate ||
    isNaN(startDate.getTime()) ||
    isNaN(endDate.getTime())
  ) {
    console.warn("⚠️ processWeeklySlots: invalid startDate or endDate");
    return processedSlots;
  }

  if (endDate <= startDate) {
    console.warn("⚠️ processWeeklySlots: endDate must be after startDate");
    return processedSlots;
  }

  for (const slot of weeklySlots) {
    // Defensive: Skip slots with invalid data
    if (
      !slot ||
      !slot.id ||
      !slot.startDay ||
      typeof slot.startTimeUtc !== "number" ||
      typeof slot.endTimeUtc !== "number"
    ) {
      console.warn(
        `⚠️ processWeeklySlots: skipping slot with missing required fields`,
      );
      continue;
    }

    for (const occurrence of weeklyRowOccurrencesInRange(
      slot,
      startDate,
      endDate,
    )) {
      processedSlots.push({
        start: occurrence.start,
        end: occurrence.end,
        availabilityId: slot.id,
        type: "WEEKLY",
      });
    }
  }

  return processedSlots;
}

/**
 * Process custom slots for a specific date range
 */
export function processCustomSlots(
  customSlots: CustomSlot[],
  startDate: Date,
  endDate: Date,
): ProcessedSlot[] {
  // Defensive: Validate input parameters
  if (!Array.isArray(customSlots)) {
    console.warn("⚠️ processCustomSlots: customSlots is not an array");
    return [];
  }

  if (
    !startDate ||
    !endDate ||
    isNaN(startDate.getTime()) ||
    isNaN(endDate.getTime())
  ) {
    console.warn("⚠️ processCustomSlots: invalid startDate or endDate");
    return [];
  }

  if (endDate <= startDate) {
    console.warn("⚠️ processCustomSlots: endDate must be after startDate");
    return [];
  }

  return customSlots
    .filter((slot) => {
      // Defensive: Skip slots with invalid data
      if (!slot || !slot.id || !slot.startsAt || !slot.endsAt) {
        console.warn(
          `⚠️ processCustomSlots: skipping slot with missing required fields`,
        );
        return false;
      }

      // Defensive: Validate dates are valid
      const start = new Date(slot.startsAt);
      const end = new Date(slot.endsAt);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        console.warn(
          `⚠️ processCustomSlots: skipping slot ${slot.id} with invalid date format`,
        );
        return false;
      }

      // Defensive: Check slot is not inverted (end <= start, not overnight)
      if (end <= start) {
        console.warn(
          `⚠️ processCustomSlots: skipping slot ${slot.id} with end <= start`,
        );
        return false;
      }

      // Only include slots that overlap with our date range
      return hasTimeOverlap(slot.startsAt, slot.endsAt, startDate, endDate);
    })
    .map((slot) => ({
      start: slot.startsAt,
      end: slot.endsAt,
      availabilityId: slot.id,
      type: "CUSTOM",
    }));
}

/**
 * Split slots that cross midnight in the target timezone
 */
export function splitSlotsByDay(
  slots: ProcessedSlot[],
  timezone: string,
): ProcessedSlot[] {
  const splitSlots: ProcessedSlot[] = [];

  slots.forEach((slot) => {
    let current = slot.start;

    while (isBefore(current, slot.end)) {
      const zonedCurrent = toZonedTime(current, timezone);
      const dayStart = startOfDay(zonedCurrent);
      // #1415 — day segments are half-open: a segment ends at the NEXT day's
      // midnight, not at 23:59:59.999. The old `endOfDay` bound cut the last
      // millisecond off every block that runs to local midnight, and a
      // 23:30–23:59:59.999 remainder is not a 30-minute atom, so a block
      // ending at midnight silently lost its final bookable slot everywhere.
      const nextDayStart = fromZonedTime(addDays(dayStart, 1), timezone);

      const slotPartEnd = isBefore(slot.end, nextDayStart)
        ? slot.end
        : nextDayStart;

      // Skip zero-length segments
      if (slotPartEnd.getTime() === current.getTime()) {
        break;
      }

      // Push valid segment
      if (isBefore(current, slotPartEnd)) {
        splitSlots.push({
          start: current,
          end: slotPartEnd,
          availabilityId: slot.availabilityId,
          type: slot.type,
        });
      }

      if (
        isBefore(nextDayStart, current) ||
        nextDayStart.getTime() === current.getTime()
      ) {
        break;
      }
      current = nextDayStart;
    }
  });

  return splitSlots;
}

/**
 * Check if a slot is allocated by comparing with appointment slots
 */
export function isSlotAllocated(
  slotStart: Date,
  slotEnd: Date,
  appointmentSlots: AppointmentSlot[],
  // #907 — when provided, only the booked slots that can overlap this window are
  // compared (O(1) for 30-min windows) instead of the whole array.
  index?: AppointmentIndex,
): boolean {
  const candidates = index
    ? candidatesFor(index, slotStart.getTime(), slotEnd.getTime())
    : appointmentSlots;
  return candidates.some((apptSlot) =>
    hasTimeOverlap(slotStart, slotEnd, apptSlot.startsAt, apptSlot.endsAt),
  );
}

/**
 * Calculate the booking status of a slot (available, partially booked, or fully booked)
 */
export function getSlotBookingStatus(
  slotStart: Date,
  slotEnd: Date,
  appointmentSlots: AppointmentSlot[],
  // #907 — see isSlotAllocated; bounds the per-window overlap scan.
  index?: AppointmentIndex,
): BookingStatus {
  // Defensive: Validate input parameters
  if (
    !slotStart ||
    !slotEnd ||
    isNaN(slotStart.getTime()) ||
    isNaN(slotEnd.getTime())
  ) {
    console.warn("⚠️ getSlotBookingStatus: invalid slotStart or slotEnd");
    return BOOKING_STATUS.AVAILABLE;
  }

  if (slotEnd <= slotStart) {
    console.warn("⚠️ getSlotBookingStatus: slotEnd must be after slotStart");
    return BOOKING_STATUS.AVAILABLE;
  }

  if (!Array.isArray(appointmentSlots)) {
    console.warn("⚠️ getSlotBookingStatus: appointmentSlots is not an array");
    return BOOKING_STATUS.AVAILABLE;
  }

  const slotDuration = slotEnd.getTime() - slotStart.getTime();

  // #907 — narrow to the booked slots that can overlap this window before the
  // defensive filter + coverage merge below.
  const searchSpace = index
    ? candidatesFor(index, slotStart.getTime(), slotEnd.getTime())
    : appointmentSlots;

  // Find all appointments that overlap with this slot (with defensive filtering)
  const overlappingAppointments = searchSpace.filter((apptSlot) => {
    // Defensive: Skip invalid appointment slots
    if (!apptSlot || !apptSlot.startsAt || !apptSlot.endsAt) {
      return false;
    }

    const start = new Date(apptSlot.startsAt);
    const end = new Date(apptSlot.endsAt);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return false;
    }

    return hasTimeOverlap(
      slotStart,
      slotEnd,
      apptSlot.startsAt,
      apptSlot.endsAt,
    );
  });

  if (overlappingAppointments.length === 0) {
    return BOOKING_STATUS.AVAILABLE;
  }

  // Calculate total covered duration by merging overlapping appointments
  const intervals = overlappingAppointments.map((appt) => ({
    start: Math.max(slotStart.getTime(), appt.startsAt.getTime()),
    end: Math.min(slotEnd.getTime(), appt.endsAt.getTime()),
  }));

  // Sort intervals by start time
  intervals.sort((a, b) => a.start - b.start);

  // Merge overlapping intervals and calculate total coverage
  let totalCovered = 0;
  let currentEnd = 0;

  for (const interval of intervals) {
    if (interval.start > currentEnd) {
      // Non-overlapping interval
      totalCovered += interval.end - interval.start;
      currentEnd = interval.end;
    } else if (interval.end > currentEnd) {
      // Overlapping interval, extend the current coverage
      totalCovered += interval.end - currentEnd;
      currentEnd = interval.end;
    }
    // If interval.end <= currentEnd, it's completely covered, so no additional coverage
  }

  // Determine booking status based on coverage percentage
  const coveragePercentage = totalCovered / slotDuration;

  if (coveragePercentage >= FULLY_BOOKED_THRESHOLD) {
    // Allow for small rounding errors
    return BOOKING_STATUS.FULLY_BOOKED;
  } else if (coveragePercentage > 0) {
    return BOOKING_STATUS.PARTIALLY_BOOKED;
  } else {
    return BOOKING_STATUS.AVAILABLE;
  }
}

/**
 * Convert processed slots to TSlotTiming format
 */
export function convertToSlotTimings(
  processedSlots: ProcessedSlot[],
  appointmentSlots: AppointmentSlot[],
  timezone: string,
  // #907 — optional pre-built index to bound the per-slot overlap scan.
  index?: AppointmentIndex,
  // #907 — in the processAvailabilitySlots pipeline these results are discarded
  // (breakDownSlotsByDuration recomputes per sub-window), so skip the whole
  // O(slots × appts) status pass there. Defaults true for standalone callers.
  computeStatus: boolean = true,
): (TSlotTiming & {
  isAllocated: boolean;
  bookingStatus: BookingStatus;
})[] {
  const loc = makeLocalizer(timezone);
  const slotTimings = processedSlots.map((slot) => {
    const isAllocated = computeStatus
      ? isSlotAllocated(slot.start, slot.end, appointmentSlots, index)
      : false;
    const bookingStatus = computeStatus
      ? getSlotBookingStatus(slot.start, slot.end, appointmentSlots, index)
      : BOOKING_STATUS.AVAILABLE;

    return {
      slotId: `${slot.availabilityId}-${slot.start.toISOString()}`,
      dateInISO: slot.start.toISOString(),
      dayOfWeek: dayMap[loc.dayIndex(slot.start)],
      startsAt: slot.start.toISOString(),
      endsAt: slot.end.toISOString(),
      slotOfAvailabilityId: slot.availabilityId,
      slotOfAppointmentId: "",
      localStartTime: loc.timeP(slot.start),
      localEndTime: loc.timeP(slot.end),
      type: slot.type, // Explicitly set the type field
      isAllocated,
      bookingStatus,
    } as TSlotTiming & {
      isAllocated: boolean;
      bookingStatus: BookingStatus;
    };
  });

  // Sort chronologically by start time
  slotTimings.sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );

  return slotTimings;
}

/**
 * Merge consecutive availability slots into contiguous blocks.
 * This allows longer durations to be scheduled across multiple adjacent slots.
 *
 * For example, if slots are 2:30-3:00 and 3:00-3:30, this will merge them into 2:30-3:30.
 * Only merges slots that are NOT allocated (available).
 */
export function mergeConsecutiveSlots(
  slots: (TSlotTiming & {
    isAllocated: boolean;
    bookingStatus?: BookingStatus;
    slotOfAvailabilityIds?: string[];
  })[],
): (TSlotTiming & {
  isAllocated: boolean;
  bookingStatus?: BookingStatus;
  slotOfAvailabilityIds?: string[];
})[] {
  if (!slots || slots.length === 0) return [];

  // Sort slots by start time
  const sortedSlots = [...slots].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );

  const mergedSlots: (TSlotTiming & {
    isAllocated: boolean;
    bookingStatus?: BookingStatus;
    slotOfAvailabilityIds?: string[];
  })[] = [];

  let currentMerged: (typeof sortedSlots)[number] & {
    slotOfAvailabilityIds?: string[];
  } = { ...sortedSlots[0] };

  for (let i = 1; i < sortedSlots.length; i++) {
    const currentSlot = sortedSlots[i];
    const currentMergedEnd = new Date(currentMerged.endsAt).getTime();
    const nextSlotStart = new Date(currentSlot.startsAt).getTime();

    // Consecutive means EXACTLY adjacent — the merged end is the next start.
    // The old ±60s tolerance was harmless while a merge could only fuse
    // sub-windows of one row, but #1320 merges across rows: rows ending 10:30
    // and starting 10:31 would be offered as one window whose 10:30 atom no
    // row publishes, and checkout's union coverage then rejects the booking
    // the grid promised.
    const isConsecutive = currentMergedEnd === nextSlotStart;
    const bothAvailable =
      !currentMerged.isAllocated && !currentSlot.isAllocated;
    // #1320 — merge ACROSS availability rows. #788 forbade this because
    // checkout validated the whole window against the one row id the merged
    // slot carried; checkout now validates against the union of the
    // consultant's rows, so a window spanning "3:30–4:30" + "4:30–5:30" is
    // bookable exactly as the expert-page grid draws it. The first row's id
    // stays on the slot for compatibility; every covering id rides along.
    if (isConsecutive && bothAvailable) {
      // Both sides can already carry a set — the input type permits a
      // pre-merged slot — so unioning only `currentSlot`'s single id would
      // drop every row it had already absorbed.
      const ids = new Set([
        ...(currentMerged.slotOfAvailabilityIds ?? [
          currentMerged.slotOfAvailabilityId,
        ]),
        ...(currentSlot.slotOfAvailabilityIds ?? [
          currentSlot.slotOfAvailabilityId,
        ]),
      ]);
      currentMerged = {
        ...currentMerged,
        endsAt: currentSlot.endsAt,
        localEndTime: currentSlot.localEndTime,
        slotOfAvailabilityIds: [...ids],
      };
    } else {
      // Push the current merged slot and start a new one
      mergedSlots.push(currentMerged);
      currentMerged = { ...currentSlot };
    }
  }

  // Don't forget the last slot
  mergedSlots.push(currentMerged);

  return mergedSlots;
}

/**
 * Break down slots by duration using sliding windows while preserving allocation information
 */
export function breakDownSlotsByDuration(
  slots: (TSlotTiming & {
    isAllocated: boolean;
    bookingStatus?: BookingStatus;
  })[],
  durationInHours: number,
  appointmentSlots: AppointmentSlot[],
  timezone: string,
  // #907 — optional pre-built index; built lazily from appointmentSlots if
  // omitted so existing callers (e.g. TrialScheduleCalendar) stay unchanged.
  index?: AppointmentIndex,
): (TSlotTiming & {
  isAllocated: boolean;
  bookingStatus: BookingStatus;
})[] {
  const brokenDownSlots: (TSlotTiming & {
    isAllocated: boolean;
    bookingStatus: BookingStatus;
  })[] = [];

  if (!slots || slots.length === 0) return brokenDownSlots;

  const apptIndex = index ?? buildAppointmentIndex(appointmentSlots);
  const loc = makeLocalizer(timezone);

  // Define sliding window interval (30 minutes)
  const slidingIntervalMinutes = 30;
  const slidingIntervalMillis = slidingIntervalMinutes * 60 * 1000;
  const durationInMillis = durationInHours * 60 * 60 * 1000;

  slots.forEach((slot) => {
    const start = new Date(slot.startsAt);
    const end = new Date(slot.endsAt);

    // Generate sliding windows
    let currentStart = start;
    while (currentStart.getTime() + durationInMillis <= end.getTime()) {
      const currentEnd = new Date(currentStart.getTime() + durationInMillis);

      // FIX: Check ONLY this specific segment's overlap with appointments
      // Previously, this inherited slot.isAllocated from the parent slot,
      // which caused ALL segments to be marked allocated if ANY part of the
      // original availability slot overlapped with an appointment
      const isSegmentAllocated = isSlotAllocated(
        currentStart,
        currentEnd,
        appointmentSlots,
        apptIndex,
      );

      // Calculate booking status for this specific segment
      const segmentBookingStatus = getSlotBookingStatus(
        currentStart,
        currentEnd,
        appointmentSlots,
        apptIndex,
      );

      brokenDownSlots.push({
        ...slot,
        slotId: `${slot.slotOfAvailabilityId}-${currentStart.getTime()}`,
        startsAt: currentStart.toISOString(),
        endsAt: currentEnd.toISOString(),
        localStartTime: loc.timeP(currentStart),
        localEndTime: loc.timeP(currentEnd),
        isAllocated: isSegmentAllocated,
        bookingStatus: segmentBookingStatus,
      });

      // Move to next sliding window (30-minute intervals)
      currentStart = new Date(currentStart.getTime() + slidingIntervalMillis);
    }
  });

  // Sort chronologically
  brokenDownSlots.sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );

  return brokenDownSlots;
}

/**
 * Group slots by date in the target timezone
 */
export function groupSlotsByDate(
  slotTimings: (TSlotTiming & {
    isAllocated: boolean;
    bookingStatus: BookingStatus;
  })[],
  timezone: string,
): Record<
  string,
  (TSlotTiming & {
    isAllocated: boolean;
    bookingStatus: BookingStatus;
  })[]
> {
  const loc = makeLocalizer(timezone);
  const slotsByDate = slotTimings.reduce(
    (acc, slot) => {
      const dateKey = loc.dateKey(new Date(slot.startsAt));
      if (!acc[dateKey]) {
        acc[dateKey] = [];
      }
      acc[dateKey].push(slot);
      return acc;
    },
    {} as Record<
      string,
      (TSlotTiming & {
        isAllocated: boolean;
        bookingStatus: BookingStatus;
      })[]
    >,
  );

  // Sort slots within each day chronologically
  Object.keys(slotsByDate).forEach((dateKey) => {
    slotsByDate[dateKey].sort(
      (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
    );
  });

  return slotsByDate;
}

/**
 * Main function to process all availability slots with allocation detection
 *
 * @param durationInHours - Duration for breaking down slots (default: 0.5 = 30 minutes)
 *   This ensures each returned slot has its own per-interval booking status
 *   rather than inheriting status from the entire availability block.
 */
export function processAvailabilitySlots(
  weeklySlots: WeeklySlot[],
  customSlots: CustomSlot[],
  appointmentSlots: AppointmentSlot[],
  startDate: Date,
  endDate: Date,
  timezone: string,
  durationInHours: number = 0.5, // Default to 30-minute intervals
): Record<
  string,
  (TSlotTiming & {
    isAllocated: boolean;
    bookingStatus: BookingStatus;
  })[]
> {
  // Process weekly and custom slots
  const processedWeeklySlots = processWeeklySlots(
    weeklySlots,
    startDate,
    endDate,
  );
  const processedCustomSlots = processCustomSlots(
    customSlots,
    startDate,
    endDate,
  );

  // Combine all slots
  const allSlots = [...processedWeeklySlots, ...processedCustomSlots];

  // Split slots that cross midnight
  const splitSlots = splitSlotsByDay(allSlots, timezone);

  // #907 — bucket booked slots once and share the index across both passes.
  const apptIndex = buildAppointmentIndex(appointmentSlots);

  // Convert to slot timings. computeStatus=false: the per-block status below is
  // discarded by breakDownSlotsByDuration (which recomputes per sub-window), so
  // skip the redundant O(slots × appts) pass entirely.
  const slotTimings = convertToSlotTimings(
    splitSlots,
    appointmentSlots,
    timezone,
    apptIndex,
    false,
  );

  // FIX: Break down into smaller intervals (default 30 min) with per-interval booking status
  // This fixes the bug where an 8-hour availability block with 1-hour appointment
  // showed ALL intervals as "Partially Booked" instead of only the booked intervals
  const brokenDownSlots = breakDownSlotsByDuration(
    slotTimings,
    durationInHours,
    appointmentSlots,
    timezone,
    apptIndex,
  );

  // Group by date
  return groupSlotsByDate(brokenDownSlots, timezone);
}

/**
 * Break down pre-processed slots by duration using sliding windows,
 * PRESERVING the bookingStatus from the API rather than recomputing from appointments.
 *
 * Use this on the client when the slots already have correct bookingStatus from the server
 * and you only need to create duration-appropriate windows for display.
 */
export function breakDownSlotsPreservingStatus(
  apiSlots: (TSlotTiming & {
    isAllocated: boolean;
    bookingStatus?: BookingStatus;
  })[],
  durationInHours: number,
  timezone: string,
): (TSlotTiming & {
  isAllocated: boolean;
  bookingStatus: BookingStatus;
})[] {
  if (!apiSlots || apiSlots.length === 0) return [];

  const loc = makeLocalizer(timezone);
  const slidingIntervalMillis = 30 * 60 * 1000;
  const durationInMillis = durationInHours * 60 * 60 * 1000;

  // Merge consecutive available slots to allow longer duration windows
  const mergedSlots = mergeConsecutiveSlots(apiSlots);
  const result: (TSlotTiming & {
    isAllocated: boolean;
    bookingStatus: BookingStatus;
  })[] = [];

  for (const slot of mergedSlots) {
    const slotStart = new Date(slot.startsAt).getTime();
    const slotEnd = new Date(slot.endsAt).getTime();

    let windowStart = slotStart;
    while (windowStart + durationInMillis <= slotEnd) {
      const windowEnd = windowStart + durationInMillis;

      // Find all original API sub-slots overlapping this window
      const overlapping = apiSlots.filter((s) => {
        const sStart = new Date(s.startsAt).getTime();
        const sEnd = new Date(s.endsAt).getTime();
        return sStart < windowEnd && sEnd > windowStart;
      });

      // Derive worst-case status from overlapping sub-slots
      let windowStatus: BookingStatus = BOOKING_STATUS.AVAILABLE;
      let windowAllocated = false;

      if (overlapping.length > 0) {
        const hasFullyBooked = overlapping.some(
          (s) => s.bookingStatus === BOOKING_STATUS.FULLY_BOOKED,
        );
        const hasPartiallyBooked = overlapping.some(
          (s) => s.bookingStatus === BOOKING_STATUS.PARTIALLY_BOOKED,
        );
        windowAllocated = overlapping.some((s) => s.isAllocated);

        if (
          overlapping.every(
            (s) => s.bookingStatus === BOOKING_STATUS.FULLY_BOOKED,
          )
        ) {
          windowStatus = BOOKING_STATUS.FULLY_BOOKED;
        } else if (hasFullyBooked || hasPartiallyBooked) {
          windowStatus = BOOKING_STATUS.PARTIALLY_BOOKED;
        }
      }

      const windowStartDate = new Date(windowStart);
      const windowEndDate = new Date(windowEnd);

      result.push({
        ...slot,
        slotId: `${slot.slotOfAvailabilityId}-${windowStart}`,
        startsAt: windowStartDate.toISOString(),
        endsAt: windowEndDate.toISOString(),
        localStartTime: loc.timeP(windowStartDate),
        localEndTime: loc.timeP(windowEndDate),
        isAllocated: windowAllocated,
        bookingStatus: windowStatus,
      });

      windowStart += slidingIntervalMillis;
    }
  }

  result.sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );

  return result;
}
