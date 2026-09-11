/**
 * findAvailableSlots — the placement search itself.
 *
 * This function had no executing test before, which is how two defects survived:
 *
 *   1. Only the availability row's own startTimeUtc was ever tried as a candidate
 *      start. A booked 09:00 forfeited the whole 09:00-17:00 window and the loop
 *      advanced to the next row, so auto-allocate yielded at most one placement
 *      per row per week.
 *   2. The recurring day cursor was anchored to a timezone week
 *      (startOfWeekSundayInTz) but read back with getUTCDay(). Sunday 00:00 IST
 *      is Saturday 18:30 UTC, so placements were credited to the week before the
 *      one being iterated and the allocator emitted output its own validate()
 *      rejected with [WEEKLY_LIMIT].
 */

import "./setup";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { appointment: { findMany: jest.fn() } },
  ALLOCATION_TX_MAX_WAIT_MS: 8000,
  ALLOCATION_TX_TIMEOUT_MS: 30000,
}));

// The allocator imports appointmentlock, which pulls @upstash/redis (ESM) in.
jest.mock("../../utils/appointmentlock", () => ({
  lockAutoAllocate: jest.fn(),
  unlockAutoAllocate: jest.fn(),
  lockConsulteeBooking: jest.fn(),
  unlockConsulteeBooking: jest.fn(),
}));

import { SlotAllocationService } from "../../utils/slotAllocation/SlotAllocationService";
import { SlotCalculationService } from "../../utils/slotAllocation/SlotCalculationService";
import type {
  ConsultantAllocationData,
  EventConfig,
  EventType,
} from "../../utils/slotAllocation/types";

const IST = "Asia/Kolkata";
const IST_OFFSET = 330;

/** findAvailableSlots is private; the search is the unit under test. */
const findAvailableSlots = (
  db: unknown,
  consultant: ConsultantAllocationData,
  totalSlotsNeeded: number,
  slotsPerCall: number,
  eventType: EventType,
  config: EventConfig,
  excludeAppointmentIds: string[] = [],
  eventOwnAppointments: unknown[] = [],
  consulteeUserId?: string,
): Promise<Date[]> =>
  (
    SlotAllocationService as unknown as {
      findAvailableSlots: (...a: unknown[]) => Promise<Date[]>;
    }
  ).findAvailableSlots(
    db,
    consultant,
    totalSlotsNeeded,
    slotsPerCall,
    eventType,
    config,
    excludeAppointmentIds,
    eventOwnAppointments,
    consulteeUserId,
  );

/** A consultant offering one weekly window, expressed in UTC minutes. */
function weeklyConsultant(
  rows: Array<{ day: string; startUtc: number; endUtc: number }>,
): ConsultantAllocationData {
  return {
    userId: "consultant-user",
    scheduleType: "WEEKLY",
    slotsOfAvailabilityWeekly: rows.map((r, i) => ({
      id: `weekly-${i}`,
      startDay: r.day,
      startTimeUtc: r.startUtc,
      endDay: r.day,
      endTimeUtc: r.endUtc,
      utcOffsetMinutes: IST_OFFSET,
    })),
    slotsOfAvailabilityCustom: [],
  };
}

/**
 * A db stub whose appointment.findMany returns one SCHEDULED consultation
 * occupying every listed instant.
 */
function dbOccupying(instants: Date[]) {
  return {
    appointment: {
      findMany: jest.fn().mockResolvedValue(
        instants.length === 0
          ? []
          : [
              {
                id: "booked-appointment",
                consultation: { status: "SCHEDULED" },
                subscription: null,
                payment: [],
                slotsOfAppointment: instants.map((startsAt, i) => ({
                  id: `booked-slot-${i}`,
                  startsAt,
                })),
              },
            ],
      ),
    },
  };
}

/** The next occurrence of a UTC weekday at a UTC minute-of-day, strictly future. */
function nextUtcDayAt(utcDay: number, minuteOfDay: number): Date {
  const now = new Date();
  const d = new Date(now);
  let delta = utcDay - now.getUTCDay();
  if (delta <= 0) delta += 7;
  d.setUTCDate(now.getUTCDate() + delta);
  d.setUTCHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0);
  return d;
}

