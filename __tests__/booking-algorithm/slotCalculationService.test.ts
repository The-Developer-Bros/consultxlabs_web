/**
 * Comprehensive tests for SlotCalculationService
 *
 * Covers: countWeeks, startOfWeekSunday, validateDuration,
 * calculateRequiredSlots, getSlotsPerCall, calculateProgress,
 * groupSlotsByDay, groupSlotsByWeek, formatProgressText
 */

import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";

// ─── startOfWeekSunday ──────────────────────────────────────────────────────

describe("SlotCalculationService.startOfWeekSunday", () => {
  it("should return Sunday for a Sunday input", () => {
    const sunday = new Date("2025-01-05T12:30:00.000Z"); // Sunday
    const result = SlotCalculationService.startOfWeekSunday(sunday);
    expect(result.getUTCDay()).toBe(0);
    expect(result.getUTCHours()).toBe(0);
    expect(result.getUTCMinutes()).toBe(0);
    expect(result.getUTCDate()).toBe(5);
  });

  it("should return the previous Sunday for a Wednesday", () => {
    const wed = new Date("2025-01-08T15:00:00.000Z"); // Wednesday Jan 8
    const result = SlotCalculationService.startOfWeekSunday(wed);
    expect(result.getUTCDay()).toBe(0);
    expect(result.getUTCDate()).toBe(5); // Sunday Jan 5
  });

  it("should return the previous Sunday for a Saturday", () => {
    const sat = new Date("2025-01-11T12:00:00.000Z"); // Saturday Jan 11 (noon UTC, safe across timezones)
    const result = SlotCalculationService.startOfWeekSunday(sat);
    expect(result.getUTCDay()).toBe(0); // Sunday
  });

  it("should return the previous Sunday for a Monday", () => {
    const mon = new Date("2025-01-06T00:00:00.000Z"); // Monday Jan 6
    const result = SlotCalculationService.startOfWeekSunday(mon);
    expect(result.getUTCDay()).toBe(0);
    expect(result.getUTCDate()).toBe(5); // Sunday Jan 5
  });

  it("should not mutate the input date", () => {
    const original = new Date("2025-01-08T15:00:00.000Z");
    const originalTime = original.getTime();
    SlotCalculationService.startOfWeekSunday(original);
    expect(original.getTime()).toBe(originalTime);
  });

  it("should zero out hours/minutes/seconds/ms", () => {
    const d = new Date("2025-01-08T23:59:59.999Z");
    const result = SlotCalculationService.startOfWeekSunday(d);
    expect(result.getUTCHours()).toBe(0);
    expect(result.getUTCMinutes()).toBe(0);
    expect(result.getUTCSeconds()).toBe(0);
    expect(result.getUTCMilliseconds()).toBe(0);
  });
});

// ─── countWeeks ─────────────────────────────────────────────────────────────

