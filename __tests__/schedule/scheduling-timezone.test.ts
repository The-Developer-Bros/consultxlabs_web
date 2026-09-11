// #1076 — schedulingTimezone was never written, so every per-day/per-week cap
// on the platform bucketed against Indian calendar days. These pin the
// resolver that the four creation paths now call, and prove that the zone it
// returns actually moves the bucket boundaries the caps are counted against.

// calendarUtils imports Prisma enums as values; stub the client so jsdom never
// loads the engine.
jest.mock("@prisma/client", () => ({
  DayOfWeek: {},
  ScheduleType: {},
  AppointmentsType: {},
  Prisma: {},
}));

import {
  isValidIanaTimezone,
  resolveSchedulingTimezone,
} from "@/lib/scheduling/schedulingTimezone";
import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";
import { validateDailyHours } from "@/lib/scheduling/slotSelectionValidation";
import type { TimeSlot } from "@/lib/scheduling/calendarUtils";

const hourSlot = (startIso: string): TimeSlot => {
  const startTime = new Date(startIso);
  return {
    startTime,
    endTime: new Date(startTime.getTime() + 60 * 60 * 1000),
    isAvailable: true,
    isBooked: false,
  };
};

describe("resolveSchedulingTimezone", () => {
  it("uses the consultant's recorded zone", () => {
    expect(resolveSchedulingTimezone("Europe/London")).toBe("Europe/London");
    expect(resolveSchedulingTimezone("America/New_York")).toBe(
      "America/New_York",
    );
    expect(resolveSchedulingTimezone("UTC")).toBe("UTC");
  });

  it("falls back to the platform default when no zone is recorded", () => {
    expect(resolveSchedulingTimezone(null)).toBe("Asia/Kolkata");
    expect(resolveSchedulingTimezone(undefined)).toBe("Asia/Kolkata");
    expect(resolveSchedulingTimezone("")).toBe("Asia/Kolkata");
    expect(resolveSchedulingTimezone("   ")).toBe("Asia/Kolkata");
  });

  it("matches the constant the bucketing code defaults to", () => {
    expect(resolveSchedulingTimezone(null)).toBe(
      SlotCalculationService.DEFAULT_SCHEDULING_TIMEZONE,
    );
  });

  it("falls back rather than persisting a junk zone", () => {
    // A junk value here would silently corrupt every cap for the booking.
    expect(resolveSchedulingTimezone("Mars/Olympus_Mons")).toBe("Asia/Kolkata");
    expect(resolveSchedulingTimezone("GMT+5:30")).toBe("Asia/Kolkata");
    expect(resolveSchedulingTimezone("Europe/Londonn")).toBe("Asia/Kolkata");
    expect(resolveSchedulingTimezone("'; DROP TABLE")).toBe("Asia/Kolkata");
  });

  it("trims a padded zone rather than rejecting it", () => {
    expect(resolveSchedulingTimezone("  Europe/London  ")).toBe(
      "Europe/London",
    );
  });

  it("recognises real zones and rejects invented ones", () => {
    expect(isValidIanaTimezone("Asia/Kolkata")).toBe(true);
    expect(isValidIanaTimezone("Pacific/Auckland")).toBe(true);
    expect(isValidIanaTimezone("Not/AZone")).toBe(false);
  });
});

describe("the resolved zone moves the cap buckets", () => {
  // 20:00Z on 20 Jul 2026 is still Monday evening in London but already
  // Tuesday in Kolkata — the 5.5h offset puts the two on different days.
  const straddling = new Date("2026-07-20T20:00:00Z");

  it("a London consultant's sessions bucket on London days", () => {
    const london = resolveSchedulingTimezone("Europe/London");
    expect(SlotCalculationService.dayKey(straddling, london)).toBe(
      "2026-07-20",
    );
  });

  it("a consultant with no zone keeps the Indian day boundaries", () => {
    const fallback = resolveSchedulingTimezone(null);
    expect(SlotCalculationService.dayKey(straddling, fallback)).toBe(
      "2026-07-21",
    );
  });

  it("week buckets move too", () => {
    // Saturday night in London, already Sunday in Kolkata, so the two land in
    // different Sunday-anchored weeks.
    const weekend = new Date("2026-07-18T20:00:00Z");
    expect(
      SlotCalculationService.weekKey(
        weekend,
        resolveSchedulingTimezone("Europe/London"),
      ),
    ).toBe("2026-07-12");
    expect(
      SlotCalculationService.weekKey(weekend, resolveSchedulingTimezone(null)),
    ).toBe("2026-07-19");
  });

  it("a cap that passes on Indian days fails on London days", () => {
    // Two one-hour sessions that are the same London evening but straddle
    // Indian midnight, against a one-hour-per-day cap.
    const slots = [
      hourSlot("2026-07-20T17:00:00Z"),
      hourSlot("2026-07-20T20:00:00Z"),
    ];

    expect(validateDailyHours(slots, 1, resolveSchedulingTimezone(null))).toBe(
      true,
    );
    expect(
      validateDailyHours(slots, 1, resolveSchedulingTimezone("Europe/London")),
    ).toBe(false);
  });
});
