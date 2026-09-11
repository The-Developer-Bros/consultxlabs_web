/**
 * Comprehensive tests for SubscriptionValidationService
 *
 * Covers:
 * - Week key format consistency (Bug A fix verification)
 * - Appointment-per-call counting (Bug B fix verification)
 * - Weekly limit enforcement (Bug C fix verification)
 * - Subscription period boundary validation
 * - generateWeeklyInfo with proposed and existing calls
 * - getAvailableWeeksForSubscription
 * - canScheduleInWeek
 * - Helper functions: getSubscriptionWeek, getSubscriptionType
 * - Edge cases: empty slots, max weeks safety, past weeks
 */

import "./setup";

import {
  SubscriptionValidationService,
  getSubscriptionWeek,
  getSubscriptionType,
} from "@/utils/subscriptionValidation";
import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";
import {
  makeSubscription,
  makeSubscriptionPlan,
  makeMockPrisma,
  makeAppointmentWithSlots,
  makeConsecutiveSlotISOs,
} from "./__mocks__/booking.mockData";

// ─── Test Setup ─────────────────────────────────────────────────────────────

function createService(
  subscriptionOverrides: Record<string, any> = {},
  existingAppointments: any[] = [],
) {
  const subscription = makeSubscription(subscriptionOverrides);
  const mockPrisma = makeMockPrisma(subscription, existingAppointments);
  const service = new SubscriptionValidationService(mockPrisma);
  return { service, mockPrisma, subscription };
}

// ─── Bug A: Week Key Format Consistency ─────────────────────────────────────

describe("Bug A Fix: Week key format consistency", () => {
  it("should use matching key formats for proposed slots and weekly info lookup", async () => {
    const { service } = createService({
      subscriptionPlan: makeSubscriptionPlan({ sessionsPerWeek: 1 }),
    });

    // Propose 2 consecutive slots (1 call) in week of Jan 5
    const proposedSlots = makeConsecutiveSlotISOs(
      "2025-01-06T10:00:00.000Z",
      2,
    );

    const result = await service.validateSubscriptionSlots(
      "sub-1",
      proposedSlots,
    );

    // The proposed call should appear in weeklyInfo
    const weekWithProposed = result.weeklyInfo.find((w) => w.proposedCalls > 0);
    expect(weekWithProposed).toBeDefined();
    expect(weekWithProposed!.proposedCalls).toBe(1);
  });

  it("should enforce proposed slot weekly limits (was broken before fix)", async () => {
    const { service } = createService({
      subscriptionPlan: makeSubscriptionPlan({
        sessionsPerWeek: 1,
        sessionDurationInHours: 1,
      }),
    });

    // Propose 2 calls in the same week (exceeds limit of 1)
    const call1 = makeConsecutiveSlotISOs("2025-01-06T10:00:00.000Z", 2);
    const call2 = makeConsecutiveSlotISOs("2025-01-07T10:00:00.000Z", 2);
    const proposedSlots = [...call1, ...call2];

    const result = await service.validateSubscriptionSlots(
      "sub-1",
      proposedSlots,
    );

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes("exceeds call limit"))).toBe(
      true,
    );
  });
});

// ─── Bug B: Appointment Per-Call Counting ───────────────────────────────────