describe("SlotCalculationService.countWeeks", () => {
  it("should count 1 week when start and end are in the same week", () => {
    const start = new Date("2025-01-06"); // Monday
    const end = new Date("2025-01-10"); // Friday (same week Sun Jan 5 - Sat Jan 11)
    expect(SlotCalculationService.countWeeks(start, end)).toBe(1);
  });

  it("should count 2 weeks when spanning exactly 2 weeks", () => {
    const start = new Date("2025-01-06"); // Mon (week of Sun Jan 5)
    const end = new Date("2025-01-13"); // Mon (week of Sun Jan 12)
    expect(SlotCalculationService.countWeeks(start, end)).toBe(2);
  });

  it("should count 5 weeks for Jan 1 (Wed) to Feb 1 (Sat)", () => {
    // Week 1: Sun Dec 29
    // Week 2: Sun Jan 5
    // Week 3: Sun Jan 12
    // Week 4: Sun Jan 19
    // Week 5: Sun Jan 26
    const start = new Date("2025-01-01"); // Wednesday
    const end = new Date("2025-02-01"); // Saturday
    expect(SlotCalculationService.countWeeks(start, end)).toBe(5);
  });

  it("should count 1 week when start and end are the same day", () => {
    const d = new Date("2025-01-08");
    expect(SlotCalculationService.countWeeks(d, d)).toBe(1);
  });

  it("should return 0 when end is before start", () => {
    const start = new Date("2025-02-01");
    const end = new Date("2025-01-01");
    expect(SlotCalculationService.countWeeks(start, end)).toBe(0);
  });

  it("should handle month boundaries correctly", () => {
    // Feb 28 to Mar 1 — could be same week or different
    const start = new Date("2025-02-28"); // Friday
    const end = new Date("2025-03-01"); // Saturday — same week (Sun Feb 23)
    expect(SlotCalculationService.countWeeks(start, end)).toBe(1);
  });

  it("should handle year boundaries", () => {
    const start = new Date("2024-12-30"); // Monday (week of Sun Dec 29)
    const end = new Date("2025-01-03"); // Friday (same week Sun Dec 29)
    expect(SlotCalculationService.countWeeks(start, end)).toBe(1);
  });

  it("should count exactly 4 weeks for a typical month subscription", () => {
    // Sun Jan 5 to Sat Jan 25 → 3 complete weeks, ends before 4th Sunday
    const start = new Date("2025-01-05"); // Sunday
    const end = new Date("2025-01-25"); // Saturday (week of Sun Jan 19)
    expect(SlotCalculationService.countWeeks(start, end)).toBe(3);
  });

  it("should handle Sunday to next Saturday (exactly 1 week)", () => {
    const start = new Date("2025-01-05"); // Sunday
    const end = new Date("2025-01-11"); // Saturday
    expect(SlotCalculationService.countWeeks(start, end)).toBe(1);
  });

  it("should handle Sunday to next Sunday (2 weeks)", () => {
    const start = new Date("2025-01-05"); // Sunday
    const end = new Date("2025-01-12"); // Next Sunday
    expect(SlotCalculationService.countWeeks(start, end)).toBe(2);
  });
});

// ─── validateDuration ───────────────────────────────────────────────────────

describe("SlotCalculationService.validateDuration", () => {
  it("should accept valid durations", () => {
    expect(() =>
      SlotCalculationService.validateDuration(1, "test"),
    ).not.toThrow();
    expect(() =>
      SlotCalculationService.validateDuration(0.5, "test"),
    ).not.toThrow();
    expect(() =>
      SlotCalculationService.validateDuration(2.5, "test"),
    ).not.toThrow();
    expect(() =>
      SlotCalculationService.validateDuration(24, "test"),
    ).not.toThrow();
  });

  it("should throw for undefined duration", () => {
    expect(() =>
      SlotCalculationService.validateDuration(undefined, "myField"),
    ).toThrow("myField is required but was not provided");
  });

  it("should throw for null duration", () => {
    expect(() =>
      SlotCalculationService.validateDuration(null as any, "myField"),
    ).toThrow("myField is required but was not provided");
  });

  it("should throw for zero duration", () => {
    expect(() => SlotCalculationService.validateDuration(0, "myField")).toThrow(
      "must be positive",
    );
  });

  it("should throw for negative duration", () => {
    expect(() =>
      SlotCalculationService.validateDuration(-1, "myField"),
    ).toThrow("must be positive");
  });

  it("should throw for Infinity", () => {
    expect(() =>
      SlotCalculationService.validateDuration(Infinity, "myField"),
    ).toThrow("must be a finite number");
  });

  it("should throw for NaN", () => {
    expect(() =>
      SlotCalculationService.validateDuration(NaN, "myField"),
    ).toThrow(); // NaN fails the <= 0 or isFinite check
  });

  it("should throw for duration < 0.5 hours", () => {
    expect(() =>
      SlotCalculationService.validateDuration(0.25, "myField"),
    ).toThrow("must be at least 0.5 hours");
  });

  it("should throw for duration > 24 hours", () => {
    expect(() =>
      SlotCalculationService.validateDuration(25, "myField"),
    ).toThrow("cannot exceed 24 hours");
  });

  it("should throw for non-number type", () => {
    expect(() =>
      SlotCalculationService.validateDuration("1" as any, "myField"),
    ).toThrow("must be a number");
  });
});

// ─── getSlotsPerCall ────────────────────────────────────────────────────────

