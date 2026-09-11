/**
 * Preference-scored auto-allocation (#1065).
 *
 * The one property that matters here, and the reason the previous
 * implementation was deleted rather than wired up:
 *
 *   **A preference SCORES candidates. It never removes one.**
 *
 * `filterSlotsByPreferences` filtered — `if (preferences.preferMorning &&
 * (hour < 9 || hour >= 12)) return false` — so a consultee who prefers mornings
 * booking a consultant with no morning availability got "no slots available"
 * with the whole afternoon free. Every "still allocates" case below exists to
 * stop that shape coming back.
 *
 * The rest pin the two things that make the feature worth having at all: a
 * preferred candidate must actually beat an equally-legal one, and stating no
 * preference must leave the allocator's choices exactly where they were.
 */

import "./setup";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findMany: jest.fn() },
    rescheduleRequest: { findFirst: jest.fn() },
  },
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

import prisma from "../../lib/prisma";
import { SlotAllocationService } from "../../utils/slotAllocation/SlotAllocationService";
import { SlotCalculationService } from "../../utils/slotAllocation/SlotCalculationService";
import {
  isEmptyPreference,
  maxPreferenceScore,
  scoreCandidateStart,
  type AllocationPreference,
} from "../../utils/slotAllocation/preferenceScoring";
import type {
  ConsultantAllocationData,
  EventConfig,
  EventType,
} from "../../utils/slotAllocation/types";

const IST = "Asia/Kolkata";
const IST_OFFSET = 330;
const MINUTE = 60 * 1000;
const HALF_HOUR = 30 * MINUTE;

/** IST wall-clock minute-of-day expressed as the UTC minute-of-day it lands on. */
const istToUtcMinutes = (hour: number, minute = 0) =>
  hour * 60 + minute - IST_OFFSET;

/** findAvailableSlots is private; the search is the unit under test. */
const findAvailableSlots = (
  consultant: ConsultantAllocationData,
  totalSlotsNeeded: number,
  slotsPerCall: number,
  eventType: EventType,
  config: EventConfig,
  preference?: AllocationPreference,
): Promise<Date[]> =>
  (
    SlotAllocationService as unknown as {
      findAvailableSlots: (...a: unknown[]) => Promise<Date[]>;
    }
  ).findAvailableSlots(
    emptyDb(),
    consultant,
    totalSlotsNeeded,
    slotsPerCall,
    eventType,
    config,
    [],
    [],
    undefined,
    undefined,
    preference,
  );

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

/** Nobody is booked; every candidate the availability allows is placeable. */
const emptyDb = () => ({
  appointment: { findMany: jest.fn().mockResolvedValue([]) },
});

const consultationConfig: EventConfig = {
  durationInHours: 1,
  schedulingTimezone: IST,
};

const recurringConfig = (weeks: number): EventConfig => {
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return {
    sessionsPerWeek: 1,
    sessionDurationInHours: 0.5,
    schedulingPeriodStartsAt: start,
    schedulingPeriodEndsAt: new Date(
      start.getTime() + weeks * 7 * 24 * 60 * 60 * 1000,
    ),
    schedulingTimezone: IST,
  };
};

const istHour = (d: Date) => SlotCalculationService.hourInTz(d, IST);
const istWeekday = (d: Date) => SlotCalculationService.weekdayInTz(d, IST);

// Same pinned Wednesday the availability-window-scan suite uses: it keeps every
// weekly row a clear whole number of days away, so no case turns on the hour CI
// happens to run at.
beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
  jest.setSystemTime(new Date("2026-08-05T12:00:00Z"));
});
afterAll(() => {
  jest.useRealTimers();
});

// ─── The rule itself ────────────────────────────────────────────────────────