const UTC_MONDAY = 1;

// Pin the clock. nextUtcDayAt below always rolls forward a full week when the
// target weekday is today, but getNextOccurrenceWeekly keeps today whenever the
// row's time has not yet passed — so on a Monday before 09:00 UTC the service
// would place the session today while these expectations point a week out, and
// the suite would fail purely on when CI happened to run. Wednesday keeps every
// case away from that boundary.
beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
  jest.setSystemTime(new Date("2026-08-05T12:00:00Z"));
});
afterAll(() => {
  jest.useRealTimers();
});

describe("findAvailableSlots — scanning within an availability row", () => {
  // IST Monday 14:30-22:30 == UTC Monday 09:00-17:00. Sixteen 30-min starts.
  const MON_0900_UTC = 9 * 60;
  const MON_1700_UTC = 17 * 60;

  const consultant = weeklyConsultant([
    { day: "MONDAY", startUtc: MON_0900_UTC, endUtc: MON_1700_UTC },
  ]);

  const consultationConfig: EventConfig = {
    durationInHours: 1,
    schedulingTimezone: IST,
  };

  it("places a consultation at the row start when the row is empty", async () => {
    const rowStart = nextUtcDayAt(UTC_MONDAY, MON_0900_UTC);

    const slots = await findAvailableSlots(
      dbOccupying([]),
      consultant,
      2,
      2,
      "consultation",
      consultationConfig,
    );

    expect(slots).toHaveLength(2);
    expect(slots[0].toISOString()).toBe(rowStart.toISOString());
  });

  it("advances within the row instead of forfeiting it when the start is booked", async () => {
    const rowStart = nextUtcDayAt(UTC_MONDAY, MON_0900_UTC);
    const nineThirty = new Date(rowStart.getTime() + 30 * 60 * 1000);

    // 09:00 and 09:30 taken — a 1h call must land at 10:00, not next week.
    const slots = await findAvailableSlots(
      dbOccupying([rowStart, nineThirty]),
      consultant,
      2,
      2,
      "consultation",
      consultationConfig,
    );

    expect(slots).toHaveLength(2);
    expect(slots[0].toISOString()).toBe(
      new Date(rowStart.getTime() + 60 * 60 * 1000).toISOString(),
    );
  });

  it("skips a partially blocked run and takes the next whole block", async () => {
    const rowStart = nextUtcDayAt(UTC_MONDAY, MON_0900_UTC);
    // Block 09:30 only: 09:00 can't host a 1h call, 10:00 can.
    const slots = await findAvailableSlots(
      dbOccupying([new Date(rowStart.getTime() + 30 * 60 * 1000)]),
      consultant,
      2,
      2,
      "consultation",
      consultationConfig,
    );

    expect(slots[0].toISOString()).toBe(
      new Date(rowStart.getTime() + 60 * 60 * 1000).toISOString(),
    );
  });

  it("still reports no availability when the whole row is booked", async () => {
    const rowStart = nextUtcDayAt(UTC_MONDAY, MON_0900_UTC);
    const everyStart = Array.from(
      { length: 16 },
      (_, i) => new Date(rowStart.getTime() + i * 30 * 60 * 1000),
    );

    // Booked for the next eight Mondays too, so the week search is exhausted.
    const eightWeeks = everyStart.flatMap((s) =>
      Array.from(
        { length: 9 },
        (_, w) => new Date(s.getTime() + w * 7 * 24 * 60 * 60 * 1000),
      ),
    );

    await expect(
      findAvailableSlots(
        dbOccupying(eightWeeks),
        consultant,
        2,
        2,
        "consultation",
        consultationConfig,
      ),
    ).rejects.toThrow(/No 2 consecutive slots available/);
  });

  it("does not start a block that cannot fit before the row ends", async () => {
    const rowStart = nextUtcDayAt(UTC_MONDAY, MON_0900_UTC);
    // Free only the last 30 minutes (16:30); a 1h call cannot fit there.
    const allButLast = Array.from(
      { length: 15 },
      (_, i) => new Date(rowStart.getTime() + i * 30 * 60 * 1000),
    );

    const slots = await findAvailableSlots(
      dbOccupying(allButLast),
      consultant,
      2,
      2,
      "consultation",
      consultationConfig,
    );

    // Must roll to a later week rather than emit a block running past 17:00.
    expect(slots).toHaveLength(2);
    const end = new Date(slots[1].getTime() + 30 * 60 * 1000);
    expect(end.getTime() - slots[0].getTime()).toBe(60 * 60 * 1000);
    expect(slots[0].getTime()).toBeGreaterThan(
      rowStart.getTime() + 6 * 24 * 60 * 60 * 1000,
    );
  });

  it("scans within a CUSTOM availability row too", async () => {
    const start = nextUtcDayAt(UTC_MONDAY, MON_0900_UTC);
    const custom: ConsultantAllocationData = {
      userId: "consultant-user",
      scheduleType: "CUSTOM",
      slotsOfAvailabilityWeekly: [],
      slotsOfAvailabilityCustom: [
        {
          id: "custom-0",
          startsAt: start,
          endsAt: new Date(start.getTime() + 4 * 60 * 60 * 1000),
        },
      ],
    };

    const slots = await findAvailableSlots(
      dbOccupying([start]),
      custom,
      2,
      2,
      "consultation",
      consultationConfig,
    );

    expect(slots[0].toISOString()).toBe(
      new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
    );
  });
});

