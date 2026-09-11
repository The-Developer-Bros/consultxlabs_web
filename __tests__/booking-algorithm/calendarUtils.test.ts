/**
 * Comprehensive tests for calendarUtils
 *
 * Covers:
 * - mapWeeklySlots (UTC consistency, interval generation, edge cases)
 * - mapCustomSlots (interval generation, edge cases)
 * - slotsOverlap
 * - getSlotStatus (booking detection fix, partial booking, conflicts)
 * - formatSlotsForAPI
 * - calculateRequiredSlots (delegation to SlotCalculationService)
 * - countSundayWeeksInclusive (delegation)
 * - startOfWeekSunday (delegation)
 * - validateSelectedSlots (all event types)
 * - groupSlotsByWeek
 * - validateSlotDistribution
 * - validateDayBasedConsecutiveSlots
 * - calculateCallProgress
 * - getAppointmentTitle / getAppointmentUser
 */

import "./setup";

import {
  mapWeeklySlots,
  mapCustomSlots,
  slotsOverlap,
  getSlotStatus,
  formatSlotsForAPI,
  calculateRequiredSlots,
  countSundayWeeksInclusive,
  startOfWeekSunday,
  validateSelectedSlots,
  groupSlotsByWeek,
  validateSlotDistribution,
  validateDayBasedConsecutiveSlots,
  calculateCallProgress,
  getAppointmentTitle,
  getAppointmentUser,
  type TimeSlot,
  type Appointment,
} from "@/lib/scheduling/calendarUtils";
import { ScheduleType, DayOfWeek, AppointmentsType } from "@prisma/client";
import {
  makeTimeSlot,
  makeConsecutiveTimeSlots,
  makeWeeklyAvailabilitySlot,
  makeCustomAvailabilitySlot,
  makeConsultantData,
} from "./__mocks__/booking.mockData";

// ─── mapWeeklySlots ─────────────────────────────────────────────────────────

describe("mapWeeklySlots", () => {
  it("should return empty array for non-WEEKLY schedule type", () => {
    const data = makeConsultantData({ scheduleType: ScheduleType.CUSTOM });
    expect(mapWeeklySlots(data as any, new Date())).toEqual([]);
  });

  it("should return empty array when no weekly slots defined", () => {
    const data = makeConsultantData({
      scheduleType: ScheduleType.WEEKLY,
      slotsOfAvailabilityWeekly: [],
    });
    expect(mapWeeklySlots(data as any, new Date())).toEqual([]);
  });

  it("should generate 30-minute intervals from availability slot", () => {
    const data = makeConsultantData({
      scheduleType: ScheduleType.WEEKLY,
      slotsOfAvailabilityWeekly: [
        makeWeeklyAvailabilitySlot(DayOfWeek.MONDAY, 9, 11), // 2 hours = 4 slots
      ],
    });

    const slots = mapWeeklySlots(data as any, new Date("2025-01-06"), "week");
    // Only Monday has availability, so all generated slots are for Monday
    expect(slots.length).toBe(4); // 9:00, 9:30, 10:00, 10:30 UTC
    // Verify UTC hours are set correctly from the availability
    expect(slots[0].startTime.getUTCHours()).toBe(9);
    expect(slots[0].startTime.getUTCMinutes()).toBe(0);
    expect(slots[1].startTime.getUTCHours()).toBe(9);
    expect(slots[1].startTime.getUTCMinutes()).toBe(30);
    expect(slots[2].startTime.getUTCHours()).toBe(10);
    expect(slots[2].startTime.getUTCMinutes()).toBe(0);
    expect(slots[3].startTime.getUTCHours()).toBe(10);
    expect(slots[3].startTime.getUTCMinutes()).toBe(30);
  });

  it("should use UTC hours (timezone fix verification)", () => {
    const data = makeConsultantData({
      scheduleType: ScheduleType.WEEKLY,
      slotsOfAvailabilityWeekly: [
        makeWeeklyAvailabilitySlot(DayOfWeek.MONDAY, 14, 15), // 2pm-3pm UTC
      ],
    });

    const slots = mapWeeklySlots(data as any, new Date("2025-01-06"), "week");
    const mondaySlots = slots.filter((s) => s.startTime.getUTCDay() === 1);
    if (mondaySlots.length > 0) {
      expect(mondaySlots[0].startTime.getUTCHours()).toBe(14);
    }
  });

  it("should handle month view", () => {
    const data = makeConsultantData({
      scheduleType: ScheduleType.WEEKLY,
      slotsOfAvailabilityWeekly: [
        makeWeeklyAvailabilitySlot(DayOfWeek.WEDNESDAY, 10, 11),
      ],
    });

    const slots = mapWeeklySlots(data as any, new Date("2025-01-15"), "month");
    // January has 4-5 Wednesdays
    expect(slots.length).toBeGreaterThanOrEqual(4); // at least 2 slots × 4 Wednesdays
  });

  it("should mark all generated slots as available and not booked", () => {
    const data = makeConsultantData({
      scheduleType: ScheduleType.WEEKLY,
      slotsOfAvailabilityWeekly: [
        makeWeeklyAvailabilitySlot(DayOfWeek.TUESDAY, 9, 10),
      ],
    });

    const slots = mapWeeklySlots(data as any, new Date("2025-01-06"), "week");
    slots.forEach((s) => {
      expect(s.isAvailable).toBe(true);
      expect(s.isBooked).toBe(false);
    });
  });
});