describe("an unsatisfiable preference still allocates", () => {
  // IST 13:00-17:00 on Mondays and nothing else. There is no morning here at
  // all, which is precisely the case the deleted filter answered with an error.
  const afternoonOnly = weeklyConsultant([
    {
      day: "MONDAY",
      startUtc: istToUtcMinutes(13),
      endUtc: istToUtcMinutes(17),
    },
  ]);

  it("gives a consultation an afternoon when mornings were asked for", async () => {
    const slots = await findAvailableSlots(
      afternoonOnly,
      2,
      2,
      "consultation",
      consultationConfig,
      { preferredTimeOfDay: "MORNING" },
    );

    // The assertion the old implementation failed: a booking, not a throw.
    expect(slots).toHaveLength(2);
    expect(istHour(slots[0])).toBeGreaterThanOrEqual(13);
    expect(istHour(slots[0])).toBeLessThan(17);
  });

  it("places an unmeetable preference exactly where no preference would", async () => {
    const preferred = await findAvailableSlots(
      afternoonOnly,
      2,
      2,
      "consultation",
      consultationConfig,
      { preferredTimeOfDay: "MORNING" },
    );
    const unpreferred = await findAvailableSlots(
      afternoonOnly,
      2,
      2,
      "consultation",
      consultationConfig,
    );

    // Nothing scores, so the ranking collapses back to chronological order and
    // the consultee loses nothing but the preference.
    expect(preferred.map((s) => s.toISOString())).toEqual(
      unpreferred.map((s) => s.toISOString()),
    );
  });

  it("gives a consultation a weekday when weekends were asked for", async () => {
    const slots = await findAvailableSlots(
      afternoonOnly,
      2,
      2,
      "consultation",
      consultationConfig,
      { preferredDays: "WEEKENDS" },
    );

    expect(slots).toHaveLength(2);
    expect(istWeekday(slots[0])).toBe(1); // Monday
  });

  it("fills every session of a subscription when neither half can be met", async () => {
    const slots = await findAvailableSlots(
      afternoonOnly,
      4,
      1,
      "subscription",
      recurringConfig(4),
      { preferredTimeOfDay: "MORNING", preferredDays: "WEEKENDS" },
    );

    // Four sessions, all of them — not "could only find 2 of 4".
    expect(slots).toHaveLength(4);
    for (const slot of slots) {
      expect(istWeekday(slot)).toBe(1);
      expect(istHour(slot)).toBeGreaterThanOrEqual(13);
    }
  });

  it("still refuses when the availability itself cannot host the session", async () => {
    // A preference must not paper over a real "no": a 4-hour session does not
    // fit a 4-hour window once the walk is held to whole blocks inside it.
    await expect(
      findAvailableSlots(
        afternoonOnly,
        10,
        10,
        "consultation",
        { durationInHours: 5, schedulingTimezone: IST },
        { preferredTimeOfDay: "MORNING" },
      ),
    ).rejects.toThrow(/No 10 consecutive slots available/);
  });
});

// ─── The preferred candidate actually wins ──────────────────────────────────

