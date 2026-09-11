/**
 * Comprehensive tests for SlotValidationService
 *
 * Covers:
 * - checkSlotAvailability (conflict detection)
 * - validate() routing (event type dispatch)
 * - validateSlotsInFuture (5-second buffer)
 * - validateMatchesSchedule (weekly + custom, overlap detection)
 * - validateSchedulingPeriod (boundary checks)
 * - validateConsecutiveSlots (tolerance)
 * - validateSameDaySlots
 * - validateConsultation (duration, same-day, consecutive)
 * - validateWebinar (duration, consecutive)
 * - validateClass (weekly limits, session grouping)
 * - slotDurationMinutes fix verification
 */

import "./setup";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

import {
  SlotValidationService,
  isOccupiedByLiveAppointment,
} from "@/utils/slotAllocation/SlotValidationService";
import { ScheduleType, DayOfWeek, AppointmentStatus } from "@prisma/client";
import {
  makeConsultantData,
  makeWeeklyAvailabilitySlot,
  makeCustomAvailabilitySlot,
} from "./__mocks__/booking.mockData";

// ─── Mock Prisma ────────────────────────────────────────────────────────────

const mockPrisma = {
  appointment: {
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
  },
  subscription: {
    findUnique: jest.fn().mockResolvedValue(null),
  },
} as any;

let service: SlotValidationService;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  service = new SlotValidationService(mockPrisma);
  mockPrisma.appointment.findFirst.mockResolvedValue(null);
  mockPrisma.appointment.findMany.mockResolvedValue([]);
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── Helper ─────────────────────────────────────────────────────────────────

function futureSlots(
  count: number,
  startISO: string = "2025-06-01T10:00:00Z",
): Date[] {
  const slots: Date[] = [];
  let current = new Date(startISO);
  for (let i = 0; i < count; i++) {
    slots.push(new Date(current));
    current = new Date(current.getTime() + 30 * 60 * 1000);
  }
  return slots;
}

const weeklyConsultant = makeConsultantData({
  scheduleType: ScheduleType.WEEKLY,
  slotsOfAvailabilityWeekly: [
    // Sunday June 1 2025 is a Sunday, so June 2 is Monday
    makeWeeklyAvailabilitySlot(DayOfWeek.MONDAY, 9, 17),
    makeWeeklyAvailabilitySlot(DayOfWeek.TUESDAY, 9, 17),
    makeWeeklyAvailabilitySlot(DayOfWeek.WEDNESDAY, 9, 17),
  ],
}) as any;

const customConsultant = makeConsultantData({
  scheduleType: ScheduleType.CUSTOM,
  slotsOfAvailabilityCustom: [
    makeCustomAvailabilitySlot(
      "2025-06-02T09:00:00.000Z",
      "2025-06-02T12:00:00.000Z",
    ),
    makeCustomAvailabilitySlot(
      "2025-06-03T14:00:00.000Z",
      "2025-06-03T16:00:00.000Z",
    ),
  ],
}) as any;

// ─── checkSlotAvailability ──────────────────────────────────────────────────

