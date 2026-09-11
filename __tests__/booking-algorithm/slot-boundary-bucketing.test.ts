/**
 * Scheduling-timezone day/week bucketing tests (ADR B9).
 *
 * Limits bucket by the event's schedulingTimezone (default Asia/Kolkata), so
 * "one session per day" means one session per calendar day AS THE CUSTOMER
 * SEES IT — and the verdict is identical on every machine because the keys
 * come from Intl with an explicit timezone, never from the process locale.
 */

// Deliberately hostile process timezone: if any bucketing accidentally uses
// local time, these tests fail under UTC while production browsers run IST.
process.env.TZ = "UTC";

import "./setup";

import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";
import {
  validateSubscriptionSlots,
  groupSlotsByDay,
  countCompleteCallsInMap,
  dayKey,
  weekKey,
  type SlotLimits,
} from "@/lib/scheduling/slotSelectionValidation";
// eslint-disable-next-line jest/no-mocks-import -- shared fixture builders, not module mocks (suite-wide pattern)
import { makeConsecutiveTimeSlots } from "./__mocks__/booking.mockData";
import type { TimeSlot } from "@/lib/scheduling/calendarUtils";

const limits = (slotsPerSession: number, maxSlots: number): SlotLimits => ({
  minSlots: maxSlots * slotsPerSession,
  maxSlots,
  slotsPerSession,
  totalSessions: maxSlots,
});

// ─── dayKey ─────────────────────────────────────────────────────────────────

describe("dayKey (default Asia/Kolkata)", () => {
  it("keys by the IST calendar day: 19:30Z on Jul 19 is already Jul 20 in IST", () => {
    expect(dayKey(new Date("2026-07-19T19:30:00.000Z"))).toBe("2026-07-20");
  });

  it("18:29Z stays on the same IST day; 18:30Z rolls to the next", () => {
    expect(dayKey(new Date("2026-07-19T18:29:00.000Z"))).toBe("2026-07-19");
    expect(dayKey(new Date("2026-07-19T18:30:00.000Z"))).toBe("2026-07-20");
  });

  it("groups slots that share an IST day even across UTC midnight", () => {
    // 23:30Z Jul 19 and 00:30Z Jul 20 are both Jul 20 in IST.
    const slots = [
      { startTime: new Date("2026-07-19T23:30:00.000Z") },
      { startTime: new Date("2026-07-20T00:30:00.000Z") },
    ] as TimeSlot[];
    const grouped = groupSlotsByDay(slots);
    expect(grouped.size).toBe(1);
    expect(Array.from(grouped.keys())[0]).toBe("2026-07-20");
  });

  it("splits slots that straddle IST midnight even though they share a UTC day", () => {
    // 18:00Z and 19:00Z on Jul 19 are 23:30 IST and 00:30 IST — different IST days.
    const slots = [
      { startTime: new Date("2026-07-19T18:00:00.000Z") },
      { startTime: new Date("2026-07-19T19:00:00.000Z") },
    ] as TimeSlot[];
    expect(groupSlotsByDay(slots).size).toBe(2);
  });

  it("an explicit timezone overrides the default", () => {
    const d = new Date("2026-07-19T19:30:00.000Z");
    expect(dayKey(d, "UTC")).toBe("2026-07-19");
    expect(dayKey(d, "America/New_York")).toBe("2026-07-19"); // 15:30 EDT
    expect(dayKey(d, "Asia/Kolkata")).toBe("2026-07-20");
  });
});

// ─── weekKey ────────────────────────────────────────────────────────────────

describe("weekKey (default Asia/Kolkata)", () => {
  it("Saturday 18:29Z belongs to the ending IST week; 18:30Z starts IST Sunday", () => {
    // 2026-07-18 is a Saturday; 18:30Z is 00:00 IST Sunday Jul 19.
    expect(weekKey(new Date("2026-07-18T18:29:00.000Z"))).toBe("2026-07-12");
    expect(weekKey(new Date("2026-07-18T18:30:00.000Z"))).toBe("2026-07-19");
  });

  it("a slot at 00:30 IST Sunday counts toward the NEW IST week", () => {
    // Sunday 2026-07-19 00:30 IST = Saturday 2026-07-18 19:00Z.
    expect(weekKey(new Date("2026-07-18T19:00:00.000Z"))).toBe("2026-07-19");
  });

  it("matches startOfWeekSundayInTz exactly", () => {
    const d = new Date("2026-07-15T10:00:00.000Z");
    const weekStartInstant = SlotCalculationService.startOfWeekSundayInTz(d);
    // The instant is Sunday 00:00 IST = Saturday 18:30Z.
    expect(weekStartInstant.toISOString()).toBe("2026-07-11T18:30:00.000Z");
    expect(SlotCalculationService.dayKey(weekStartInstant)).toBe(weekKey(d));
  });

  it("handles a DST-observing timezone (Europe/London week boundary)", () => {
    // Sunday 2026-03-29 is the BST switch day. 23:30Z Saturday Mar 28 is
    // 23:30 GMT (winter time still) → Saturday → week of Mar 22.
    expect(weekKey(new Date("2026-03-28T23:30:00.000Z"), "Europe/London")).toBe(
      "2026-03-22",
    );
    // 00:30Z Sunday Mar 29 is 00:30 GMT → Sunday → week of Mar 29.
    expect(weekKey(new Date("2026-03-29T00:30:00.000Z"), "Europe/London")).toBe(
      "2026-03-29",
    );
  });
});

