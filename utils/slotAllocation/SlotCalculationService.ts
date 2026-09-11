/**
 * Slot Calculation Service
 *
 * Single source of truth for all slot-related calculations.
 * Handles week counting, slot requirements, progress tracking, and grouping logic.
 */

import { EventType, EventConfig, TimeSlot, ProgressInfo } from "./types";

/** Weekday name → index for Intl "short" weekday parts. */
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Service for calculating slots, weeks, and progress
 */
export class SlotCalculationService {
  /**
   * Timezone that defines a "day" and a "week" for booking limits when the
   * event carries no explicit schedulingTimezone (ADR B9). Matches the
   * Subscription/Class column default.
   */
  static readonly DEFAULT_SCHEDULING_TIMEZONE = "Asia/Kolkata";

  // Intl.DateTimeFormat construction is expensive and the keys are computed
  // in per-click loops; cache one formatter per timezone.
  private static readonly dateFormatters = new Map<string, Intl.DateTimeFormat>();

  private static getDateFormatter(timeZone: string): Intl.DateTimeFormat {
    let formatter = this.dateFormatters.get(timeZone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        // hourCycle, NOT `hour12: false` — the latter resolves to h24 under an
        // en-US default, and h24 writes midnight as "24:00" against the
        // PREVIOUS day's date. Every reader here would then get hour 0 with
        // the day off by one, silently.
        hourCycle: "h23",
      });
      this.dateFormatters.set(timeZone, formatter);
    }
    return formatter;
  }

  /** Offset (minutes, positive east of UTC) of a timezone at an instant.
   * Intl-only so this module stays dependency-free (it is imported by pure
   * client code and by jsdom tests that stub Prisma). */
  private static tzOffsetMinutes(timeZone: string, at: Date): number {
    const parts = this.getDateFormatter(timeZone).formatToParts(at);
    const get = (type: string) =>
      Number(parts.find((p) => p.type === type)?.value ?? 0);
    const wallAsUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    );
    return Math.round((wallAsUtc - at.getTime()) / 60_000);
  }

  /** Calendar date {year, month(1-12), day, weekday(0=Sun), hour(0-23)} of an instant in a timezone. */
  private static getCalendarParts(
    d: Date,
    timeZone: string,
  ): {
    year: number;
    month: number;
    day: number;
    weekday: number;
    hour: number;
  } {
    const parts = this.getDateFormatter(timeZone).formatToParts(d);
    const get = (type: string) =>
      parts.find((p) => p.type === type)?.value ?? "";
    return {
      year: Number(get("year")),
      month: Number(get("month")),
      day: Number(get("day")),
      weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
      // 0-23 straight from the formatter, which is pinned to h23 above — so
      // midnight is 00:00 on its own day, never 24:00 on the day before. The
      // `% 24` this used to carry was a guard against h24 and is gone with it;
      // leaving it would have kept a comment that contradicts the pinning.
      hour: Number(get("hour")),
    };
  }

  /**
   * Wall-clock reading of an instant in a timezone: the calendar date AND the
   * time of day.
   *
   * Shares the cached formatter with the limit-bucket keys below, so code that
   * places something on a grid and code that buckets it cannot drift apart.
   */
  static wallClock(
    d: Date,
    timeZone: string = this.DEFAULT_SCHEDULING_TIMEZONE,
  ): {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
  } {
    const parts = this.getDateFormatter(timeZone).formatToParts(d);
    const get = (type: string) =>
      Number(parts.find((p) => p.type === type)?.value ?? 0);
    return {
      year: get("year"),
      month: get("month"),
      day: get("day"),
      // 0-23 without normalizing: the formatter is pinned to h23, so midnight
      // is 00:00 on its own day rather than 24:00 on the day before.
      hour: get("hour"),
      minute: get("minute"),
    };
  }

  /**
* Wall-clock hour and weekday of an instant, as read in `timeZone` (ADR B9).
   *
   * #1065 — the allocator scores "morning"/"weekend" with this rather than
   * Date#getHours()/getDay(), which answer in whatever timezone the Node
   * process happens to run in and would make the same booking a morning on one
   * host and an afternoon on another.
   *
   * Both come back together because the scorer needs both for every candidate
   * and `formatToParts` is the expensive part: asking twice doubled the Intl
   * work inside the allocation search, which runs while the allocation lock is
   * held.
   */
  static zonedClock(
    d: Date,
    timeZone: string = this.DEFAULT_SCHEDULING_TIMEZONE,
  ): { hour: number; weekday: number } {
    const { hour, weekday } = this.getCalendarParts(d, timeZone);
    return { hour, weekday };
  }

  /** Wall-clock hour (0-23) of an instant in `timeZone`. */
  static hourInTz(
    d: Date,
    timeZone: string = this.DEFAULT_SCHEDULING_TIMEZONE,
  ): number {
    return this.getCalendarParts(d, timeZone).hour;
  }

  /** Day of week (0 = Sunday) of an instant, as read in `timeZone` (ADR B9). */
  static weekdayInTz(
    d: Date,
    timeZone: string = this.DEFAULT_SCHEDULING_TIMEZONE,
  ): number {
    return this.getCalendarParts(d, timeZone).weekday;
  }
  /**
   * Count the number of distinct Sunday-start weeks overlapping [start, end].
   * This is the SINGLE implementation used across the entire app.
   *
   * The first week is the Sunday of the week containing startDate.
   * The last week is the Sunday of the week containing endDate.
   *
   * Example: Jan 1 (Monday) to Feb 1 (Thursday):
   * - Week 1: Sunday Dec 29
   * - Week 2: Sunday Jan 5
   * - Week 3: Sunday Jan 12
   * - Week 4: Sunday Jan 19
   * - Week 5: Sunday Jan 26
   * = 5 weeks total
   */
  static countWeeks(startDate: Date, endDate: Date): number {
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (end < start) return 0;

    // Find the Sunday of the week containing start and end (UTC-based)
    const startSunday = this.startOfWeekSunday(start);
    const endSunday = this.startOfWeekSunday(end);

    // Count number of Sundays from startSunday to endSunday inclusive
    let weeks = 1;
    const cursor = new Date(startSunday);
    while (cursor < endSunday) {
      cursor.setUTCDate(cursor.getUTCDate() + 7);
      weeks += 1;
    }
    return weeks;
  }

  /**
   * Get the Sunday at 00:00:00 of the week that contains the given date.
   */
  static startOfWeekSunday(d: Date): Date {
    const date = new Date(d);
    const day = date.getUTCDay(); // 0 = Sunday
    const diff = day; // days since Sunday
    return new Date(
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate() - diff,
        0,
        0,
        0,
        0,
      ),
    );
  }

  /**
   * Canonical day key ("YYYY-MM-DD") for daily-limit bucketing, in the
   * event's scheduling timezone (ADR B9). Client and server must share this
   * key or verdicts diverge near day boundaries; "one session per day" means
   * one session per calendar day AS THE CUSTOMER SEES IT.
   */
  static dayKey(
    d: Date,
    timeZone: string = this.DEFAULT_SCHEDULING_TIMEZONE,
  ): string {
    const { year, month, day } = this.getCalendarParts(d, timeZone);
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  /**
   * Canonical week key ("YYYY-MM-DD" of the Sunday starting the week, as a
   * calendar date in the event's scheduling timezone) for weekly-limit
   * bucketing (ADR B9).
   */
  static weekKey(
    d: Date,
    timeZone: string = this.DEFAULT_SCHEDULING_TIMEZONE,
  ): string {
    const { year, month, day, weekday } = this.getCalendarParts(d, timeZone);
    // Date.UTC normalizes day-of-month underflow; noon avoids any ±offset
    // spill when reading the parts back with UTC getters.
    const sunday = new Date(Date.UTC(year, month - 1, day - weekday, 12));
    return `${sunday.getUTCFullYear()}-${String(sunday.getUTCMonth() + 1).padStart(2, "0")}-${String(sunday.getUTCDate()).padStart(2, "0")}`;
  }

  /**
   * The UTC instant at which the week containing `d` starts — Sunday 00:00
   * in the given timezone. Used where week buckets must be Date ranges
   * (e.g. the server's weekly-info generator) rather than string keys.
   */
  static startOfWeekSundayInTz(
    d: Date,
    timeZone: string = this.DEFAULT_SCHEDULING_TIMEZONE,
  ): Date {
    const { year, month, day, weekday } = this.getCalendarParts(d, timeZone);
    const sundayLocalMidnightAsUtc = Date.UTC(year, month - 1, day - weekday);
    return new Date(this.zonedMidnightInstant(sundayLocalMidnightAsUtc, timeZone));
  }

  /**
   * The UTC instant at which the day-limit bucket containing `d` starts —
   * 00:00 of that calendar day in the given timezone. #1076 — the cap
   * messages name the bucket's span on the viewer's clock.
   */
  static startOfDayInTz(
    d: Date,
    timeZone: string = this.DEFAULT_SCHEDULING_TIMEZONE,
  ): Date {
    const { year, month, day } = this.getCalendarParts(d, timeZone);
    return new Date(
      this.zonedMidnightInstant(Date.UTC(year, month - 1, day), timeZone),
    );
  }

  /** Zoned-midnight wall time → UTC instant, two-pass to absorb a DST edge at the boundary. */
  private static zonedMidnightInstant(
    localMidnightAsUtcMs: number,
    timeZone: string,
  ): number {
    const offset = this.tzOffsetMinutes(
      timeZone,
      new Date(localMidnightAsUtcMs),
    );
    let instant = localMidnightAsUtcMs - offset * 60_000;
    const offsetAtInstant = this.tzOffsetMinutes(timeZone, new Date(instant));
    if (offsetAtInstant !== offset) {
      instant = localMidnightAsUtcMs - offsetAtInstant * 60_000;
    }
    return instant;
  }

  /**
   * Validate duration parameter for all event types
   *
   * CRITICAL SAFETY CHECK:
   * Duration is used in division and slot calculations throughout the app.
   * Invalid values (0, negative, Infinity, undefined) can cause:
   * - Division by zero errors
   * - Infinite loops in slot allocation
   * - Negative slot counts
   * - Database corruption
   *
   * This centralized validation ensures all services use consistent rules.
   *
   * @param duration - The duration value to validate
   * @param fieldName - Descriptive name for error messages (e.g., "sessionDurationInHours")
   * @throws {Error} If duration is invalid
   */
  static validateDuration(
    duration: number | undefined,
    fieldName: string,
  ): void {
    if (duration === undefined || duration === null) {
      throw new Error(`${fieldName} is required but was not provided`);
    }

    if (typeof duration !== "number") {
      throw new Error(
        `${fieldName} must be a number, but received type: ${typeof duration}`,
      );
    }

    if (duration <= 0) {
      throw new Error(
        `${fieldName} must be positive, but received: ${duration}`,
      );
    }

    if (!Number.isFinite(duration)) {
      throw new Error(
        `${fieldName} must be a finite number, but received: ${duration}`,
      );
    }

    // Hard limit: sessions longer than 24 hours are not supported and would
    // cause the auto-allocator to time out searching for impossible slot blocks.
    if (duration > 24) {
      throw new Error(
        `${fieldName} cannot exceed 24 hours, but received: ${duration}`,
      );
    }

    if (duration < 0.5) {
      throw new Error(
        `${fieldName} must be at least 0.5 hours (30 minutes), but received: ${duration}`,
      );
    }
  }

  /**
   * Calculate the total number of 30-minute slots required for an event.
   *
   * IMPORTANT: This function returns SLOT COUNT, not call/session count.
   *
   * For different event types:
   * - CONSULTATIONS: Returns slots needed for the session duration (e.g., 2 slots for 1 hour)
   * - WEBINARS: Returns slots needed for the session duration (e.g., 2 slots for 1 hour)
   * - CLASSES: Returns total slots for all sessions (weeks × calls/week × slots/session)
   * - SUBSCRIPTIONS: Computes weeks → calls → slots (based on 30-min increments)
   */
  static calculateRequiredSlots(
    eventType: EventType,
    config: EventConfig,
  ): number {
    if (!eventType) {
      throw new Error("Event type is required");
    }

    switch (eventType) {
      case "consultation": {
        const duration = config.durationInHours;
        if (!duration || duration <= 0) {
          console.warn(
            "Consultation duration missing or invalid. Using default: 1 hour",
          );
          return Math.ceil(1 / 0.5); // Default 1 hour = 2 slots
        }
        return Math.ceil(duration / 0.5); // 30-minute intervals
      }

      case "webinar": {
        const duration = config.durationInHours;
        if (!duration || duration <= 0) {
          return Math.ceil(1 / 0.5); // Default 1 hour = 2 slots
        }
        return Math.ceil(duration / 0.5); // 30-minute intervals
      }

      case "subscription": {
        if (
          !config.schedulingPeriodStartsAt ||
          !config.schedulingPeriodEndsAt
        ) {
          throw new Error(
            "Start date and end date are required for subscription slot calculation",
          );
        }

        let sessionDuration = config.sessionDurationInHours;
        if (!sessionDuration || sessionDuration <= 0) {
          console.warn(
            "Subscription session duration missing or invalid. Using default: 1 hour",
          );
          sessionDuration = 1; // Default 1 hour
        }

        const slotsPerCall = Math.ceil(sessionDuration / 0.5);

        // Use totalSessions from plan if available (authoritative plan-defined count).
        // This prevents week-boundary edge cases where countWeeks > plan's totalSessions
        // (e.g. a 28-day period that spans 5 calendar weeks but has only 4 planned sessions).
        if (config.totalSessions && config.totalSessions > 0) {
          return config.totalSessions * slotsPerCall;
        }

        // Fall back to weeks-based calculation when totalSessions is not specified
        const totalWeeks = this.countWeeks(
          config.schedulingPeriodStartsAt,
          config.schedulingPeriodEndsAt,
        );
        const totalCalls = totalWeeks * (config.sessionsPerWeek || 1);
        return totalCalls * slotsPerCall;
      }

      case "class": {
        if (
          !config.schedulingPeriodStartsAt ||
          !config.schedulingPeriodEndsAt
        ) {
          throw new Error(
            "Start date and end date are required for class slot calculation",
          );
        }

        if (!config.sessionsPerWeek || config.sessionsPerWeek <= 0) {
          throw new Error(
            "Calls per week must be a positive number for classes",
          );
        }

        const sessionDuration = config.sessionDurationInHours;
        if (!sessionDuration || sessionDuration <= 0) {
          throw new Error(
            "Session duration must be a positive number for classes",
          );
        }

        const slotsPerSession = Math.ceil(sessionDuration / 0.5);

        // Use totalSessions from plan if available (authoritative plan-defined count).
        // Prevents over-allocation when scheduling period spans more weeks than planned.
        if (config.totalSessions && config.totalSessions > 0) {
          return config.totalSessions * slotsPerSession;
        }

        const totalWeeks = this.countWeeks(
          config.schedulingPeriodStartsAt,
          config.schedulingPeriodEndsAt,
        );
        const totalSessions = totalWeeks * config.sessionsPerWeek;
        return totalSessions * slotsPerSession;
      }

      default:
        throw new Error(`Invalid event type: ${eventType}`);
    }
  }

  /**
   * Calculate how many slots are needed per call/session (30-min increments)
   */
  static getSlotsPerCall(sessionDurationInHours: number): number {
    return Math.ceil(sessionDurationInHours / 0.5);
  }

  /**
   * Calculate progress for UI display
   * Returns user-friendly progress information
   */
  static calculateProgress(
    selectedSlots: TimeSlot[],
    eventType: EventType,
    config: EventConfig,
  ): ProgressInfo {
    const sessionDuration =
      config.sessionDurationInHours || config.durationInHours || 1;
    const slotsPerCall = this.getSlotsPerCall(sessionDuration);

    let scheduled = 0;
    let required = 0;

    switch (eventType) {
      case "consultation":
      case "webinar":
        // Single event - just check if enough consecutive slots selected
        scheduled = selectedSlots.length >= slotsPerCall ? 1 : 0;
        required = 1;
        break;

      case "subscription":
      case "class": {
        // Count complete calls/sessions (full consecutive slot groups)
        scheduled = this.countCompletedCalls(selectedSlots, slotsPerCall);

        // Prefer totalSessions from plan (authoritative count) for both subscriptions and classes.
        // Falls back to weeks × sessionsPerWeek only when totalSessions is not set.
        if (config.totalSessions && config.totalSessions > 0) {
          required = config.totalSessions;
        } else {
          if (
            !config.schedulingPeriodStartsAt ||
            !config.schedulingPeriodEndsAt ||
            !config.sessionsPerWeek
          ) {
            throw new Error(
              "Start date, end date, and calls per week are required for subscription/class progress calculation",
            );
          }

          const weeks = this.countWeeks(
            config.schedulingPeriodStartsAt,
            config.schedulingPeriodEndsAt,
          );
          required = weeks * config.sessionsPerWeek;
        }
        break;
      }
    }

    const remaining = Math.max(0, required - scheduled);
    const displayText = this.formatProgressText(
      eventType,
      scheduled,
      required,
      remaining,
      sessionDuration,
      config.sessionsPerWeek,
    );

    return {
      scheduled,
      required,
      remaining,
      sessionDuration,
      displayText,
    };
  }

  /**
   * Count completed calls/sessions from selected slots
   * A completed call is a set of consecutive slots on the same day
   */
  private static countCompletedCalls(
    selectedSlots: TimeSlot[],
    slotsPerCall: number,
  ): number {
    if (!selectedSlots?.length) return 0;

    // Group slots by day
    const slotsByDay = this.groupSlotsByDay(selectedSlots);

    let completed = 0;
    slotsByDay.forEach((daySlots) => {
      const sorted = [...daySlots].sort(
        (a, b) => a.startTime.getTime() - b.startTime.getTime(),
      );

      // Check if this day has enough consecutive slots for a complete call
      if (sorted.length >= slotsPerCall) {
        let consecutiveCount = 1;
        for (let i = 1; i < sorted.length; i++) {
          if (
            sorted[i].startTime.getTime() === sorted[i - 1].endTime.getTime()
          ) {
            consecutiveCount++;
            if (consecutiveCount === slotsPerCall) {
              completed++;
              consecutiveCount = 0; // Reset for next potential call
            }
          } else {
            consecutiveCount = 1; // Reset on gap
          }
        }
      }
    });

    return completed;
  }

  /**
   * Group time slots by scheduling-timezone day
   */
  static groupSlotsByDay(
    slots: TimeSlot[],
    timeZone: string = this.DEFAULT_SCHEDULING_TIMEZONE,
  ): Map<string, TimeSlot[]> {
    const slotsByDay = new Map<string, TimeSlot[]>();

    for (const slot of slots) {
      const dayKey = this.dayKey(slot.startTime, timeZone);
      if (!slotsByDay.has(dayKey)) {
        slotsByDay.set(dayKey, []);
      }
      slotsByDay.get(dayKey)!.push(slot);
    }

    return slotsByDay;
  }

  /**
   * Group time slots by scheduling-timezone week (Sunday-Saturday)
   */
  static groupSlotsByWeek(
    slots: TimeSlot[],
    timeZone: string = this.DEFAULT_SCHEDULING_TIMEZONE,
  ): Map<string, TimeSlot[]> {
    const slotsByWeek = new Map<string, TimeSlot[]>();

    for (const slot of slots) {
      const weekKey = this.weekKey(slot.startTime, timeZone);

      if (!slotsByWeek.has(weekKey)) {
        slotsByWeek.set(weekKey, []);
      }
      slotsByWeek.get(weekKey)!.push(slot);
    }

    return slotsByWeek;
  }

  /**
   * Format progress text for UI display
   * Clear, user-friendly text without technical jargon
   */
  private static formatProgressText(
    eventType: EventType,
    scheduled: number,
    required: number,
    remaining: number,
    sessionDuration: number,
    sessionsPerWeek?: number,
  ): string {
    const durationText =
      sessionDuration === 1 ? "1 hour" : `${sessionDuration} hours`;
    const sessionWord = eventType === "class" ? "session" : "call";
    const sessionWordPlural = eventType === "class" ? "sessions" : "calls";

    if (eventType === "consultation" || eventType === "webinar") {
      if (scheduled === 0) {
        return `Select ${required} ${sessionWord} (${durationText})`;
      }
      return `✅ ${sessionWord.charAt(0).toUpperCase() + sessionWord.slice(1)} scheduled`;
    }

    // For subscriptions and classes
    if (scheduled === 0) {
      const limitText = sessionsPerWeek
        ? ` | Limit: ${sessionsPerWeek}/${eventType === "class" ? "week" : "week"}`
        : "";
      return `📅 Schedule ${required} ${sessionWordPlural} (${durationText} each)${limitText}`;
    } else if (remaining > 0) {
      const limitText = sessionsPerWeek ? ` | ${sessionsPerWeek}/week` : "";
      return `✅ ${scheduled} scheduled | ⏳ ${remaining} remaining (${durationText} each)${limitText}`;
    } else {
      return `✅ All ${required} ${sessionWordPlural} scheduled`;
    }
  }
}