describe("Bug B Fix: Appointment counting (1 appointment = 1 call)", () => {
  it("should count a 2-slot appointment as 1 call, not 2", async () => {
    const existingAppointments = [
      makeAppointmentWithSlots("apt-1", [
        "2025-01-06T10:00:00.000Z",
        "2025-01-06T10:30:00.000Z",
      ]),
    ];

    const { service } = createService(
      {
        subscriptionPlan: makeSubscriptionPlan({
          sessionsPerWeek: 2,
          sessionDurationInHours: 1,
        }),
      },
      existingAppointments,
    );

    const result = await service.validateSubscriptionSlots("sub-1", []);

    // The week containing Jan 6 should show 1 existing call, not 2.
    // Weeks are scheduling-timezone Sundays (ADR B9) — match the instant.
    const expectedWeekStart = SlotCalculationService.startOfWeekSundayInTz(
      new Date("2025-01-06T10:00:00.000Z"),
    );
    const weekOfJan5 = result.weeklyInfo.find(
      (w) => w.weekStart.getTime() === expectedWeekStart.getTime(),
    );
    expect(weekOfJan5).toBeDefined();
    expect(weekOfJan5!.existingCalls).toBe(1);
  });

  it("should count 2 separate appointments as 2 calls", async () => {
    const existingAppointments = [
      makeAppointmentWithSlots("apt-1", [
        "2025-01-06T10:00:00.000Z",
        "2025-01-06T10:30:00.000Z",
      ]),
      makeAppointmentWithSlots("apt-2", [
        "2025-01-07T10:00:00.000Z",
        "2025-01-07T10:30:00.000Z",
      ]),
    ];

    const { service } = createService(
      {
        subscriptionPlan: makeSubscriptionPlan({
          sessionsPerWeek: 2,
          sessionDurationInHours: 1,
        }),
      },
      existingAppointments,
    );

    const result = await service.validateSubscriptionSlots("sub-1", []);
    expect(result.totalCallsScheduled).toBe(2);
  });

  it("should skip appointments with no slots", async () => {
    const existingAppointments = [
      makeAppointmentWithSlots("apt-1", []), // empty
      makeAppointmentWithSlots("apt-2", ["2025-01-06T10:00:00.000Z"]),
    ];

    const { service } = createService(
      {
        subscriptionPlan: makeSubscriptionPlan({
          sessionsPerWeek: 2,
          sessionDurationInHours: 0.5,
        }),
      },
      existingAppointments,
    );

    const result = await service.validateSubscriptionSlots("sub-1", []);
    expect(result.totalCallsScheduled).toBe(1);
  });

  it("should use earliest slot to determine week for multi-slot appointment", async () => {
    // Appointment spanning Saturday night to Sunday would be tricky
    // but both slots on same day — uses earliest slot
    const existingAppointments = [
      makeAppointmentWithSlots("apt-1", [
        "2025-01-06T14:00:00.000Z",
        "2025-01-06T13:30:00.000Z", // earlier slot listed second
      ]),
    ];

    const { service } = createService(
      {
        subscriptionPlan: makeSubscriptionPlan({
          sessionsPerWeek: 2,
          sessionDurationInHours: 1,
        }),
      },
      existingAppointments,
    );

    const result = await service.validateSubscriptionSlots("sub-1", []);
    // Should use 13:30 (earliest) to determine week.
    // Weeks are scheduling-timezone Sundays (ADR B9) — match the instant.
    const expectedWeekStart = SlotCalculationService.startOfWeekSundayInTz(
      new Date("2025-01-06T13:30:00.000Z"),
    );
    const weekOfJan5 = result.weeklyInfo.find(
      (w) => w.weekStart.getTime() === expectedWeekStart.getTime(),
    );
    expect(weekOfJan5).toBeDefined();
    expect(weekOfJan5!.existingCalls).toBe(1);
  });
});

// ─── Bug C: Weekly Limit Enforcement ────────────────────────────────────────

describe("Bug C Fix: Weekly limit validation actually catches violations", () => {
  it("should reject when existing + proposed exceed weekly limit", async () => {
    // 1 existing appointment + 1 proposed call = 2 calls, limit = 1
    const existingAppointments = [
      makeAppointmentWithSlots("apt-1", [
        "2025-01-06T10:00:00.000Z",
        "2025-01-06T10:30:00.000Z",
      ]),
    ];

    const { service } = createService(
      {
        subscriptionPlan: makeSubscriptionPlan({
          sessionsPerWeek: 1,
          sessionDurationInHours: 1,
        }),
      },
      existingAppointments,
    );

    const proposedSlots = makeConsecutiveSlotISOs(
      "2025-01-07T10:00:00.000Z",
      2,
    );

    const result = await service.validateSubscriptionSlots(
      "sub-1",
      proposedSlots,
    );

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes("exceeds call limit"))).toBe(
      true,
    );
  });

  it("should generate warnings for fully booked weeks", async () => {
    const existingAppointments = [
      makeAppointmentWithSlots("apt-1", [
        "2025-01-06T10:00:00.000Z",
        "2025-01-06T10:30:00.000Z",
      ]),
    ];

    const { service } = createService(
      {
        subscriptionPlan: makeSubscriptionPlan({
          sessionsPerWeek: 1,
          sessionDurationInHours: 1,
        }),
      },
      existingAppointments,
    );

    const result = await service.validateSubscriptionSlots("sub-1", []);
    expect(result.warnings.some((w) => w.includes("fully booked"))).toBe(true);
  });

  it("should pass when calls are within limit", async () => {
    const existingAppointments = [
      makeAppointmentWithSlots("apt-1", [
        "2025-01-06T10:00:00.000Z",
        "2025-01-06T10:30:00.000Z",
      ]),
    ];

    const { service } = createService(
      {
        subscriptionPlan: makeSubscriptionPlan({
          sessionsPerWeek: 2,
          sessionDurationInHours: 1,
        }),
      },
      existingAppointments,
    );

    const proposedSlots = makeConsecutiveSlotISOs(
      "2025-01-07T10:00:00.000Z",
      2,
    );

    const result = await service.validateSubscriptionSlots(
      "sub-1",
      proposedSlots,
    );
    expect(result.isValid).toBe(true);
  });
});