describe("among equally-valid candidates the preferred one wins", () => {
  // Both windows are free, both are legal, and the morning one comes first —
  // so anything other than first-fit has to be the preference talking.
  const morningAndAfternoon = weeklyConsultant([
    { day: "MONDAY", startUtc: istToUtcMinutes(9), endUtc: istToUtcMinutes(11) },
    {
      day: "MONDAY",
      startUtc: istToUtcMinutes(14),
      endUtc: istToUtcMinutes(17),
    },
  ]);

  it("takes the afternoon window when afternoons are preferred", async () => {
    const slots = await findAvailableSlots(
      morningAndAfternoon,
      2,
      2,
      "consultation",
      consultationConfig,
      { preferredTimeOfDay: "AFTERNOON" },
    );

    expect(istHour(slots[0])).toBe(14);
  });

  it("takes the morning window when mornings are preferred", async () => {
    const slots = await findAvailableSlots(
      morningAndAfternoon,
      2,
      2,
      "consultation",
      consultationConfig,
      { preferredTimeOfDay: "MORNING" },
    );

    expect(istHour(slots[0])).toBe(9);
  });

  it("passes over an earlier weekend for the preferred weekday", async () => {
    // From the pinned Wednesday, Saturday arrives before Monday — so choosing
    // Monday can only be the day preference outranking chronological order.
    const weekendAndWeekday = weeklyConsultant([
      {
        day: "SATURDAY",
        startUtc: istToUtcMinutes(10),
        endUtc: istToUtcMinutes(13),
      },
      {
        day: "MONDAY",
        startUtc: istToUtcMinutes(10),
        endUtc: istToUtcMinutes(13),
      },
    ]);

    const weekday = await findAvailableSlots(
      weekendAndWeekday,
      2,
      2,
      "consultation",
      consultationConfig,
      { preferredDays: "WEEKDAYS" },
    );
    expect(istWeekday(weekday[0])).toBe(1);

    const weekend = await findAvailableSlots(
      weekendAndWeekday,
      2,
      2,
      "consultation",
      consultationConfig,
      { preferredDays: "WEEKENDS" },
    );
    expect(istWeekday(weekend[0])).toBe(6);
  });

  it("puts every recurring session on the preferred part of the week", async () => {
    const weekendAndWeekday = weeklyConsultant([
      {
        day: "SATURDAY",
        startUtc: istToUtcMinutes(10),
        endUtc: istToUtcMinutes(13),
      },
      {
        day: "MONDAY",
        startUtc: istToUtcMinutes(10),
        endUtc: istToUtcMinutes(13),
      },
    ]);

    const slots = await findAvailableSlots(
      weekendAndWeekday,
      4,
      1,
      "subscription",
      recurringConfig(4),
      { preferredDays: "WEEKDAYS" },
    );

    expect(slots).toHaveLength(4);
    for (const slot of slots) expect(istWeekday(slot)).toBe(1);
  });

  it("keeps the per-week cap while honouring the preference", async () => {
    const weekendAndWeekday = weeklyConsultant([
      {
        day: "SATURDAY",
        startUtc: istToUtcMinutes(10),
        endUtc: istToUtcMinutes(13),
      },
      {
        day: "MONDAY",
        startUtc: istToUtcMinutes(10),
        endUtc: istToUtcMinutes(13),
      },
    ]);

    const slots = await findAvailableSlots(
      weekendAndWeekday,
      4,
      1,
      "subscription",
      recurringConfig(4),
      { preferredDays: "WEEKENDS" },
    );

    // The two-pass day sweep must not smuggle an extra session into a week the
    // cap already closed — that is the invariant the validator re-checks.
    const perWeek = new Map<string, number>();
    for (const slot of slots) {
      const key = SlotCalculationService.weekKey(slot, IST);
      perWeek.set(key, (perWeek.get(key) ?? 0) + 1);
    }
    for (const count of perWeek.values()) expect(count).toBe(1);

    const dayKeys = slots.map((s) => SlotCalculationService.dayKey(s, IST));
    expect(new Set(dayKeys).size).toBe(dayKeys.length);
  });
});

// ─── Partial satisfaction: the reason the sweep runs twice ──────────────────