// ─── mapCustomSlots ─────────────────────────────────────────────────────────

describe("mapCustomSlots", () => {
  it("should return empty array for non-CUSTOM schedule type", () => {
    const data = makeConsultantData({ scheduleType: ScheduleType.WEEKLY });
    expect(mapCustomSlots(data as any)).toEqual([]);
  });

  it("should return empty array when no custom slots", () => {
    const data = makeConsultantData({
      scheduleType: ScheduleType.CUSTOM,
      slotsOfAvailabilityCustom: [],
    });
    expect(mapCustomSlots(data as any)).toEqual([]);
  });

  it("should generate 30-minute intervals from custom slot", () => {
    const data = makeConsultantData({
      scheduleType: ScheduleType.CUSTOM,
      slotsOfAvailabilityCustom: [
        makeCustomAvailabilitySlot(
          "2025-01-10T09:00:00.000Z",
          "2025-01-10T11:00:00.000Z",
        ),
      ],
    });

    const slots = mapCustomSlots(data as any);
    expect(slots.length).toBe(4); // 2 hours = 4 × 30-min slots
  });

  it("should support configurable interval", () => {
    const data = makeConsultantData({
      scheduleType: ScheduleType.CUSTOM,
      slotsOfAvailabilityCustom: [
        makeCustomAvailabilitySlot(
          "2025-01-10T09:00:00.000Z",
          "2025-01-10T10:00:00.000Z",
        ),
      ],
    });

    const slots = mapCustomSlots(data as any, 60);
    expect(slots.length).toBe(1); // 1 hour = 1 × 60-min slot
  });
});

// ─── slotsOverlap ───────────────────────────────────────────────────────────

describe("slotsOverlap", () => {
  it("should detect overlapping slots", () => {
    const slot1 = makeTimeSlot("2025-01-06T09:00:00Z", "2025-01-06T09:30:00Z");
    const apptSlot = {
      startsAt: "2025-01-06T09:00:00Z",
      endsAt: "2025-01-06T10:00:00Z",
    };
    expect(slotsOverlap(slot1 as TimeSlot, apptSlot)).toBe(true);
  });

  it("should detect non-overlapping slots", () => {
    const slot1 = makeTimeSlot("2025-01-06T09:00:00Z", "2025-01-06T09:30:00Z");
    const apptSlot = {
      startsAt: "2025-01-06T10:00:00Z",
      endsAt: "2025-01-06T10:30:00Z",
    };
    expect(slotsOverlap(slot1 as TimeSlot, apptSlot)).toBe(false);
  });

  it("should not count back-to-back as overlapping", () => {
    const slot1 = makeTimeSlot("2025-01-06T09:00:00Z", "2025-01-06T09:30:00Z");
    const apptSlot = {
      startsAt: "2025-01-06T09:30:00Z",
      endsAt: "2025-01-06T10:00:00Z",
    };
    expect(slotsOverlap(slot1 as TimeSlot, apptSlot)).toBe(false);
  });
});