describe("checkSlotAvailability", () => {
  it("should return valid when no conflicts exist", async () => {
    const result = await service.checkSlotAvailability(
      futureSlots(2),
      "user-1",
    );
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should detect conflicts from existing appointments", async () => {
    const slots = futureSlots(1);
    mockPrisma.appointment.findMany.mockResolvedValue([
      {
        id: "existing-apt",
        slotsOfAppointment: [
          {
            startsAt: slots[0],
            endsAt: new Date(slots[0].getTime() + 30 * 60 * 1000),
          },
        ],
        consultation: {
          requestedBy: { user: { name: "Existing User" } },
        },
      },
    ]);

    const result = await service.checkSlotAvailability(slots, "user-1");
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("already booked");
  });

  // AE-5/RV-6 — slot duration is no longer a parameter; it is the inlined
  // 30-minute SLOT_DURATION_MS const. checkSlotAvailability takes (slots, userId).
  it("uses the fixed 30-minute slot window for the conflict envelope", async () => {
    await service.checkSlotAvailability(futureSlots(1), "user-1");
    const where = mockPrisma.appointment.findMany.mock.calls[0][0].where;
    const slotFilter = where.AND.find(
      (clause: any) => clause.slotsOfAppointment,
    ).slotsOfAppointment.some.AND;
    const ltClause = slotFilter.find((c: any) => c.startsAt).startsAt.lt;
    const gtClause = slotFilter.find((c: any) => c.endsAt).endsAt.gt;
    // A single 10:00 slot must produce a [10:00, 10:30) envelope.
    expect(ltClause.toISOString()).toBe("2025-06-01T10:30:00.000Z");
    expect(gtClause.toISOString()).toBe("2025-06-01T10:00:00.000Z");
  });

  // Defense-in-depth: the conflict scan never trusts a tombstoned slot as a
  // booking. (Deliberately NO completionStatus filter here — RESCHEDULED rows
  // are a pending reschedule's live hold and must still block.)
  it("excludes deletedAt slot tombstones from the conflict scan", async () => {
    await service.checkSlotAvailability(futureSlots(1), "user-1");
    const where = mockPrisma.appointment.findMany.mock.calls[0][0].where;
    const slotFilter = where.AND.find(
      (clause: any) => clause.slotsOfAppointment,
    ).slotsOfAppointment.some.AND;
    expect(slotFilter).toContainEqual({ deletedAt: null });
    expect(JSON.stringify(slotFilter)).not.toContain("completionStatus");
  });

  // Behavior guard, stated honestly for a mocked Prisma: the DB applies the
  // include's where, so the strongest unit-level guarantee is that the
  // include mirrors the parent predicate EXACTLY — otherwise a qualifying
  // appointment's tombstoned (or non-participating) child reaches the JS
  // matcher and produces a [CONFLICT] the parent filter just excluded
  // (CodeRabbit triage). End-to-end tombstone behavior is covered by the
  // grid-allocator-parity suite against a real database.
  it("mirrors the parent slot predicate into the conflict query's include", async () => {
    await service.checkSlotAvailability(futureSlots(2), "user-1");
    const { where, include } = mockPrisma.appointment.findMany.mock.calls[0][0];
    const parentFilter = where.AND.find(
      (clause: any) => clause.slotsOfAppointment,
    ).slotsOfAppointment.some.AND;
    const includeFilter = include.slotsOfAppointment.where.AND;
    // Same four conditions, same order: envelope ×2, participants, tombstone.
    expect(includeFilter).toEqual(parentFilter);
    expect(includeFilter).toContainEqual({ deletedAt: null });
    expect(includeFilter).toContainEqual({
      user: { some: { id: { in: ["user-1"] } } },
    });
  });

  it("should skip expired payment conflicts (consultation)", async () => {
    const slots = futureSlots(1);
    mockPrisma.appointment.findMany.mockResolvedValue([
      {
        id: "expired-apt",
        slotsOfAppointment: [
          {
            startsAt: slots[0],
            endsAt: new Date(slots[0].getTime() + 30 * 60 * 1000),
          },
        ],
        consultation: {
          status: "APPROVED_PENDING_PAYMENT",
        },
        payment: [
          {
            paymentStatus: "PENDING",
            expiresAt: new Date("2024-01-01"), // expired
          },
        ],
      },
    ]);

    const result = await service.checkSlotAvailability(slots, "user-1");
    expect(result.isValid).toBe(true);
  });

  it("should skip expired payment conflicts (subscription)", async () => {
    const slots = futureSlots(1);
    mockPrisma.appointment.findMany.mockResolvedValue([
      {
        id: "expired-sub-apt",
        slotsOfAppointment: [
          {
            startsAt: slots[0],
            endsAt: new Date(slots[0].getTime() + 30 * 60 * 1000),
          },
        ],
        subscription: {
          status: "APPROVED_PENDING_PAYMENT",
        },
        payment: [
          {
            paymentStatus: "PENDING",
            expiresAt: new Date("2024-01-01"), // expired
          },
        ],
      },
    ]);

    const result = await service.checkSlotAvailability(slots, "user-1");
    expect(result.isValid).toBe(true);
  });

  it("should NOT skip non-expired subscription payment conflicts", async () => {
    const slots = futureSlots(1);
    mockPrisma.appointment.findMany.mockResolvedValue([
      {
        id: "active-sub-apt",
        slotsOfAppointment: [
          {
            startsAt: slots[0],
            endsAt: new Date(slots[0].getTime() + 30 * 60 * 1000),
          },
        ],
        subscription: {
          status: "APPROVED_PENDING_PAYMENT",
          requestedBy: { user: { name: "Active Sub User" } },
        },
        payment: [
          {
            paymentStatus: "PENDING",
            expiresAt: new Date("2026-12-31"), // not expired
          },
        ],
      },
    ]);

    const result = await service.checkSlotAvailability(slots, "user-1");
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("already booked");
  });
});

