// #503 item 2 — canonical overnight resolution truth-table.
import {
  isNextDayOfWeek,
  localTimesCrossMidnight,
  resolveOvernightStatus,
} from "@/utils/schedule/overnight";
import type { DayOfWeek as DayOfWeekType } from "@prisma/client";

// Value-level mirror — importing the Prisma enum object would drag the
// client into jsdom.
const DayOfWeek = {
  SUNDAY: "SUNDAY",
  MONDAY: "MONDAY",
  TUESDAY: "TUESDAY",
  WEDNESDAY: "WEDNESDAY",
  THURSDAY: "THURSDAY",
  FRIDAY: "FRIDAY",
  SATURDAY: "SATURDAY",
} as const satisfies Record<DayOfWeekType, DayOfWeekType>;

describe("resolveOvernightStatus — day-pair (DB weekly) shape", () => {
  it("same-day pair is not overnight", () => {
    const r = resolveOvernightStatus({
      startDay: DayOfWeek.MONDAY,
      endDay: DayOfWeek.MONDAY,
    });
    expect(r).toEqual({ isOvernight: false, crossesMidnightUtc: false });
  });

  it("next-day pair is overnight", () => {
    const r = resolveOvernightStatus({
      startDay: DayOfWeek.MONDAY,
      endDay: DayOfWeek.TUESDAY,
    });
    expect(r).toEqual({ isOvernight: true, crossesMidnightUtc: true });
  });

  it("week-wrap pair (Saturday → Sunday) is overnight", () => {
    const r = resolveOvernightStatus({
      startDay: DayOfWeek.SATURDAY,
      endDay: DayOfWeek.SUNDAY,
    });
    expect(r.isOvernight).toBe(true);
  });
});

describe("resolveOvernightStatus — UTC-minutes shape", () => {
  it("end after start is not overnight", () => {
    expect(
      resolveOvernightStatus({ startTimeUtc: 600, endTimeUtc: 720 }).isOvernight,
    ).toBe(false);
  });

  it("end before start is overnight (Mon 22:00 → Tue 02:00)", () => {
    expect(
      resolveOvernightStatus({ startTimeUtc: 1320, endTimeUtc: 120 }).isOvernight,
    ).toBe(true);
  });

  it("end at midnight (0) is overnight", () => {
    expect(
      resolveOvernightStatus({ startTimeUtc: 1380, endTimeUtc: 0 }).isOvernight,
    ).toBe(true);
  });

  it("equal start/end (24h wrap) is overnight in minutes-space", () => {
    expect(
      resolveOvernightStatus({ startTimeUtc: 600, endTimeUtc: 600 }).isOvernight,
    ).toBe(true);
  });
});

describe("resolveOvernightStatus — local UI shape", () => {
  it("23:00 → 02:00 crosses local midnight", () => {
    const r = resolveOvernightStatus({ startTime: "23:00", endTime: "02:00" });
    expect(r).toEqual({ isOvernight: true, crossesMidnightUtc: false });
  });

  it("09:00 → 17:00 does not cross", () => {
    expect(
      resolveOvernightStatus({ startTime: "09:00", endTime: "17:00" })
        .isOvernight,
    ).toBe(false);
  });

  it("zero-length local slot is NOT overnight (invalid input, not 24h)", () => {
    expect(
      resolveOvernightStatus({ startTime: "10:00", endTime: "10:00" })
        .isOvernight,
    ).toBe(false);
  });

  it("same-day local times with isOvernightUTC flag are overnight", () => {
    const r = resolveOvernightStatus({
      startTime: "01:00",
      endTime: "05:00",
      isOvernightUTC: true,
    });
    expect(r).toEqual({ isOvernight: true, crossesMidnightUtc: true });
  });

  it("empty strings are not overnight", () => {
    expect(
      resolveOvernightStatus({ startTime: "", endTime: "" }).isOvernight,
    ).toBe(false);
  });
});

describe("localTimesCrossMidnight", () => {
  it.each([
    ["22:30", "01:15", true],
    ["00:00", "23:59", false],
    ["23:59", "00:00", true],
    ["garbage", "10:00", false],
  ])("%s → %s = %s", (start, end, expected) => {
    expect(localTimesCrossMidnight(start, end)).toBe(expected);
  });
});

describe("isNextDayOfWeek", () => {
  it.each([
    [DayOfWeek.MONDAY, DayOfWeek.TUESDAY, true],
    [DayOfWeek.SATURDAY, DayOfWeek.SUNDAY, true],
    [DayOfWeek.SUNDAY, DayOfWeek.MONDAY, true],
    [DayOfWeek.MONDAY, DayOfWeek.WEDNESDAY, false],
    [DayOfWeek.MONDAY, DayOfWeek.MONDAY, false],
  ])("%s → %s = %s", (start, end, expected) => {
    expect(isNextDayOfWeek(start, end)).toBe(expected);
  });
});