describe("a partly satisfiable day preference tops itself up", () => {
  /**
   * A CUSTOM schedule, because this needs availability that does NOT repeat
   * weekly: Saturdays in the first two weeks only, Mondays in all four. A
   * weekly row cannot express "some weeks and not others".
   */
  function customConsultant(days: Date[]): ConsultantAllocationData {
    return {
      userId: "consultant-user",
      scheduleType: "CUSTOM",
      slotsOfAvailabilityWeekly: [],
      slotsOfAvailabilityCustom: days.map((startsAt, i) => ({
        id: `custom-${i}`,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3 * 60 * MINUTE),
      })),
    };
  }

  /** The next `count` occurrences of a UTC weekday, at 10:00 IST. */
  function weekdayRuns(utcWeekday: number, count: number): Date[] {
    const first = new Date("2026-08-05T12:00:00Z");
    let delta = utcWeekday - first.getUTCDay();
    if (delta <= 0) delta += 7;
    const day0 = new Date(first);
    day0.setUTCDate(first.getUTCDate() + delta);
    day0.setUTCHours(
      Math.floor(istToUtcMinutes(10) / 60),
      istToUtcMinutes(10) % 60,
      0,
      0,
    );
    return Array.from(
      { length: count },
      (_, i) => new Date(day0.getTime() + i * 7 * 24 * 60 * MINUTE),
    );
  }

  const UTC_SATURDAY = 6;
  const UTC_MONDAY = 1;

  it("places the preferred days it can and fills the rest from anywhere", async () => {
    const consultant = customConsultant([
      ...weekdayRuns(UTC_SATURDAY, 2), // weekends exist in weeks 1-2 only
      ...weekdayRuns(UTC_MONDAY, 4), // weekdays exist throughout
    ]);

    const slots = await findAvailableSlots(
      consultant,
      4,
      1,
      "subscription",
      recurringConfig(5),
      { preferredDays: "WEEKENDS" },
    );

    // Every session placed — the preference cost nothing.
    expect(slots).toHaveLength(4);

    const weekdays = slots.map(istWeekday);
    // Sweep 1 took both available Saturdays; sweep 2 topped up with Mondays.
    expect(weekdays.filter((d) => d === 6)).toHaveLength(2);
    expect(weekdays.filter((d) => d === 1)).toHaveLength(2);

    // And the caps still hold across the two sweeps.
    const perWeek = new Map<string, number>();
    for (const slot of slots) {
      const key = SlotCalculationService.weekKey(slot, IST);
      perWeek.set(key, (perWeek.get(key) ?? 0) + 1);
    }
    for (const count of perWeek.values()) expect(count).toBe(1);
  });
});

// ─── No preference changes nothing ──────────────────────────────────────────

describe("a null preference leaves selection where it was", () => {
  const consultant = weeklyConsultant([
    { day: "MONDAY", startUtc: istToUtcMinutes(9), endUtc: istToUtcMinutes(11) },
    {
      day: "MONDAY",
      startUtc: istToUtcMinutes(14),
      endUtc: istToUtcMinutes(17),
    },
  ]);

  it("still takes the chronologically first consultation block", async () => {
    const absent = await findAvailableSlots(
      consultant,
      2,
      2,
      "consultation",
      consultationConfig,
    );
    const nulled = await findAvailableSlots(
      consultant,
      2,
      2,
      "consultation",
      consultationConfig,
      { preferredTimeOfDay: null, preferredDays: null },
    );

    expect(istHour(absent[0])).toBe(9);
    expect(nulled.map((s) => s.toISOString())).toEqual(
      absent.map((s) => s.toISOString()),
    );
  });

  it("still distributes a subscription the same way", async () => {
    const config = recurringConfig(4);
    const absent = await findAvailableSlots(
      consultant,
      4,
      1,
      "subscription",
      config,
    );
    const nulled = await findAvailableSlots(
      consultant,
      4,
      1,
      "subscription",
      config,
      {},
    );

    expect(absent).toHaveLength(4);
    expect(nulled.map((s) => s.toISOString())).toEqual(
      absent.map((s) => s.toISOString()),
    );
  });
});

// ─── Timezone ───────────────────────────────────────────────────────────────