// ─── Subscription Period Validation ─────────────────────────────────────────

describe("Subscription period validation", () => {
  it("should reject slots outside subscription period", async () => {
    const { service } = createService({
      schedulingPeriodStartsAt: new Date("2025-01-06T00:00:00.000Z"),
      schedulingPeriodEndsAt: new Date("2025-02-02T23:59:59.000Z"),
    });

    // Slot before subscription starts
    const result = await service.validateSubscriptionSlots("sub-1", [
      "2025-01-04T10:00:00.000Z",
    ]);

    expect(result.isValid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("outside subscription period")),
    ).toBe(true);
  });

  it("should accept slots within subscription period", async () => {
    const { service } = createService({
      subscriptionPlan: makeSubscriptionPlan({
        sessionsPerWeek: 2,
        sessionDurationInHours: 1,
      }),
    });

    const proposedSlots = makeConsecutiveSlotISOs(
      "2025-01-15T10:00:00.000Z",
      2,
    );

    const result = await service.validateSubscriptionSlots(
      "sub-1",
      proposedSlots,
    );
    expect(
      result.errors.some((e) => e.includes("outside subscription period")),
    ).toBe(false);
  });
});

// ─── Total Call Limit ───────────────────────────────────────────────────────

describe("Total call limit validation", () => {
  it("should set maxTotalCalls based on weeks × sessionsPerWeek", async () => {
    const { service } = createService({
      schedulingPeriodStartsAt: new Date("2025-01-06T00:00:00.000Z"), // Mon
      schedulingPeriodEndsAt: new Date("2025-01-31T23:59:59.000Z"), // Fri
      subscriptionPlan: makeSubscriptionPlan({ sessionsPerWeek: 2 }),
    });

    const result = await service.validateSubscriptionSlots("sub-1", []);
    // 4 weeks × 2 calls = 8
    expect(result.maxTotalCalls).toBe(8);
  });
});

// ─── Subscription Not Found ─────────────────────────────────────────────────

describe("Error handling", () => {
  it("should throw when subscription is not found", async () => {
    const mockPrisma = makeMockPrisma(null);
    const service = new SubscriptionValidationService(mockPrisma);

    await expect(
      service.validateSubscriptionSlots("nonexistent", []),
    ).rejects.toThrow("Subscription not found");
  });
});

// ─── Exclude Appointment IDs ────────────────────────────────────────────────

describe("excludeAppointmentIds", () => {
  it("should exclude specified appointment IDs from existing count", async () => {
    const existingAppointments = [
      makeAppointmentWithSlots("apt-1", ["2025-01-06T10:00:00.000Z"]),
    ];

    const { service, mockPrisma } = createService(
      {
        subscriptionPlan: makeSubscriptionPlan({
          sessionsPerWeek: 1,
          sessionDurationInHours: 0.5,
        }),
      },
      existingAppointments,
    );

    // When we exclude apt-1, it should pass the findMany with notIn filter
    await service.validateSubscriptionSlots("sub-1", [], ["apt-1"]);
    expect(mockPrisma.appointment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { notIn: ["apt-1"] },
        }),
      }),
    );
  });
});

// ─── Weekly Info Generation ─────────────────────────────────────────────────