// ─── client/server bucketing parity ─────────────────────────────────────────

describe("client/server bucketing parity at day boundaries", () => {
  it("a session crossing UTC midnight within one IST day is ONE complete call", () => {
    // 23:30Z–00:30Z = 05:00–06:00 IST on Jul 21: one 1-hour session, one IST day.
    const slots = makeConsecutiveTimeSlots(
      "2026-07-20T23:30:00.000Z",
      2,
    ) as TimeSlot[];
    const result = validateSubscriptionSlots(
      slots,
      { sessionsPerWeek: 1, sessionDurationInHours: 1 },
      limits(2, 4),
    );
    expect(result.dailyCallsValid).toBe(true);
    expect(result.weeklyCallsValid).toBe(true);
    expect(result.incompleteCallWarning).toBeUndefined();
  });

  it("a session straddling IST midnight is split across two IST days (no complete call)", () => {
    // 18:00Z–19:00Z on Mon Jul 20 = 23:30 IST Mon → 00:30 IST Tue.
    const slots = makeConsecutiveTimeSlots(
      "2026-07-20T18:00:00.000Z",
      2,
    ) as TimeSlot[];
    // Each IST day holds one lone slot — the pair never forms a complete
    // same-day call, so it can't consume a weekly-limit unit.
    const byDay = groupSlotsByDay(slots);
    expect(byDay.size).toBe(2);
    expect(countCompleteCallsInMap(byDay, 2)).toBe(0);
  });

  it("weekly limit counts a Sunday-01:00-IST session in the NEW IST week", () => {
    // sessionsPerWeek = 1. Session A: Wed Jul 15 10:00Z. Session B starts
    // Sat Jul 18 19:30Z = Sunday 01:00 IST — a NEW IST week, so both fit.
    const slots = [
      ...makeConsecutiveTimeSlots("2026-07-15T10:00:00.000Z", 2),
      ...makeConsecutiveTimeSlots("2026-07-18T19:30:00.000Z", 2),
    ] as TimeSlot[];
    const result = validateSubscriptionSlots(
      slots,
      { sessionsPerWeek: 1, sessionDurationInHours: 1 },
      limits(2, 4),
    );
    expect(result.weeklyCallsValid).toBe(true);
  });

  it("weekly limit blocks two sessions inside the same IST week", () => {
    // Wed Jul 15 and Sat Jul 18 17:00Z (22:30 IST Saturday — same IST week).
    const slots = [
      ...makeConsecutiveTimeSlots("2026-07-15T10:00:00.000Z", 2),
      ...makeConsecutiveTimeSlots("2026-07-18T17:00:00.000Z", 2),
    ] as TimeSlot[];
    const result = validateSubscriptionSlots(
      slots,
      { sessionsPerWeek: 1, sessionDurationInHours: 1 },
      limits(2, 4),
    );
    expect(result.weeklyCallsValid).toBe(false);
    expect(result.weeklyCallsError).toContain("Maximum 1 per week");
  });

  it("client groupSlotsByDay and SlotCalculationService.groupSlotsByDay agree on boundary slots", () => {
    const boundarySlots = [
      { startTime: new Date("2026-07-19T18:00:00.000Z"), endTime: new Date("2026-07-19T18:30:00.000Z") },
      { startTime: new Date("2026-07-19T18:30:00.000Z"), endTime: new Date("2026-07-19T19:00:00.000Z") },
      { startTime: new Date("2026-07-20T00:00:00.000Z"), endTime: new Date("2026-07-20T00:30:00.000Z") },
    ] as TimeSlot[];
    const clientKeys = Array.from(groupSlotsByDay(boundarySlots).keys()).sort();
    const serverKeys = Array.from(
      SlotCalculationService.groupSlotsByDay(
        boundarySlots as unknown as Parameters<
          typeof SlotCalculationService.groupSlotsByDay
        >[0],
      ).keys(),
    ).sort();
    expect(clientKeys).toEqual(serverKeys);
  });
});