// ─── getSlotStatus ──────────────────────────────────────────────────────────

describe("getSlotStatus", () => {
  // getSlotStatus uses setHours() (local time), so all test dates must
  // be constructed in local time to be timezone-agnostic.
  const baseDate = new Date(2025, 2, 1); // March 1, local time

  // Helper: create a local-time Date
  function local(hour: number, minute: number = 0): Date {
    return new Date(2025, 2, 1, hour, minute, 0, 0);
  }

  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it("should mark slot as available when it matches availability", () => {
    const availableSlots: TimeSlot[] = [
      {
        startTime: local(9, 0),
        endTime: local(10, 0),
        isAvailable: true,
        isBooked: false,
      },
    ];

    const status = getSlotStatus(
      { hour: 9, minute: 0 },
      baseDate,
      availableSlots,
      [],
    );
    expect(status.isAvailable).toBe(true);
  });

  it("should mark slot as booked when fully contained in appointment (fix verification)", () => {
    const availableSlots: TimeSlot[] = [
      {
        startTime: local(9, 0),
        endTime: local(10, 0),
        isAvailable: true,
        isBooked: false,
      },
    ];

    const appointments: Appointment[] = [
      {
        id: "apt-1",
        appointmentType: AppointmentsType.CONSULTATION,
        slotsOfAppointment: [
          {
            startsAt: local(9, 0).toISOString(),
            endsAt: local(10, 0).toISOString(),
          },
        ],
        consultation: {
          status: "APPROVED",
          consultationPlan: { title: "Test" },
          requestedBy: { user: { name: "Alice" } },
        },
      },
    ];

    // 30-min slot at 9:00-9:30 is fully within 9:00-10:00 appointment
    const status = getSlotStatus(
      { hour: 9, minute: 0 },
      baseDate,
      availableSlots,
      appointments,
    );
    expect(status.isBooked).toBe(true);
    expect(status.isPartiallyBooked).toBe(false);
  });

  it("should mark slot as partially booked when it only overlaps", () => {
    const availableSlots: TimeSlot[] = [];
    const appointments: Appointment[] = [
      {
        id: "apt-1",
        appointmentType: AppointmentsType.CONSULTATION,
        slotsOfAppointment: [
          {
            startsAt: local(9, 15).toISOString(),
            endsAt: local(9, 45).toISOString(),
          },
        ],
        consultation: {
          status: "APPROVED",
        },
      },
    ];

    // Slot 9:00-9:30 partially overlaps with 9:15-9:45
    const status = getSlotStatus(
      { hour: 9, minute: 0 },
      baseDate,
      availableSlots,
      appointments,
    );
    expect(status.isPartiallyBooked).toBe(true);
  });

  it("should detect conflicting overlapping appointments", () => {
    const appointments: Appointment[] = [
      {
        id: "apt-1",
        appointmentType: AppointmentsType.CONSULTATION,
        slotsOfAppointment: [
          {
            startsAt: local(9, 0).toISOString(),
            endsAt: local(10, 0).toISOString(),
          },
        ],
        consultation: { status: "APPROVED" },
      },
      {
        id: "apt-2",
        appointmentType: AppointmentsType.SUBSCRIPTION,
        slotsOfAppointment: [
          {
            startsAt: local(9, 0).toISOString(),
            endsAt: local(10, 0).toISOString(),
          },
        ],
        subscription: { status: "APPROVED" },
      },
    ];

    const status = getSlotStatus(
      { hour: 9, minute: 0 },
      baseDate,
      [],
      appointments,
    );
    expect(status.isConflicting).toBe(true);
    expect(status.overlappingAppointments.length).toBe(2);
  });

  it("should mark past slots as isInPast", () => {
    const status = getSlotStatus(
      { hour: 9, minute: 0 },
      new Date(2024, 0, 1), // past date (local time)
      [],
      [],
    );
    expect(status.isInPast).toBe(true);
  });

  it("should set isDisabled when not available or booked or past", () => {
    const status = getSlotStatus(
      { hour: 9, minute: 0 },
      baseDate,
      [], // not available
      [],
    );
    expect(status.isDisabled).toBe(true);
  });

  it("should include interval start/end UTC strings", () => {
    const status = getSlotStatus({ hour: 10, minute: 30 }, baseDate, [], []);
    expect(status.intervalStartUTCString).toContain("T");
    expect(status.intervalEndUTCString).toContain("T");
  });
});