describe("Weekly info generation", () => {
  it("should generate one entry per week in subscription period", async () => {
    const { service } = createService({
      schedulingPeriodStartsAt: new Date("2025-01-06T00:00:00.000Z"),
      schedulingPeriodEndsAt: new Date("2025-01-31T23:59:59.000Z"),
      subscriptionPlan: makeSubscriptionPlan({ sessionsPerWeek: 2 }),
    });

    const result = await service.validateSubscriptionSlots("sub-1", []);
    // 4 weeks expected
    expect(result.weeklyInfo.length).toBe(4);
  });

  it("should correctly populate weekStart and weekEnd", async () => {
    // Use Tue-Fri to stay within a single Sun-Sat week in all timezones
    // (Jan 12 23:59 UTC = Jan 13 in positive-offset TZs, crossing into next week)
    const { service } = createService({
      schedulingPeriodStartsAt: new Date("2025-01-07T00:00:00.000Z"), // Tue
      schedulingPeriodEndsAt: new Date("2025-01-10T23:59:59.000Z"), // Fri
      subscriptionPlan: makeSubscriptionPlan({ sessionsPerWeek: 1 }),
    });

    const result = await service.validateSubscriptionSlots("sub-1", []);
    expect(result.weeklyInfo.length).toBe(1);
    // weekStart is Sunday 00:00 in the SCHEDULING timezone (ADR B9) — assert
    // via Intl, not local getDay(), so the test passes on any CI timezone.
    const weekdayInSchedulingTz = new Intl.DateTimeFormat("en-US", {
      timeZone: SlotCalculationService.DEFAULT_SCHEDULING_TIMEZONE,
      weekday: "short",
    }).format(result.weeklyInfo[0].weekStart);
    expect(weekdayInSchedulingTz).toBe("Sun");
    expect(result.weeklyInfo[0].maxCalls).toBe(1);
  });

  it("should set canScheduleMore = false for past weeks", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2025-02-15T12:00:00.000Z"));

    const { service } = createService({
      schedulingPeriodStartsAt: new Date("2025-01-06T00:00:00.000Z"),
      schedulingPeriodEndsAt: new Date("2025-02-02T23:59:59.000Z"),
      subscriptionPlan: makeSubscriptionPlan({ sessionsPerWeek: 1 }),
    });

    const result = await service.validateSubscriptionSlots("sub-1", []);
    // All weeks should be past
    result.weeklyInfo.forEach((week) => {
      expect(week.canScheduleMore).toBe(false);
      expect(week.availableSlots).toBe(0);
    });

    jest.useRealTimers();
  });
});

// ─── Incomplete Proposed Calls ──────────────────────────────────────────────

describe("Incomplete proposed calls", () => {
  it("should not count incomplete slot group as a proposed call", async () => {
    const { service } = createService({
      subscriptionPlan: makeSubscriptionPlan({
        sessionsPerWeek: 2,
        sessionDurationInHours: 1, // requires 2 consecutive slots
      }),
    });

    // Only 1 slot — incomplete call
    const result = await service.validateSubscriptionSlots("sub-1", [
      "2025-01-06T10:00:00.000Z",
    ]);

    const weekWithProposed = result.weeklyInfo.find((w) => w.proposedCalls > 0);
    expect(weekWithProposed).toBeUndefined();
  });

  it("should not count non-consecutive slots as a proposed call", async () => {
    const { service } = createService({
      subscriptionPlan: makeSubscriptionPlan({
        sessionsPerWeek: 2,
        sessionDurationInHours: 1,
      }),
    });

    // 2 slots but not consecutive (1 hour gap)
    const result = await service.validateSubscriptionSlots("sub-1", [
      "2025-01-06T10:00:00.000Z",
      "2025-01-06T11:00:00.000Z",
    ]);

    const weekWithProposed = result.weeklyInfo.find((w) => w.proposedCalls > 0);
    expect(weekWithProposed).toBeUndefined();
  });
});

// ─── getAvailableWeeksForSubscription ───────────────────────────────────────

describe("getAvailableWeeksForSubscription", () => {
  it("should return only weeks that can accept more calls", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2025-01-05T12:00:00.000Z"));

    const existingAppointments = [
      makeAppointmentWithSlots("apt-1", [
        "2025-01-06T10:00:00.000Z",
        "2025-01-06T10:30:00.000Z",
      ]),
    ];

    const { service } = createService(
      {
        subscriptionPlan: makeSubscriptionPlan({
          sessionsPerWeek: 1,
          sessionDurationInHours: 1,
        }),
      },
      existingAppointments,
    );

    const availableWeeks =
      await service.getAvailableWeeksForSubscription("sub-1");
    // Week 1 (Jan 5-11) is full (1/1), other future weeks should be available
    const fullWeek = availableWeeks.find(
      (w) =>
        w.weekStart.getTime() ===
        new Date("2025-01-05T00:00:00.000Z").getTime(),
    );
    expect(fullWeek).toBeUndefined();

    jest.useRealTimers();
  });
});

// ─── canScheduleInWeek ──────────────────────────────────────────────────────