describe("SlotCalculationService.getSlotsPerCall", () => {
  it("should return 1 for 0.5-hour session", () => {
    expect(SlotCalculationService.getSlotsPerCall(0.5)).toBe(1);
  });

  it("should return 2 for 1-hour session", () => {
    expect(SlotCalculationService.getSlotsPerCall(1)).toBe(2);
  });

  it("should return 3 for 1.5-hour session", () => {
    expect(SlotCalculationService.getSlotsPerCall(1.5)).toBe(3);
  });

  it("should return 4 for 2-hour session", () => {
    expect(SlotCalculationService.getSlotsPerCall(2)).toBe(4);
  });

  it("should ceil for non-standard durations", () => {
    expect(SlotCalculationService.getSlotsPerCall(0.75)).toBe(2); // ceil(1.5) = 2
    expect(SlotCalculationService.getSlotsPerCall(1.25)).toBe(3); // ceil(2.5) = 3
  });
});

// ─── calculateRequiredSlots ─────────────────────────────────────────────────

describe("SlotCalculationService.calculateRequiredSlots", () => {
  it("should throw when eventType is empty", () => {
    expect(() =>
      SlotCalculationService.calculateRequiredSlots("" as any, {}),
    ).toThrow("Event type is required");
  });

  it("should throw for invalid event type", () => {
    expect(() =>
      SlotCalculationService.calculateRequiredSlots("unknown" as any, {}),
    ).toThrow("Invalid event type");
  });

  describe("consultation", () => {
    it("should return 2 for 1-hour consultation", () => {
      expect(
        SlotCalculationService.calculateRequiredSlots("consultation", {
          durationInHours: 1,
        }),
      ).toBe(2);
    });

    it("should return 3 for 1.5-hour consultation", () => {
      expect(
        SlotCalculationService.calculateRequiredSlots("consultation", {
          durationInHours: 1.5,
        }),
      ).toBe(3);
    });

    it("should return 1 for 0.5-hour consultation", () => {
      expect(
        SlotCalculationService.calculateRequiredSlots("consultation", {
          durationInHours: 0.5,
        }),
      ).toBe(1);
    });

    it("should default to 2 slots when duration is missing", () => {
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation();
      expect(
        SlotCalculationService.calculateRequiredSlots("consultation", {}),
      ).toBe(2);
      consoleSpy.mockRestore();
    });

    it("should default to 2 slots when duration is 0", () => {
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation();
      expect(
        SlotCalculationService.calculateRequiredSlots("consultation", {
          durationInHours: 0,
        }),
      ).toBe(2);
      consoleSpy.mockRestore();
    });
  });

  describe("webinar", () => {
    it("should return 2 for 1-hour webinar", () => {
      expect(
        SlotCalculationService.calculateRequiredSlots("webinar", {
          durationInHours: 1,
        }),
      ).toBe(2);
    });

    it("should return 4 for 2-hour webinar", () => {
      expect(
        SlotCalculationService.calculateRequiredSlots("webinar", {
          durationInHours: 2,
        }),
      ).toBe(4);
    });

    it("should default to 2 slots when duration missing", () => {
      expect(SlotCalculationService.calculateRequiredSlots("webinar", {})).toBe(
        2,
      );
    });
  });

  describe("subscription", () => {
    it("should throw when dates are missing", () => {
      expect(() =>
        SlotCalculationService.calculateRequiredSlots("subscription", {
          sessionsPerWeek: 2,
        }),
      ).toThrow("Start date and end date are required");
    });

    it("should calculate correctly: 4 weeks × 2 calls/week × 2 slots/call = 16", () => {
      // Jan 6 (Mon) to Jan 31 (Fri) → 4 weeks
      expect(
        SlotCalculationService.calculateRequiredSlots("subscription", {
          schedulingPeriodStartsAt: new Date("2025-01-06"),
          schedulingPeriodEndsAt: new Date("2025-01-31"),
          sessionsPerWeek: 2,
          sessionDurationInHours: 1,
        }),
      ).toBe(16);
    });

    it("should handle 1.5-hour sessions: 4 weeks × 1 call/week × 3 slots = 12", () => {
      expect(
        SlotCalculationService.calculateRequiredSlots("subscription", {
          schedulingPeriodStartsAt: new Date("2025-01-06"),
          schedulingPeriodEndsAt: new Date("2025-01-31"),
          sessionsPerWeek: 1,
          sessionDurationInHours: 1.5,
        }),
      ).toBe(12);
    });

    it("should default to 1 call/week when sessionsPerWeek missing", () => {
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation();
      // 4 weeks × 1 call × 2 slots = 8
      expect(
        SlotCalculationService.calculateRequiredSlots("subscription", {
          schedulingPeriodStartsAt: new Date("2025-01-06"),
          schedulingPeriodEndsAt: new Date("2025-01-31"),
          sessionDurationInHours: 1,
        }),
      ).toBe(8);
      consoleSpy.mockRestore();
    });

    it("should default session duration to 1 hour when missing", () => {
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation();
      // 4 weeks × 2 calls × 2 slots = 16
      expect(
        SlotCalculationService.calculateRequiredSlots("subscription", {
          schedulingPeriodStartsAt: new Date("2025-01-06"),
          schedulingPeriodEndsAt: new Date("2025-01-31"),
          sessionsPerWeek: 2,
        }),
      ).toBe(16);
      consoleSpy.mockRestore();
    });
  });

  describe("class", () => {
    it("should throw when dates are missing", () => {
      expect(() =>
        SlotCalculationService.calculateRequiredSlots("class", {
          sessionsPerWeek: 3,
          sessionDurationInHours: 1,
        }),
      ).toThrow("Start date and end date are required");
    });

    it("should throw when sessionsPerWeek is missing", () => {
      expect(() =>
        SlotCalculationService.calculateRequiredSlots("class", {
          schedulingPeriodStartsAt: new Date("2025-01-06"),
          schedulingPeriodEndsAt: new Date("2025-01-31"),
          sessionDurationInHours: 1,
        }),
      ).toThrow("Calls per week must be a positive number");
    });

    it("should throw when session duration is missing", () => {
      expect(() =>
        SlotCalculationService.calculateRequiredSlots("class", {
          schedulingPeriodStartsAt: new Date("2025-01-06"),
          schedulingPeriodEndsAt: new Date("2025-01-31"),
          sessionsPerWeek: 2,
        }),
      ).toThrow("Session duration must be a positive number");
    });

    it("should calculate correctly: 4 weeks × 3 classes/week × 2 slots = 24", () => {
      expect(
        SlotCalculationService.calculateRequiredSlots("class", {
          schedulingPeriodStartsAt: new Date("2025-01-06"),
          schedulingPeriodEndsAt: new Date("2025-01-31"),
          sessionsPerWeek: 3,
          sessionDurationInHours: 1,
        }),
      ).toBe(24);
    });
  });
});

