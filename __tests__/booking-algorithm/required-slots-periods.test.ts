/**
 * Required-slot math across month lengths and event types.
 *
 * Pins countWeeks over 28/29/30/31-day scheduling periods (including a leap
 * February and a 31-day month spanning six Sunday weeks) and the full
 * calculateRequiredSlots matrix for every event type, sessionsPerWeek 1–7, and
 * session durations 0.5–2h. Also pins the totalSessions-authoritative rule
 * and the throw for a subscription with no period.
 */

process.env.TZ = "Asia/Kolkata";

import "./setup";

import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";

// ─── countWeeks across month lengths ────────────────────────────────────────

describe("countWeeks month-length permutations", () => {
  it("28-day February 2027 (starts Monday) spans 5 Sunday weeks", () => {
    // Feb 1 2027 is a Monday, Feb 28 a Sunday → weeks of Jan 31, Feb 7, 14, 21, 28.
    expect(
      SlotCalculationService.countWeeks(
        new Date("2027-02-01T00:00:00.000Z"),
        new Date("2027-02-28T23:59:59.000Z"),
      ),
    ).toBe(5);
  });

  it("29-day leap February 2028 (starts Tuesday) spans 5 Sunday weeks", () => {
    // Feb 1 2028 is a Tuesday, Feb 29 a Tuesday → weeks of Jan 30, Feb 6, 13, 20, 27.
    expect(
      SlotCalculationService.countWeeks(
        new Date("2028-02-01T00:00:00.000Z"),
        new Date("2028-02-29T23:59:59.000Z"),
      ),
    ).toBe(5);
  });

  it("30-day June 2026 (starts Monday) spans 5 Sunday weeks", () => {
    expect(
      SlotCalculationService.countWeeks(
        new Date("2026-06-01T00:00:00.000Z"),
        new Date("2026-06-30T23:59:59.000Z"),
      ),
    ).toBe(5);
  });

  it("31-day August 2026 starting on a Saturday spans 6 Sunday weeks", () => {
    // Aug 1 2026 is a Saturday → weeks of Jul 26, Aug 2, 9, 16, 23, 30.
    expect(
      SlotCalculationService.countWeeks(
        new Date("2026-08-01T00:00:00.000Z"),
        new Date("2026-08-31T23:59:59.000Z"),
      ),
    ).toBe(6);
  });

  it("an exact Sunday-to-Saturday 28-day window spans exactly 4 weeks", () => {
    // Jun 21 2026 is a Sunday; Jul 18 2026 is a Saturday.
    expect(
      SlotCalculationService.countWeeks(
        new Date("2026-06-21T00:00:00.000Z"),
        new Date("2026-07-18T23:59:59.000Z"),
      ),
    ).toBe(4);
  });

  it("a mid-week 30-day rolling window (like the checkout default) spans 5 weeks", () => {
    // Jun 21 → Jul 21 2026 (the screenshot scenario): Sun-start through Tue.
    expect(
      SlotCalculationService.countWeeks(
        new Date("2026-06-21T15:19:00.000Z"),
        new Date("2026-07-21T15:19:00.000Z"),
      ),
    ).toBe(5);
  });
});

// ─── calculateRequiredSlots matrix ──────────────────────────────────────────

describe("calculateRequiredSlots per event type", () => {
  const durations = [0.5, 1, 1.5, 2];

  it.each(durations)(
    "consultation of %sh needs ceil(d/0.5) slots",
    (duration) => {
      expect(
        SlotCalculationService.calculateRequiredSlots("consultation", {
          durationInHours: duration,
        }),
      ).toBe(Math.ceil(duration / 0.5));
    },
  );

  it.each(durations)("webinar of %sh needs ceil(d/0.5) slots", (duration) => {
    expect(
      SlotCalculationService.calculateRequiredSlots("webinar", {
        durationInHours: duration,
      }),
    ).toBe(Math.ceil(duration / 0.5));
  });

  it("subscription matrix: sessionsPerWeek 1–7 × duration 0.5–2h over an exact 4-week period", () => {
    const schedulingPeriodStartsAt = new Date("2026-06-21T00:00:00.000Z"); // Sunday
    const schedulingPeriodEndsAt = new Date("2026-07-18T23:59:59.000Z"); // Saturday
    for (let sessionsPerWeek = 1; sessionsPerWeek <= 7; sessionsPerWeek++) {
      for (const sessionDurationInHours of durations) {
        const slotsPerCall = Math.ceil(sessionDurationInHours / 0.5);
        expect(
          SlotCalculationService.calculateRequiredSlots("subscription", {
            schedulingPeriodStartsAt,
            schedulingPeriodEndsAt,
            sessionsPerWeek,
            sessionDurationInHours,
          }),
        ).toBe(4 * sessionsPerWeek * slotsPerCall);
      }
    }
  });

  it("class matrix mirrors subscription math", () => {
    const schedulingPeriodStartsAt = new Date("2026-06-21T00:00:00.000Z");
    const schedulingPeriodEndsAt = new Date("2026-07-18T23:59:59.000Z");
    for (let sessionsPerWeek = 1; sessionsPerWeek <= 7; sessionsPerWeek++) {
      for (const sessionDurationInHours of durations) {
        const slotsPerSession = Math.ceil(sessionDurationInHours / 0.5);
        expect(
          SlotCalculationService.calculateRequiredSlots("class", {
            schedulingPeriodStartsAt,
            schedulingPeriodEndsAt,
            sessionsPerWeek,
            sessionDurationInHours,
          }),
        ).toBe(4 * sessionsPerWeek * slotsPerSession);
      }
    }
  });

  it("totalSessions from the plan overrides weeks × sessionsPerWeek (28-day period spanning 5 weeks)", () => {
    // Rolling 28-day window that touches 5 Sunday weeks — the plan's 4
    // sessions win over 5 × sessionsPerWeek.
    expect(
      SlotCalculationService.calculateRequiredSlots("subscription", {
        schedulingPeriodStartsAt: new Date("2026-06-24T00:00:00.000Z"), // Wednesday
        schedulingPeriodEndsAt: new Date("2026-07-21T23:59:59.000Z"),
        sessionsPerWeek: 1,
        sessionDurationInHours: 1,
        totalSessions: 4,
      }),
    ).toBe(4 * 2);
  });

  it("subscription without a scheduling period throws (no silent 4-weeks/month guess)", () => {
    expect(() =>
      SlotCalculationService.calculateRequiredSlots("subscription", {
        sessionsPerWeek: 1,
        sessionDurationInHours: 1,
        durationInMonths: 1,
      }),
    ).toThrow(/Start date and end date are required/);
  });

  it("class without a scheduling period throws", () => {
    expect(() =>
      SlotCalculationService.calculateRequiredSlots("class", {
        sessionsPerWeek: 1,
        sessionDurationInHours: 1,
      }),
    ).toThrow(/Start date and end date are required/);
  });
});