describe("bands are read in the event's scheduling timezone", () => {
  // Two rows chosen so the UTC clock and the IST clock disagree about which is
  // the morning, AND the wrong answer is also the chronologically first one:
  //
  //   Thursday 09:00 UTC = 14:30 IST — morning by the UTC clock, afternoon in IST
  //   Friday   03:30 UTC = 09:00 IST — evening by the UTC clock, morning in IST
  //
  // So prefer-mornings must return the LATER, Friday row. First-fit returns
  // Thursday, and so does any implementation reading the hour off the UTC (or
  // server-local) clock — which is exactly what the deleted `getHours()` code
  // did, making "morning" mean different things on different hosts.
  const consultant = weeklyConsultant([
    {
      day: "THURSDAY",
      startUtc: istToUtcMinutes(14, 30),
      endUtc: istToUtcMinutes(17),
    },
    { day: "FRIDAY", startUtc: istToUtcMinutes(9), endUtc: istToUtcMinutes(11) },
  ]);

  it("takes the chronologically first row when nothing is preferred", async () => {
    const slots = await findAvailableSlots(
      consultant,
      2,
      2,
      "consultation",
      consultationConfig,
    );

    expect(istWeekday(slots[0])).toBe(4); // Thursday
    expect(istHour(slots[0])).toBe(14);
  });

  it("prefers the row that is morning in IST, not the one that is morning in UTC", async () => {
    const slots = await findAvailableSlots(
      consultant,
      2,
      2,
      "consultation",
      consultationConfig,
      { preferredTimeOfDay: "MORNING" },
    );

    expect(istWeekday(slots[0])).toBe(5); // Friday
    expect(istHour(slots[0])).toBe(9);
    // The same instant read in UTC is 03:30 — nowhere near a morning.
    expect(SlotCalculationService.hourInTz(slots[0], "UTC")).toBe(3);
  });
});

// ─── Finding the stated preference ──────────────────────────────────────────

describe("findAllocationPreference", () => {
  /** Private, and the seam where the preference is either found or silently lost. */
  const findAllocationPreference = (
    releasedSlotIds: string[],
  ): Promise<AllocationPreference | undefined> =>
    (
      SlotAllocationService as unknown as {
        findAllocationPreference: (
          ids: string[],
        ) => Promise<AllocationPreference | undefined>;
      }
    ).findAllocationPreference(releasedSlotIds);

  const findFirst = prisma.rescheduleRequest.findFirst as jest.Mock;

  beforeEach(() => findFirst.mockReset());

  it("finds a request whose row is filed against a SIBLING appointment", async () => {
    // The case that made this feature look flaky rather than broken. On a
    // multi-session booking the consultee's reschedule URL resolves to the
    // NEXT ACTIONABLE session (A1) while the picker offers every session, so
    // releasing session 3 files the row against A1 and releases A3's slots.
    // Keying the lookup on appointmentId found nothing and the allocation
    // quietly fell back to first-fit.
    findFirst.mockResolvedValue({
      preferredTimeOfDay: "MORNING",
      preferredDays: null,
    });

    const found = await findAllocationPreference(["a3-slot-1", "a3-slot-2"]);

    expect(found).toEqual({
      preferredTimeOfDay: "MORNING",
      preferredDays: null,
    });

    const where = findFirst.mock.calls[0][0].where;
    // Matched by what was RELEASED, which is the same on every appointment of
    // the booking...
    expect(where.releasedSlotIds).toEqual({
      hasSome: ["a3-slot-1", "a3-slot-2"],
    });
    // ...and never by the appointment the row happens to be filed against.
    expect(where).not.toHaveProperty("appointmentId");
  });

  it("only considers open, preference-bearing requests", async () => {
    findFirst.mockResolvedValue(null);
    await findAllocationPreference(["slot-1"]);

    const where = findFirst.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ["PENDING_REVIEW", "COUNTERED"] });
    expect(where.OR).toEqual([
      { preferredTimeOfDay: { not: null } },
      { preferredDays: { not: null } },
    ]);
  });

  it("does not query at all when nothing was released", async () => {
    // A fresh allocation has no released slots, so there is no reschedule to
    // read a preference from and no reason to touch the database.
    await expect(findAllocationPreference([])).resolves.toBeUndefined();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("returns undefined rather than null when nothing was stated", async () => {
    findFirst.mockResolvedValue(null);
    await expect(findAllocationPreference(["slot-1"])).resolves.toBeUndefined();
  });
});

// ─── The scorer in isolation ────────────────────────────────────────────────