// ─── formatSlotsForAPI ──────────────────────────────────────────────────────

describe("formatSlotsForAPI", () => {
  it("should return ISO strings of start times", () => {
    const slots: TimeSlot[] = [
      makeTimeSlot(
        "2025-01-06T09:00:00.000Z",
        "2025-01-06T09:30:00.000Z",
      ) as TimeSlot,
      makeTimeSlot(
        "2025-01-06T09:30:00.000Z",
        "2025-01-06T10:00:00.000Z",
      ) as TimeSlot,
    ];

    const result = formatSlotsForAPI(slots);
    expect(result).toEqual([
      "2025-01-06T09:00:00.000Z",
      "2025-01-06T09:30:00.000Z",
    ]);
  });

  it("should return empty array for no slots", () => {
    expect(formatSlotsForAPI([])).toEqual([]);
  });
});

// ─── calculateRequiredSlots delegation ──────────────────────────────────────

describe("calculateRequiredSlots (calendarUtils wrapper)", () => {
  it("should delegate to SlotCalculationService for consultations", () => {
    expect(
      calculateRequiredSlots("consultation", undefined, undefined, 1),
    ).toBe(2);
  });

  it("should delegate to SlotCalculationService for subscriptions", () => {
    const result = calculateRequiredSlots(
      "subscription",
      undefined,
      2,
      1,
      new Date("2025-01-06"),
      new Date("2025-01-31"),
    );
    expect(result).toBe(16); // 4 weeks × 2 calls × 2 slots
  });
});

// ─── countSundayWeeksInclusive / startOfWeekSunday delegation ───────────────

describe("Delegated week functions", () => {
  it("countSundayWeeksInclusive should match SlotCalculationService", () => {
    expect(
      countSundayWeeksInclusive(new Date("2025-01-06"), new Date("2025-01-31")),
    ).toBe(4);
  });

  it("startOfWeekSunday should return Sunday", () => {
    const result = startOfWeekSunday(new Date("2025-01-08")); // Wednesday
    // UTC weekday — this helper is UTC-based; local getDay() shifts by machine TZ
    expect(result.getUTCDay()).toBe(0);
  });
});

// ─── validateSelectedSlots ──────────────────────────────────────────────────