describe("findAvailableSlots — recurring placement buckets by scheduling timezone", () => {
  // A Saturday row is the case that exposed the drift: Sunday 00:00 IST is
  // Saturday 18:30 UTC, so a tz-anchored cursor read with getUTCDay() landed on
  // the wrong side of the week boundary.
  const SAT_0900_UTC = 9 * 60;
  const SAT_1300_UTC = 13 * 60;

  const consultant = weeklyConsultant([
    { day: "SATURDAY", startUtc: SAT_0900_UTC, endUtc: SAT_1300_UTC },
  ]);

  it("places one session per timezone week and never double-books a week", async () => {
    const periodStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const periodEnd = new Date(periodStart.getTime() + 28 * 24 * 60 * 60 * 1000);

    const slots = await findAvailableSlots(
      dbOccupying([]),
      consultant,
      4,
      1,
      "subscription",
      {
        sessionsPerWeek: 1,
        sessionDurationInHours: 0.5,
        schedulingPeriodStartsAt: periodStart,
        schedulingPeriodEndsAt: periodEnd,
        schedulingTimezone: IST,
      },
    );

    expect(slots).toHaveLength(4);

    // The invariant the validator enforces: at most sessionsPerWeek per IST week.
    const perWeek = new Map<string, number>();
    for (const s of slots) {
      const key = SlotCalculationService.weekKey(s, IST);
      perWeek.set(key, (perWeek.get(key) ?? 0) + 1);
    }
    expect(perWeek.size).toBe(4);
    for (const count of perWeek.values()) expect(count).toBe(1);
  });

  it("never places two sessions in the same scheduling-timezone day", async () => {
    const periodStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const periodEnd = new Date(periodStart.getTime() + 56 * 24 * 60 * 60 * 1000);

    const slots = await findAvailableSlots(
      dbOccupying([]),
      weeklyConsultant([
        { day: "SATURDAY", startUtc: SAT_0900_UTC, endUtc: SAT_1300_UTC },
        { day: "SUNDAY", startUtc: SAT_0900_UTC, endUtc: SAT_1300_UTC },
      ]),
      6,
      1,
      "subscription",
      {
        sessionsPerWeek: 2,
        sessionDurationInHours: 0.5,
        schedulingPeriodStartsAt: periodStart,
        schedulingPeriodEndsAt: periodEnd,
        schedulingTimezone: IST,
      },
    );

    const dayKeys = slots.map((s) => SlotCalculationService.dayKey(s, IST));
    expect(new Set(dayKeys).size).toBe(dayKeys.length);
  });

  it("never reuses a day a surviving session already occupies", async () => {
    const periodStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const periodEnd = new Date(periodStart.getTime() + 56 * 24 * 60 * 60 * 1000);
    const config = {
      sessionsPerWeek: 2,
      sessionDurationInHours: 0.5,
      schedulingPeriodStartsAt: periodStart,
      schedulingPeriodEndsAt: periodEnd,
      schedulingTimezone: IST,
    };
    const twoDayConsultant = weeklyConsultant([
      { day: "SATURDAY", startUtc: SAT_0900_UTC, endUtc: SAT_1300_UTC },
      { day: "SUNDAY", startUtc: SAT_0900_UTC, endUtc: SAT_1300_UTC },
    ]);

    // Take the first placement the allocator would make, then hand it back as a
    // surviving confirmed session. The per-day cap counts existing appointments,
    // so re-placing on that day would be rejected downstream.
    const survivor = (
      await findAvailableSlots(dbOccupying([]), twoDayConsultant, 1, 1, "subscription", config)
    )[0];

    const slots = await findAvailableSlots(
      dbOccupying([]),
      twoDayConsultant,
      2,
      1,
      "subscription",
      config,
      [],
      [
        {
          id: "surviving-appointment",
          slotsOfAppointment: [{ id: "s1", startsAt: survivor }],
        },
      ],
    );

    const occupiedDay = SlotCalculationService.dayKey(survivor, IST);
    for (const s of slots) {
      expect(SlotCalculationService.dayKey(s, IST)).not.toBe(occupiedDay);
    }
  });

  it("never places a session whose end spills past the scheduling period", async () => {
    // A 1-hour session needs two atoms. Cut the period so only the row's first
    // 30 minutes fall inside it: testing the START alone would emit a block
    // running past the period end, which the validator then rejects outright.
    const probe = (
      await findAvailableSlots(
        dbOccupying([]),
        consultant,
        1,
        1,
        "subscription",
        {
          sessionsPerWeek: 1,
          sessionDurationInHours: 0.5,
          schedulingPeriodStartsAt: new Date(Date.now() + 60 * 60 * 1000),
          schedulingPeriodEndsAt: new Date(
            Date.now() + 60 * 24 * 60 * 60 * 1000,
          ),
          schedulingTimezone: IST,
        },
      )
    )[0];

    // The period now ends 30 minutes into the earliest bookable row, so a
    // 1-hour session cannot fit anywhere inside it. Refusing is the only correct
    // answer; before the fix the search accepted the row start and emitted a
    // block running 30 minutes past the period end.
    await expect(
      findAvailableSlots(dbOccupying([]), consultant, 2, 2, "subscription", {
        sessionsPerWeek: 1,
        sessionDurationInHours: 1,
        schedulingPeriodStartsAt: new Date(Date.now() + 60 * 60 * 1000),
        schedulingPeriodEndsAt: new Date(probe.getTime() + 30 * 60 * 1000),
        schedulingTimezone: IST,
      }),
    ).rejects.toThrow(/Could only find/);
  });

  it("counts a partial reschedule's surviving sessions against the week cap", async () => {
    const periodStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const periodEnd = new Date(periodStart.getTime() + 28 * 24 * 60 * 60 * 1000);

    // One confirmed session already sits in the first IST week that the search
    // would otherwise fill; it must be skipped rather than doubled up.
    const firstSaturday = (
      await findAvailableSlots(dbOccupying([]), consultant, 1, 1, "subscription", {
        sessionsPerWeek: 1,
        sessionDurationInHours: 0.5,
        schedulingPeriodStartsAt: periodStart,
        schedulingPeriodEndsAt: periodEnd,
        schedulingTimezone: IST,
      })
    )[0];

    const slots = await findAvailableSlots(
      dbOccupying([]),
      consultant,
      2,
      1,
      "subscription",
      {
        sessionsPerWeek: 1,
        sessionDurationInHours: 0.5,
        schedulingPeriodStartsAt: periodStart,
        schedulingPeriodEndsAt: periodEnd,
        schedulingTimezone: IST,
      },
      [],
      [
        {
          id: "surviving-appointment",
          slotsOfAppointment: [{ id: "s1", startsAt: firstSaturday }],
        },
      ],
    );

    const occupiedWeek = SlotCalculationService.weekKey(firstSaturday, IST);
    for (const s of slots) {
      expect(SlotCalculationService.weekKey(s, IST)).not.toBe(occupiedWeek);
    }
  });
});