describe("scoreCandidateStart", () => {
  /** An instant at a given IST wall-clock hour on a known weekday. */
  const istAt = (utcDate: string, istHourWanted: number) =>
    new Date(
      `${utcDate}T00:00:00Z`,
    ).getTime() +
    (istHourWanted * 60 - IST_OFFSET) * MINUTE;

  const at = (utcDate: string, hour: number) => new Date(istAt(utcDate, hour));

  // 2026-08-10 is a Monday, 2026-08-08 a Saturday.
  const monday = (hour: number) => at("2026-08-10", hour);
  const saturday = (hour: number) => at("2026-08-08", hour);

  it("scores each stated half independently and equally", () => {
    const both: AllocationPreference = {
      preferredTimeOfDay: "MORNING",
      preferredDays: "WEEKDAYS",
    };
    const max = maxPreferenceScore(both);
    expect(scoreCandidateStart(monday(9), both, IST)).toBe(max);
    // Exactly one half satisfied, either way round, scores the same.
    expect(scoreCandidateStart(monday(15), both, IST)).toBe(max / 2);
    expect(scoreCandidateStart(saturday(9), both, IST)).toBe(max / 2);
    expect(scoreCandidateStart(saturday(15), both, IST)).toBe(0);
  });

  it("covers the whole clock so no time is unscoreable", () => {
    const bands = ["MORNING", "AFTERNOON", "EVENING"] as const;
    for (let hour = 0; hour < 24; hour++) {
      const matches = bands.filter(
        (band) =>
          scoreCandidateStart(monday(hour), { preferredTimeOfDay: band }, IST) >
          0,
      );
      // Exactly one band claims each hour: no gap, no overlap.
      expect(matches).toHaveLength(1);
    }
  });

  it("ranks 2 AM below a real evening without making it unscoreable", () => {
    const evenings: AllocationPreference = { preferredTimeOfDay: "EVENING" };
    const max = maxPreferenceScore(evenings);

    const lateNight = scoreCandidateStart(monday(2), evenings, IST);
    const actualEvening = scoreCandidateStart(monday(19), evenings, IST);

    // Nobody choosing "Evenings" means 2 AM. But the band has to stay total,
    // so the tail scores something — just never enough to win a tie-break, and
    // never enough to satisfy the preferred-only sweep.
    expect(actualEvening).toBe(max);
    expect(lateNight).toBeGreaterThan(0);
    expect(lateNight).toBeLessThan(actualEvening);
  });

  it("gives an evening-preferring consultee 7 PM over an earlier 2 AM", () => {
    // Both rows are legal and 02:00 comes first, so a band that scored the two
    // alike would hand out the 2 AM slot on the chronological tie-break.
    const consultant = weeklyConsultant([
      { day: "MONDAY", startUtc: istToUtcMinutes(2), endUtc: istToUtcMinutes(4) },
      {
        day: "MONDAY",
        startUtc: istToUtcMinutes(19),
        endUtc: istToUtcMinutes(21),
      },
    ]);

    return findAvailableSlots(
      consultant,
      2,
      2,
      "consultation",
      consultationConfig,
      { preferredTimeOfDay: "EVENING" },
    ).then((slots) => expect(istHour(slots[0])).toBe(19));
  });

  it("treats an absent or all-null preference as neutral", () => {
    expect(isEmptyPreference(undefined)).toBe(true);
    expect(isEmptyPreference({ preferredTimeOfDay: null })).toBe(true);
    expect(maxPreferenceScore(undefined)).toBe(0);
    expect(maxPreferenceScore({})).toBe(0);
    expect(scoreCandidateStart(monday(9), undefined, IST)).toBe(0);
  });

  it("never rejects — the scorer has no way to say no", () => {
    // A zero score is still a placeable candidate. This is the type-level half
    // of the rule: there is no boolean here a caller could filter on.
    const worst = scoreCandidateStart(
      saturday(15),
      { preferredTimeOfDay: "MORNING", preferredDays: "WEEKDAYS" },
      IST,
    );
    expect(worst).toBe(0);
    expect(Number.isFinite(worst)).toBe(true);
  });
});