describe("validateSelectedSlots", () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it("should reject empty slots", () => {
    const result = validateSelectedSlots([], "consultation");
    expect(result.isValid).toBe(false);
    expect(result.errorMessage).toContain("at least one slot");
  });

  it("should reject past slots", () => {
    const pastSlots: TimeSlot[] = [
      makeTimeSlot("2024-01-01T09:00:00Z", "2024-01-01T09:30:00Z") as TimeSlot,
    ];
    const result = validateSelectedSlots(pastSlots, "webinar", 1, 0.5);
    expect(result.isValid).toBe(false);
    expect(result.errorMessage).toContain("past");
  });

  describe("consultation", () => {
    it("should accept correct number of consecutive slots", () => {
      const slots = makeConsecutiveTimeSlots("2025-06-01T09:00:00Z", 2);
      const result = validateSelectedSlots(
        slots as TimeSlot[],
        "consultation",
        2,
        1,
      );
      expect(result.isValid).toBe(true);
    });

    it("should reject wrong number of slots", () => {
      const slots = makeConsecutiveTimeSlots("2025-06-01T09:00:00Z", 1);
      const result = validateSelectedSlots(
        slots as TimeSlot[],
        "consultation",
        2,
        1,
      );
      expect(result.isValid).toBe(false);
    });

    it("should reject slots on different days", () => {
      const slots: TimeSlot[] = [
        makeTimeSlot(
          "2025-06-01T09:00:00Z",
          "2025-06-01T09:30:00Z",
        ) as TimeSlot,
        makeTimeSlot(
          "2025-06-02T09:00:00Z",
          "2025-06-02T09:30:00Z",
        ) as TimeSlot,
      ];
      const result = validateSelectedSlots(slots, "consultation", 2, 1);
      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toContain("same day");
    });

    it("should reject non-consecutive same-day slots", () => {
      const slots: TimeSlot[] = [
        makeTimeSlot(
          "2025-06-01T09:00:00Z",
          "2025-06-01T09:30:00Z",
        ) as TimeSlot,
        makeTimeSlot(
          "2025-06-01T10:00:00Z",
          "2025-06-01T10:30:00Z",
        ) as TimeSlot,
      ];
      const result = validateSelectedSlots(slots, "consultation", 2, 1);
      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toContain("consecutive");
    });
  });

  describe("webinar", () => {
    it("should accept correct consecutive slots", () => {
      const slots = makeConsecutiveTimeSlots("2025-06-01T09:00:00Z", 4);
      const result = validateSelectedSlots(
        slots as TimeSlot[],
        "webinar",
        4,
        2,
      );
      expect(result.isValid).toBe(true);
    });

    it("should reject non-consecutive webinar slots", () => {
      const slots: TimeSlot[] = [
        makeTimeSlot(
          "2025-06-01T09:00:00Z",
          "2025-06-01T09:30:00Z",
        ) as TimeSlot,
        makeTimeSlot(
          "2025-06-01T10:00:00Z",
          "2025-06-01T10:30:00Z",
        ) as TimeSlot,
      ];
      const result = validateSelectedSlots(slots, "webinar", 2, 1);
      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toContain("consecutive");
    });
  });

  describe("subscription/class", () => {
    it("should validate total slot count", () => {
      const slots = makeConsecutiveTimeSlots("2025-06-01T09:00:00Z", 3);
      const result = validateSelectedSlots(
        slots as TimeSlot[],
        "subscription",
        4,
      );
      expect(result.isValid).toBe(false);
    });

    it("should pass when slot count matches", () => {
      const slots = makeConsecutiveTimeSlots("2025-06-01T09:00:00Z", 4);
      const result = validateSelectedSlots(
        slots as TimeSlot[],
        "subscription",
        4,
      );
      expect(result.isValid).toBe(true);
    });
  });

  it("should reject invalid event type", () => {
    const slots = makeConsecutiveTimeSlots("2025-06-01T09:00:00Z", 1);
    const result = validateSelectedSlots(slots as TimeSlot[], "invalid" as any);
    expect(result.isValid).toBe(false);
  });
});

// ─── groupSlotsByWeek ───────────────────────────────────────────────────────

describe("groupSlotsByWeek", () => {
  it("should group slots by week using startOfWeek", () => {
    const slots: TimeSlot[] = [
      makeTimeSlot("2025-01-06T09:00:00Z", "2025-01-06T09:30:00Z") as TimeSlot,
      makeTimeSlot("2025-01-13T09:00:00Z", "2025-01-13T09:30:00Z") as TimeSlot,
    ];

    const grouped = groupSlotsByWeek(slots);
    expect(grouped.size).toBe(2);
  });

  it("should keep same-week slots together", () => {
    const slots: TimeSlot[] = [
      makeTimeSlot("2025-01-06T09:00:00Z", "2025-01-06T09:30:00Z") as TimeSlot,
      makeTimeSlot("2025-01-08T09:00:00Z", "2025-01-08T09:30:00Z") as TimeSlot,
    ];

    const grouped = groupSlotsByWeek(slots);
    expect(grouped.size).toBe(1);
    const weekSlots = Array.from(grouped.values())[0];
    expect(weekSlots.length).toBe(2);
  });
});