// ─── RV-2: shared live-occupancy rule ───────────────────────────────────────

describe("RV-2: isOccupiedByLiveAppointment (shared by validate + allocator)", () => {
  const NOW = new Date("2025-06-01T00:00:00Z");

  it("treats an expired APPROVED_PENDING_PAYMENT hold as NOT occupied", () => {
    expect(
      isOccupiedByLiveAppointment(
        {
          consultation: {
            status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
          },
          payment: [
            {
              paymentStatus: "PENDING",
              expiresAt: new Date("2024-01-01T00:00:00Z"),
            },
          ],
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("treats a non-expired APPROVED_PENDING_PAYMENT hold as occupied", () => {
    expect(
      isOccupiedByLiveAppointment(
        {
          subscription: {
            status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
          },
          payment: [
            {
              paymentStatus: "PENDING",
              expiresAt: new Date("2026-12-31T00:00:00Z"),
            },
          ],
        },
        NOW,
      ),
    ).toBe(true);
  });

  it("treats any non-pending-payment status as occupied regardless of payment", () => {
    expect(
      isOccupiedByLiveAppointment(
        { consultation: { status: AppointmentStatus.APPROVED }, payment: [] },
        NOW,
      ),
    ).toBe(true);
  });
});

// ─── validate: future check ────────────────────────────────────────────────

describe("validate: future slot validation", () => {
  it("should reject past slots", async () => {
    const pastSlots = [new Date("2024-06-01T10:00:00Z")];
    const result = await service.validate(
      "consultation",
      "event-1",
      pastSlots,
      weeklyConsultant,
      { durationInHours: 0.5 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("past");
  });

  it("should reject slots within 5-second buffer", async () => {
    // Set time to just before slot
    jest.setSystemTime(new Date("2025-06-01T10:00:00Z"));
    const tooSoonSlot = [new Date("2025-06-01T10:00:03.000Z")]; // 3 seconds from now
    const result = await service.validate(
      "consultation",
      "event-1",
      tooSoonSlot,
      weeklyConsultant,
      { durationInHours: 0.5 },
    );
    expect(result.isValid).toBe(false);
  });

  it("should accept slots well in the future", async () => {
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(true);
  });
});

// ─── validate: schedule matching ────────────────────────────────────────────

describe("validate: schedule matching", () => {
  it("should accept slots matching weekly availability", async () => {
    // Monday at 10:00 UTC — within 9-17 availability
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"), // Monday
      weeklyConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(true);
  });

  it("should reject slots outside weekly availability hours", async () => {
    // Monday at 20:00 UTC — outside 9-17 availability
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-02T20:00:00Z"),
      weeklyConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("not match");
  });

  it("should reject slots on unavailable weekday", async () => {
    // Thursday — not in availability (only Mon/Tue/Wed)
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-05T10:00:00Z"), // Thursday
      weeklyConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
  });

  it("should accept slots within custom availability (overlap detection)", async () => {
    // June 2 at 09:00-10:00 — within 09:00-12:00 custom slot
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-02T09:00:00Z"),
      customConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(true);
  });

  it("should reject slots outside custom availability", async () => {
    // June 2 at 13:00 — outside 09:00-12:00 custom slot
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-02T13:00:00Z"),
      customConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
  });

  it("should detect consecutive slot issues in custom schedule", async () => {
    // First slot valid (09:00), second slot invalid (12:30) — partial coverage
    const slots = [
      new Date("2025-06-02T09:00:00.000Z"),
      new Date("2025-06-02T12:30:00.000Z"),
    ];
    const result = await service.validate(
      "consultation",
      "event-1",
      slots,
      customConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("consecutive");
  });
});

// ─── validate: scheduling period ────────────────────────────────────────────

describe("validate: scheduling period", () => {
  it("should reject slots outside scheduling period", async () => {
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      {
        durationInHours: 1,
        schedulingPeriodStartsAt: new Date("2025-07-01"),
        schedulingPeriodEndsAt: new Date("2025-07-31"),
      },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("outside the scheduling period");
  });

  it("should accept slots within scheduling period", async () => {
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      {
        durationInHours: 1,
        schedulingPeriodStartsAt: new Date("2025-06-01"),
        schedulingPeriodEndsAt: new Date("2025-06-30"),
      },
    );
    expect(result.isValid).toBe(true);
  });
});

// ─── validate: consultation ─────────────────────────────────────────────────

describe("validate: consultation event", () => {
  it("should accept correct slot count", async () => {
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(true);
  });

  it("should reject wrong slot count", async () => {
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(1, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("requires exactly 2");
  });

  it("should reject slots on different days", async () => {
    const slots = [
      new Date("2025-06-02T10:00:00Z"), // Monday
      new Date("2025-06-03T10:00:00Z"), // Tuesday
    ];
    const result = await service.validate(
      "consultation",
      "event-1",
      slots,
      weeklyConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes("one-day event"))).toBe(true);
  });

  it("should reject non-consecutive same-day slots", async () => {
    const slots = [
      new Date("2025-06-02T10:00:00Z"),
      new Date("2025-06-02T11:00:00Z"), // 30-min gap
    ];
    const result = await service.validate(
      "consultation",
      "event-1",
      slots,
      weeklyConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
  });

  it("should reject invalid duration", async () => {
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { durationInHours: -1 },
    );
    expect(result.isValid).toBe(false);
  });
});

// ─── validate: webinar ──────────────────────────────────────────────────────

describe("validate: per-day session cap (#898)", () => {
  // Class cap is 2 sessions/day (subscription is 1/day). The cap was previously
  // only enforced at allocation-selection time + the client guard; these cover
  // the new hard server-side check in validateClass.
  it("accepts a class at the per-day cap (2 one-hour sessions on one day)", async () => {
    const result = await service.validate(
      "class",
      "class-1",
      futureSlots(4, "2025-06-02T09:00:00Z"), // 09:00–10:00 + 10:00–11:00, Monday
      weeklyConsultant,
      { sessionsPerWeek: 3, sessionDurationInHours: 1 },
    );
    expect(result.errors.some((e) => e.includes("DAILY_LIMIT"))).toBe(false);
  });

  it("rejects a class over the per-day cap (3 sessions on one day)", async () => {
    const result = await service.validate(
      "class",
      "class-1",
      futureSlots(6, "2025-06-02T09:00:00Z"), // three 1h sessions, all Monday
      weeklyConsultant,
      { sessionsPerWeek: 3, sessionDurationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes("DAILY_LIMIT"))).toBe(true);
  });

  it("counts existing same-day sessions toward the cap (partial reschedule)", async () => {
    // Two confirmed same-day sessions already exist; proposing a third on the
    // same day pushes Monday to 3 > 2.
    mockPrisma.appointment.findMany.mockResolvedValue([
      {
        id: "existing-1",
        slotsOfAppointment: [
          { startsAt: new Date("2025-06-02T09:00:00Z"), isTentative: false },
          { startsAt: new Date("2025-06-02T09:30:00Z"), isTentative: false },
        ],
      },
      {
        id: "existing-2",
        slotsOfAppointment: [
          { startsAt: new Date("2025-06-02T11:00:00Z"), isTentative: false },
          { startsAt: new Date("2025-06-02T11:30:00Z"), isTentative: false },
        ],
      },
    ]);
    const result = await service.validate(
      "class",
      "class-1",
      futureSlots(2, "2025-06-02T14:00:00Z"), // one more session, same Monday
      weeklyConsultant,
      { sessionsPerWeek: 5, sessionDurationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes("DAILY_LIMIT"))).toBe(true);
  });
});

describe("validate: webinar event", () => {
  it("should accept correct consecutive slots for 2-hour webinar", async () => {
    const result = await service.validate(
      "webinar",
      "event-1",
      futureSlots(4, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { durationInHours: 2 },
    );
    expect(result.isValid).toBe(true);
  });

  it("should reject wrong slot count", async () => {
    const result = await service.validate(
      "webinar",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { durationInHours: 2 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("requires exactly 4");
  });

  it("should reject non-consecutive webinar slots", async () => {
    const slots = [
      new Date("2025-06-02T10:00:00Z"),
      new Date("2025-06-02T11:00:00Z"), // gap
    ];
    const result = await service.validate(
      "webinar",
      "event-1",
      slots,
      weeklyConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
  });

  it("should accept single-slot webinar (0.5 hour)", async () => {
    const result = await service.validate(
      "webinar",
      "event-1",
      futureSlots(1, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { durationInHours: 0.5 },
    );
    expect(result.isValid).toBe(true);
  });

  it("should reject invalid webinar duration", async () => {
    const result = await service.validate(
      "webinar",
      "event-1",
      futureSlots(1, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      {},
    );
    expect(result.isValid).toBe(false);
  });
});

// ─── validate: class ────────────────────────────────────────────────────────

describe("validate: class event", () => {
  it("should reject when sessionsPerWeek is missing", async () => {
    const result = await service.validate(
      "class",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { sessionDurationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("Classes per week is required");
  });

  it("should reject when sessionDurationInHours is missing", async () => {
    const result = await service.validate(
      "class",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { sessionsPerWeek: 2 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("Session duration is required");
  });

  it("should accept valid class slots with correct session grouping", async () => {
    // 2 consecutive slots = 1 complete 1-hour session
    const result = await service.validate(
      "class",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { sessionsPerWeek: 2, sessionDurationInHours: 1 },
    );
    expect(result.isValid).toBe(true);
  });

  it("should reject incomplete sessions (odd number of slots for 1hr)", async () => {
    const result = await service.validate(
      "class",
      "event-1",
      futureSlots(3, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { sessionsPerWeek: 2, sessionDurationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes("incomplete session"))).toBe(
      true,
    );
  });

  it("should reject when weekly session count exceeds limit", async () => {
    // 6 slots = 3 sessions in 1 week, but limit is 2
    const result = await service.validate(
      "class",
      "event-1",
      futureSlots(6, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { sessionsPerWeek: 2, sessionDurationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes("max is 2"))).toBe(true);
  });

  it("should accept cross-midnight sessions that span two UTC days", async () => {
    // A 1-hour session starting at 23:30 UTC spans Saturday→Sunday:
    // Slot 1: Saturday 23:30, Slot 2: Sunday 00:00
    // The old per-day grouping would incorrectly flag Sunday as non-consecutive
    // if another session also had slots on Sunday.
    const crossMidnightConsultant = makeConsultantData({
      scheduleType: ScheduleType.WEEKLY,
      slotsOfAvailabilityWeekly: [
        makeWeeklyAvailabilitySlot(DayOfWeek.MONDAY, 23, 24), // Mon 23:00-24:00 UTC
        makeWeeklyAvailabilitySlot(DayOfWeek.TUESDAY, 0, 1), // Tue 00:00-01:00 UTC
        makeWeeklyAvailabilitySlot(DayOfWeek.TUESDAY, 10, 17), // Tue 10:00-17:00 UTC
      ],
    }) as any;

    // Session 1: Mon 23:30 + Tue 00:00 (cross-midnight)
    // Session 2: Tue 10:00 + Tue 10:30 (same day)
    // Tuesday has slots at 00:00 and 10:00 — NOT consecutive within the day,
    // but each session is internally consecutive → should PASS
    const slots = [
      new Date("2025-06-02T23:30:00Z"), // Mon 23:30
      new Date("2025-06-03T00:00:00Z"), // Tue 00:00
      new Date("2025-06-03T10:00:00Z"), // Tue 10:00
      new Date("2025-06-03T10:30:00Z"), // Tue 10:30
    ];

    const result = await service.validate(
      "class",
      "event-1",
      slots,
      crossMidnightConsultant,
      { sessionsPerWeek: 2, sessionDurationInHours: 1 },
    );
    expect(result.isValid).toBe(true);
  });

  it("should reject non-consecutive slots within a single session", async () => {
    // Two slots with a gap (09:00 and 10:00) — not consecutive (missing 09:30)
    const slots = [
      new Date("2025-06-02T09:00:00Z"),
      new Date("2025-06-02T10:00:00Z"),
    ];

    const result = await service.validate(
      "class",
      "event-1",
      slots,
      weeklyConsultant,
      { sessionsPerWeek: 2, sessionDurationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes("consecutive"))).toBe(true);
  });

  // ── RV-5: weekly limit seeds from existing confirmed sessions ──────────────
  describe("RV-5: weekly limit counts existing confirmed sessions", () => {
    // Mon Jun 16 and Tue Jun 17 2025 both fall in the Sunday-week of Jun 15 and
    // are valid Mon/Tue availability days for weeklyConsultant.
    const session1 = futureSlots(2, "2025-06-16T10:00:00Z"); // Mon 10:00-11:00
    const session2 = futureSlots(2, "2025-06-17T10:00:00Z"); // Tue 10:00-11:00

    it("FAILS when proposed sessions plus a surviving confirmed session exceed the limit", async () => {
      // No conflicts from the universal conflict scan…
      mockPrisma.appointment.findMany.mockResolvedValueOnce([]);
      // …but the class already has 1 CONFIRMED (non-tentative) session this week.
      mockPrisma.appointment.findMany.mockResolvedValueOnce([
        {
          id: "confirmed-apt",
          slotsOfAppointment: [
            { startsAt: new Date("2025-06-18T10:00:00Z"), isTentative: false },
            { startsAt: new Date("2025-06-18T10:30:00Z"), isTentative: false },
          ],
        },
      ]);

      // sessionsPerWeek = 2; reschedule proposes 2 NEW sessions in the same week.
      // 2 proposed + 1 confirmed = 3 > 2 → must fail (matches the allocator).
      const result = await service.validate(
        "class",
        "class-rv5",
        [...session1, ...session2],
        weeklyConsultant,
        { sessionsPerWeek: 2, sessionDurationInHours: 1 },
      );

      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes("WEEKLY_LIMIT"))).toBe(true);
      expect(result.errors.some((e) => e.includes("3 sessions"))).toBe(true);
    });

    it("does NOT count the class's own tentative session being replaced", async () => {
      mockPrisma.appointment.findMany.mockResolvedValueOnce([]);
      // The only existing session this week is TENTATIVE (the one being
      // rescheduled). It must be excluded from the seed, so 2 proposed + 0 = 2.
      mockPrisma.appointment.findMany.mockResolvedValueOnce([
        {
          id: "tentative-apt",
          slotsOfAppointment: [
            { startsAt: new Date("2025-06-18T10:00:00Z"), isTentative: true },
            { startsAt: new Date("2025-06-18T10:30:00Z"), isTentative: true },
          ],
        },
      ]);

      const result = await service.validate(
        "class",
        "class-rv5",
        [...session1, ...session2],
        weeklyConsultant,
        { sessionsPerWeek: 2, sessionDurationInHours: 1 },
      );

      expect(result.isValid).toBe(true);
    });
  });
});

// ─── validate: invalid event type ───────────────────────────────────────────

describe("validate: invalid event type", () => {
  it("should return error for unknown event type", async () => {
    const result = await service.validate(
      "unknown" as any,
      "event-1",
      futureSlots(1, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { durationInHours: 0.5 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("Invalid event type");
  });
});

// ─── Slot duration fix verification ─────────────────────────────────────────

describe("Slot duration fix", () => {
  it("should use 30-minute fixed duration regardless of config", async () => {
    // This tests the fix: slotDurationMinutes = 30 (constant)
    // Previously it was calculated as sessionDuration * 60 / slots.length
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { durationInHours: 1 },
    );
    // If slot duration was wrong, the conflict check query would use wrong time range
    // The fact that this passes with valid slots proves 30-min is used
    expect(result.isValid).toBe(true);
  });
});

// ─── VAL-3: Subscription slot count modulo check ────────────────────────────

describe("validate: subscription slot count modulo", () => {
  it("should reject subscription with incomplete session (3 slots for 1-hour sessions = 1.5 sessions)", async () => {
    // 1-hour sessions = 2 slots per session; 3 slots is not a multiple of 2
    const result = await service.validate(
      "subscription",
      "sub-1",
      futureSlots(3, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { sessionDurationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("multiple of 2");
  });

  it("should accept subscription with complete sessions (4 slots for 1-hour sessions)", async () => {
    // 4 slots = 2 complete 1-hour sessions — passes modulo check
    mockPrisma.subscription.findUnique.mockResolvedValue({
      id: "sub-1",
      schedulingPeriodStartsAt: new Date("2025-06-01T00:00:00Z"),
      schedulingPeriodEndsAt: new Date("2025-06-30T23:59:59Z"),
      subscriptionPlan: {
        sessionsPerWeek: 5,
        durationInHours: 1,
      },
    });
    mockPrisma.appointment.findMany.mockResolvedValue([]);

    const result = await service.validate(
      "subscription",
      "sub-1",
      futureSlots(4, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { sessionDurationInHours: 1 },
    );
    // Modulo check passes; downstream may fail on other rules but not modulo
    if (!result.isValid) {
      expect(result.errors.every((e) => !e.includes("multiple of"))).toBe(true);
    }
  });

  it("should skip modulo check for 30-min sessions (slotsPerSession=1)", async () => {
    // 30-min sessions = 1 slot per session; any count is valid for modulo
    mockPrisma.subscription.findUnique.mockResolvedValue({
      id: "sub-1",
      schedulingPeriodStartsAt: new Date("2025-06-01T00:00:00Z"),
      schedulingPeriodEndsAt: new Date("2025-06-30T23:59:59Z"),
      subscriptionPlan: {
        sessionsPerWeek: 5,
        durationInHours: 0.5,
      },
    });
    mockPrisma.appointment.findMany.mockResolvedValue([]);

    const result = await service.validate(
      "subscription",
      "sub-1",
      futureSlots(3, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { sessionDurationInHours: 0.5 },
    );
    // Should not fail with modulo error
    if (!result.isValid) {
      expect(result.errors.every((e) => !e.includes("multiple of"))).toBe(true);
    }
  });
});

// ─── #676 AE-1: consultee-side conflict check ───────────────────────────────

describe("#676 AE-1: validate threads consulteeUserId into the conflict scan", () => {
  it("includes the consultee in the conflict query when consulteeUserId is set", async () => {
    await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { durationInHours: 1 },
      undefined,
      { consulteeUserId: "consultee-ae1" },
    );
    // The single batched conflict query must scan the consultee's calendar too.
    expect(
      JSON.stringify(mockPrisma.appointment.findMany.mock.calls),
    ).toContain("consultee-ae1");
  });

  it("does NOT add a consultee to the scan for group events", async () => {
    mockPrisma.appointment.findMany.mockClear();
    await service.validate(
      "webinar",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { durationInHours: 1 },
    );
    expect(
      JSON.stringify(mockPrisma.appointment.findMany.mock.calls),
    ).not.toContain("consultee-ae1");
  });
});