describe("hourInTz / weekdayInTz", () => {
  it("reads the wall clock of the given zone, not the server's", () => {
    // 2026-08-09T20:00:00Z is Sunday in UTC and Monday 01:30 in IST.
    const instant = new Date("2026-08-09T20:00:00Z");
    expect(SlotCalculationService.hourInTz(instant, "UTC")).toBe(20);
    expect(SlotCalculationService.hourInTz(instant, IST)).toBe(1);
    expect(SlotCalculationService.weekdayInTz(instant, "UTC")).toBe(0);
    expect(SlotCalculationService.weekdayInTz(instant, IST)).toBe(1);
  });

  it("reports midnight as hour 0", () => {
    expect(
      SlotCalculationService.hourInTz(
        new Date(new Date("2026-08-10T00:00:00Z").getTime() - HALF_HOUR * 0),
        "UTC",
      ),
    ).toBe(0);
  });
});

/**
 * #1340 — the supersede sweep must skip the proposal being confirmed.
 *
 * `resolveConsumedPreferenceRequests` runs at the end of every allocating
 * transaction and DECLINEs each open reschedule proposal whose released slots
 * this allocation just replaced: placing times IS the answer, so a competing
 * ask must not keep `openForAppointmentId` reserved. The confirmation callers
 * (auto-confirm and the explicit accept) place THEIR OWN proposal's times, so
 * their row matched that predicate too — it was declined here, and the
 * `PENDING_REVIEW → AUTO_ACCEPTED/ACCEPTED` CAS that followed matched zero rows
 * on a booking that had already moved. The exclusion is asserted against the
 * WHERE the sweep actually issues, not against a stubbed outcome.
 */
describe("#1340 — resolveConsumedPreferenceRequests and the confirming proposal", () => {
  const SELF = "resched-being-confirmed";
  const STALE = "resched-stale-other";

  interface SweepWhere {
    id?: { not?: string };
    proposedSlots?: unknown;
  }

  /** A transaction stub that answers the sweep's reads the way Postgres would. */
  function makeTx(openProposalIds: string[]) {
    const declined: string[] = [];
    const tx = {
      rescheduleRequest: {
        // Two reads in order: the preference-only rows first, then every OTHER
        // open proposal on the same released slots.
        findMany: jest.fn(async ({ where }: { where: SweepWhere }) => {
          if (where.proposedSlots) return [];
          const excluded = where.id?.not;
          return openProposalIds
            .filter((id) => id !== excluded)
            .map((id) => ({ id }));
        }),
        findUnique: jest.fn(async () => ({
          status: "PENDING_REVIEW",
          appointmentId: "appt-1",
        })),
        updateMany: jest.fn(
          async ({
            where,
            data,
          }: {
            where: { id: string };
            data: { status: string };
          }) => {
            if (data.status === "DECLINED") declined.push(where.id);
            return { count: 1 };
          },
        ),
      },
      bookingStatusHistory: { create: jest.fn(async () => ({})) },
    };
    return { tx, declined };
  }

  const runSweep = (
    tx: unknown,
    releasedSlotIds: string[],
    excludeRescheduleRequestId?: string,
  ): Promise<void> =>
    (
      SlotAllocationService as unknown as {
        resolveConsumedPreferenceRequests: (...a: unknown[]) => Promise<void>;
      }
    ).resolveConsumedPreferenceRequests(
      tx,
      releasedSlotIds,
      excludeRescheduleRequestId,
    );

  it("declines a different stale proposal on the same slots but never the excluded one", async () => {
    const { tx, declined } = makeTx([SELF, STALE]);

    await runSweep(tx, ["released-slot-1"], SELF);

    expect(declined).toEqual([STALE]);
    const supersedeRead = tx.rescheduleRequest.findMany.mock.calls
      .map(([arg]) => arg.where)
      .find((where) => !where.proposedSlots);
    expect(supersedeRead?.id).toEqual({ not: SELF });
  });

  it("still declines every open proposal when no confirmation is in flight", async () => {
    const { tx, declined } = makeTx([SELF, STALE]);

    await runSweep(tx, ["released-slot-1"]);

    // The consultant placing different times by hand supersedes them all; the
    // exclusion is opt-in and must not weaken that.
    expect(declined.sort()).toEqual([SELF, STALE].sort());
  });
});