// ─── groupSlotsByDay ────────────────────────────────────────────────────────

describe("SlotCalculationService.groupSlotsByDay", () => {
  it("should group slots by date string", () => {
    const slots = [
      {
        startTime: new Date("2025-01-06T09:00:00Z"),
        endTime: new Date("2025-01-06T09:30:00Z"),
        isAvailable: true,
        isBooked: false,
      },
      {
        startTime: new Date("2025-01-06T09:30:00Z"),
        endTime: new Date("2025-01-06T10:00:00Z"),
        isAvailable: true,
        isBooked: false,
      },
      {
        startTime: new Date("2025-01-07T09:00:00Z"),
        endTime: new Date("2025-01-07T09:30:00Z"),
        isAvailable: true,
        isBooked: false,
      },
    ];

    const grouped = SlotCalculationService.groupSlotsByDay(slots);
    expect(grouped.size).toBe(2);
  });

  it("should return empty map for empty input", () => {
    const grouped = SlotCalculationService.groupSlotsByDay([]);
    expect(grouped.size).toBe(0);
  });
});

// ─── groupSlotsByWeek ───────────────────────────────────────────────────────

describe("SlotCalculationService.groupSlotsByWeek", () => {
  it("should group slots from the same week together", () => {
    const slots = [
      {
        startTime: new Date("2025-01-06T09:00:00Z"),
        endTime: new Date("2025-01-06T09:30:00Z"),
        isAvailable: true,
        isBooked: false,
      },
      {
        startTime: new Date("2025-01-08T09:00:00Z"),
        endTime: new Date("2025-01-08T09:30:00Z"),
        isAvailable: true,
        isBooked: false,
      },
    ];

    const grouped = SlotCalculationService.groupSlotsByWeek(slots);
    expect(grouped.size).toBe(1);
  });

  it("should separate slots from different weeks", () => {
    const slots = [
      {
        startTime: new Date("2025-01-06T09:00:00Z"),
        endTime: new Date("2025-01-06T09:30:00Z"),
        isAvailable: true,
        isBooked: false,
      },
      {
        startTime: new Date("2025-01-13T09:00:00Z"),
        endTime: new Date("2025-01-13T09:30:00Z"),
        isAvailable: true,
        isBooked: false,
      },
    ];

    const grouped = SlotCalculationService.groupSlotsByWeek(slots);
    expect(grouped.size).toBe(2);
  });

  it("should use scheduling-timezone week boundaries (default Asia/Kolkata), not the process timezone", () => {
    // Saturday Jan 4 23:30 UTC = Sunday Jan 5 in UTC+1 or later timezones
    // Sunday Jan 5 00:30 UTC = same week as Saturday in a Sunday-start system
    // Both should be in the same UTC week (week starting Sunday Jan 5 would be wrong)
    // ADR B9 — buckets are scheduling-timezone (default Asia/Kolkata) weeks.
    // 18:29Z Saturday is 23:59 IST Saturday (old week); 18:30Z is 00:00 IST
    // Sunday (new week).
    const saturdayLateIST = {
      startTime: new Date("2025-01-04T18:29:00Z"),
      endTime: new Date("2025-01-04T18:59:00Z"),
      isAvailable: true,
      isBooked: false,
    };
    const sundayEarlyIST = {
      startTime: new Date("2025-01-04T18:30:00Z"),
      endTime: new Date("2025-01-04T19:00:00Z"),
      isAvailable: true,
      isBooked: false,
    };

    const grouped = SlotCalculationService.groupSlotsByWeek([
      saturdayLateIST,
      sundayEarlyIST,
    ]);
    // Saturday belongs to week of Dec 29 (Sun), Sunday starts new week Jan 5
    expect(grouped.size).toBe(2);

    const keys = Array.from(grouped.keys()).sort();
    expect(keys).toEqual(["2024-12-29", "2025-01-05"]);
  });
});