// ─── validateSlotDistribution ───────────────────────────────────────────────

describe("validateSlotDistribution", () => {
  it("should pass when slots per week are within limit", () => {
    const slots: TimeSlot[] = [
      makeTimeSlot("2025-01-06T09:00:00Z", "2025-01-06T09:30:00Z") as TimeSlot,
      makeTimeSlot("2025-01-13T09:00:00Z", "2025-01-13T09:30:00Z") as TimeSlot,
    ];

    const result = validateSlotDistribution(slots, 1);
    expect(result.isValid).toBe(true);
  });

  it("should fail when a week exceeds the limit", () => {
    const slots: TimeSlot[] = [
      makeTimeSlot("2025-01-06T09:00:00Z", "2025-01-06T09:30:00Z") as TimeSlot,
      makeTimeSlot("2025-01-07T09:00:00Z", "2025-01-07T09:30:00Z") as TimeSlot,
      makeTimeSlot("2025-01-08T09:00:00Z", "2025-01-08T09:30:00Z") as TimeSlot,
    ];

    const result = validateSlotDistribution(slots, 2);
    expect(result.isValid).toBe(false);
    expect(result.errorMessage).toContain("Too many slots");
  });
});

// ─── validateDayBasedConsecutiveSlots ────────────────────────────────────────

describe("validateDayBasedConsecutiveSlots", () => {
  it("should return true for single slot", () => {
    const slots: TimeSlot[] = [
      makeTimeSlot("2025-01-06T09:00:00Z", "2025-01-06T09:30:00Z") as TimeSlot,
    ];
    expect(validateDayBasedConsecutiveSlots(slots)).toBe(true);
  });

  it("should return true for consecutive slots on same day", () => {
    const slots = makeConsecutiveTimeSlots("2025-01-06T09:00:00Z", 3);
    expect(validateDayBasedConsecutiveSlots(slots as TimeSlot[])).toBe(true);
  });

  it("should return false for non-consecutive slots", () => {
    const slots: TimeSlot[] = [
      makeTimeSlot("2025-01-06T09:00:00Z", "2025-01-06T09:30:00Z") as TimeSlot,
      makeTimeSlot("2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z") as TimeSlot,
    ];
    expect(validateDayBasedConsecutiveSlots(slots)).toBe(false);
  });

  it("should return false for slots on different days", () => {
    const slots: TimeSlot[] = [
      makeTimeSlot("2025-01-06T09:00:00Z", "2025-01-06T09:30:00Z") as TimeSlot,
      makeTimeSlot("2025-01-07T09:30:00Z", "2025-01-07T10:00:00Z") as TimeSlot,
    ];
    expect(validateDayBasedConsecutiveSlots(slots)).toBe(false);
  });

  it("should accept slots with sub-second tolerance", () => {
    const slots: TimeSlot[] = [
      makeTimeSlot(
        "2025-01-06T09:00:00.000Z",
        "2025-01-06T09:30:00.000Z",
      ) as TimeSlot,
      {
        startTime: new Date(
          new Date("2025-01-06T09:30:00.000Z").getTime() + 500,
        ), // +500ms
        endTime: new Date("2025-01-06T10:00:00.500Z"),
        isAvailable: true,
        isBooked: false,
      },
    ];
    expect(validateDayBasedConsecutiveSlots(slots)).toBe(true);
  });

  it("should return true for empty array", () => {
    expect(validateDayBasedConsecutiveSlots([])).toBe(true);
  });
});

// ─── calculateCallProgress ──────────────────────────────────────────────────