describe("canScheduleInWeek", () => {
  it("should return true when week has available slots", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2025-01-05T12:00:00.000Z"));

    const { service } = createService({
      subscriptionPlan: makeSubscriptionPlan({
        sessionsPerWeek: 2,
        sessionDurationInHours: 1,
      }),
    });

    const canSchedule = await service.canScheduleInWeek(
      "sub-1",
      new Date("2025-01-06"), // week of Jan 5
    );
    expect(canSchedule).toBe(true);

    jest.useRealTimers();
  });

  it("should return false when week is full", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2025-01-05T12:00:00.000Z"));

    const existingAppointments = [
      makeAppointmentWithSlots("apt-1", [
        "2025-01-06T10:00:00.000Z",
        "2025-01-06T10:30:00.000Z",
      ]),
    ];

    const { service } = createService(
      {
        subscriptionPlan: makeSubscriptionPlan({
          sessionsPerWeek: 1,
          sessionDurationInHours: 1,
        }),
      },
      existingAppointments,
    );

    const canSchedule = await service.canScheduleInWeek(
      "sub-1",
      new Date("2025-01-06"),
    );
    expect(canSchedule).toBe(false);

    jest.useRealTimers();
  });

  it("should return false for a date outside subscription period", async () => {
    const { service } = createService();

    const canSchedule = await service.canScheduleInWeek(
      "sub-1",
      new Date("2025-06-01"), // way outside period
    );
    expect(canSchedule).toBe(false);
  });
});

// ─── Helper: getSubscriptionWeek ────────────────────────────────────────────

describe("getSubscriptionWeek", () => {
  it("should return 1 for the first week", () => {
    const result = getSubscriptionWeek(
      new Date("2025-01-06"), // Monday
      new Date("2025-01-06"), // Subscription starts Monday
    );
    expect(result).toBe(1);
  });

  it("should return 2 for the second week", () => {
    const result = getSubscriptionWeek(
      new Date("2025-01-13"), // Next Monday
      new Date("2025-01-06"),
    );
    expect(result).toBe(2);
  });

  it("should handle dates in the same week as start", () => {
    const result = getSubscriptionWeek(
      new Date("2025-01-10"), // Friday of first week
      new Date("2025-01-06"), // Monday start
    );
    expect(result).toBe(1);
  });
});

// ─── Helper: getSubscriptionType ────────────────────────────────────────────

describe("getSubscriptionType", () => {
  it('should return "Basic" for 1 call/week, 1 month', () => {
    expect(getSubscriptionType(1, 1)).toBe("Basic");
  });

  it('should return "Extended" for 2 calls/week, 2 months', () => {
    expect(getSubscriptionType(2, 2)).toBe("Extended");
  });

  it('should return "Comprehensive" for 3 calls/week, 6 months', () => {
    expect(getSubscriptionType(3, 6)).toBe("Comprehensive");
  });

  it('should return "Custom" for non-standard combinations', () => {
    expect(getSubscriptionType(4, 3)).toBe("Custom");
    expect(getSubscriptionType(1, 2)).toBe("Custom");
    expect(getSubscriptionType(2, 1)).toBe("Custom");
  });
});

// ─── Tolerance in Proposed Slot Checking ────────────────────────────────────

describe("Slot consecutiveness tolerance", () => {
  it("should accept slots with sub-second precision difference", async () => {
    const { service } = createService({
      subscriptionPlan: makeSubscriptionPlan({
        sessionsPerWeek: 2,
        sessionDurationInHours: 1,
      }),
    });

    // Slots with 500ms offset (within 1-second tolerance)
    const result = await service.validateSubscriptionSlots("sub-1", [
      "2025-01-06T10:00:00.000Z",
      "2025-01-06T10:30:00.500Z",
    ]);

    const weekWithProposed = result.weeklyInfo.find((w) => w.proposedCalls > 0);
    expect(weekWithProposed).toBeDefined();
    expect(weekWithProposed!.proposedCalls).toBe(1);
  });
});

// ─── Valid Complete Submission ───────────────────────────────────────────────

describe("Valid complete submission", () => {
  it("should validate a well-formed proposed schedule", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2025-01-05T00:00:00.000Z"));

    const { service } = createService({
      schedulingPeriodStartsAt: new Date("2025-01-06T00:00:00.000Z"),
      schedulingPeriodEndsAt: new Date("2025-02-02T23:59:59.000Z"),
      subscriptionPlan: makeSubscriptionPlan({
        sessionsPerWeek: 1,
        sessionDurationInHours: 1,
      }),
    });

    // 1 call per week × 4 weeks = 4 calls, each 2 consecutive slots
    const proposedSlots = [
      ...makeConsecutiveSlotISOs("2025-01-06T10:00:00.000Z", 2), // Week 1
      ...makeConsecutiveSlotISOs("2025-01-13T10:00:00.000Z", 2), // Week 2
      ...makeConsecutiveSlotISOs("2025-01-20T10:00:00.000Z", 2), // Week 3
      ...makeConsecutiveSlotISOs("2025-01-27T10:00:00.000Z", 2), // Week 4
    ];

    const result = await service.validateSubscriptionSlots(
      "sub-1",
      proposedSlots,
    );
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);

    jest.useRealTimers();
  });
});