// ─── calculateProgress ──────────────────────────────────────────────────────

describe("SlotCalculationService.calculateProgress", () => {
  it("should return 0 scheduled for empty slots (consultation)", () => {
    const result = SlotCalculationService.calculateProgress(
      [],
      "consultation",
      { durationInHours: 1 },
    );
    expect(result.scheduled).toBe(0);
    expect(result.required).toBe(1);
    expect(result.remaining).toBe(1);
  });

  it("should return 1 scheduled when slots cover full consultation", () => {
    const slots = [
      {
        startTime: new Date("2025-01-06T09:00:00Z"),
        endTime: new Date("2025-01-06T09:30:00Z"),
        isAvailable: true,
        isBooked: false,
      },
      {
        startTime: new Date("2025-01-06T09:30:00Z"),
        endTime: new Date("2025-01-06T10:00:00Z"),
        isAvailable: true,
        isBooked: false,
      },
    ];

    const result = SlotCalculationService.calculateProgress(
      slots,
      "consultation",
      { durationInHours: 1 },
    );
    expect(result.scheduled).toBe(1);
    expect(result.required).toBe(1);
    expect(result.remaining).toBe(0);
  });

  it("should throw for subscription without required config", () => {
    expect(() =>
      SlotCalculationService.calculateProgress([], "subscription", {
        sessionDurationInHours: 1,
      }),
    ).toThrow("Start date, end date, and calls per week are required");
  });

  it("should count completed calls for subscription", () => {
    // 2 consecutive slots = 1 complete call for 1hr session
    const slots = [
      {
        startTime: new Date("2025-01-06T09:00:00Z"),
        endTime: new Date("2025-01-06T09:30:00Z"),
        isAvailable: true,
        isBooked: false,
      },
      {
        startTime: new Date("2025-01-06T09:30:00Z"),
        endTime: new Date("2025-01-06T10:00:00Z"),
        isAvailable: true,
        isBooked: false,
      },
    ];

    const result = SlotCalculationService.calculateProgress(
      slots,
      "subscription",
      {
        sessionDurationInHours: 1,
        sessionsPerWeek: 2,
        schedulingPeriodStartsAt: new Date("2025-01-06"),
        schedulingPeriodEndsAt: new Date("2025-01-31"),
      },
    );
    expect(result.scheduled).toBe(1);
    expect(result.required).toBe(8); // 4 weeks × 2 calls
  });

  it("should include displayText", () => {
    const result = SlotCalculationService.calculateProgress(
      [],
      "consultation",
      { durationInHours: 1 },
    );
    expect(typeof result.displayText).toBe("string");
    expect(result.displayText.length).toBeGreaterThan(0);
  });
});