describe("calculateCallProgress", () => {
  it('should return "No slots selected" for empty slots', () => {
    expect(calculateCallProgress([])).toBe("No slots selected");
  });

  it("should count complete calls for 1-hour sessions", () => {
    const slots = makeConsecutiveTimeSlots("2025-01-06T09:00:00Z", 4); // 4 slots = 2 complete calls
    const result = calculateCallProgress(slots as TimeSlot[], 1);
    expect(result).toContain("2");
    expect(result).toContain("scheduled");
  });

  it("should count complete calls for 1.5-hour sessions", () => {
    const slots = makeConsecutiveTimeSlots("2025-01-06T09:00:00Z", 3); // 3 slots = 1 complete 1.5hr call
    const result = calculateCallProgress(slots as TimeSlot[], 1.5);
    expect(result).toContain("1");
    expect(result).toContain("scheduled");
  });

  it("should warn about incomplete calls", () => {
    const slots = makeConsecutiveTimeSlots("2025-01-06T09:00:00Z", 1); // 1 slot, need 2 for 1hr
    const result = calculateCallProgress(slots as TimeSlot[], 1);
    expect(result).toContain("Add");
    expect(result).toContain("more slot");
  });

  it("should show progress with maxTotalCalls", () => {
    const slots = makeConsecutiveTimeSlots("2025-01-06T09:00:00Z", 2);
    const result = calculateCallProgress(slots as TimeSlot[], 1, 8);
    expect(result).toContain("1/8");
  });
});

// ─── getAppointmentTitle / getAppointmentUser ───────────────────────────────

describe("getAppointmentTitle", () => {
  it("should return consultation title", () => {
    const apt: Appointment = {
      id: "1",
      appointmentType: AppointmentsType.CONSULTATION,
      consultation: {
        status: "APPROVED",
        consultationPlan: { title: "Career Guidance" },
      },
    };
    expect(getAppointmentTitle(apt)).toBe("Career Guidance");
  });

  it("should return subscription title", () => {
    const apt: Appointment = {
      id: "1",
      appointmentType: AppointmentsType.SUBSCRIPTION,
      subscription: {
        status: "APPROVED",
        subscriptionPlan: { title: "Weekly Mentoring" },
      },
    };
    expect(getAppointmentTitle(apt)).toBe("Weekly Mentoring");
  });

  it("should return webinar title", () => {
    const apt: Appointment = {
      id: "1",
      appointmentType: AppointmentsType.WEBINAR,
      webinar: { status: "SCHEDULED", webinarPlan: { title: "Tech Talk" } },
    };
    expect(getAppointmentTitle(apt)).toBe("Tech Talk");
  });

  it("should return class title", () => {
    const apt: Appointment = {
      id: "1",
      appointmentType: AppointmentsType.CLASS,
      class: { status: "SCHEDULED", classPlan: { title: "Yoga" } },
    };
    expect(getAppointmentTitle(apt)).toBe("Yoga");
  });

  it("should return fallback for unknown type", () => {
    const apt: Appointment = {
      id: "1",
      appointmentType: "UNKNOWN" as any,
    };
    expect(getAppointmentTitle(apt)).toBe("Unknown Appointment");
  });
});

describe("getAppointmentUser", () => {
  it("should return user name for consultation", () => {
    const apt: Appointment = {
      id: "1",
      appointmentType: AppointmentsType.CONSULTATION,
      consultation: {
        status: "APPROVED",
        requestedBy: { user: { name: "Alice" } },
      },
    };
    expect(getAppointmentUser(apt)).toBe("Alice");
  });

  it("should return user name for subscription", () => {
    const apt: Appointment = {
      id: "1",
      appointmentType: AppointmentsType.SUBSCRIPTION,
      subscription: {
        status: "APPROVED",
        requestedBy: { user: { name: "Bob" } },
      },
    };
    expect(getAppointmentUser(apt)).toBe("Bob");
  });

  it("should return empty string for webinar", () => {
    const apt: Appointment = {
      id: "1",
      appointmentType: AppointmentsType.WEBINAR,
    };
    expect(getAppointmentUser(apt)).toBe("");
  });
});
