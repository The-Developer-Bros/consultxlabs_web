/**
 * Mode parity: the surviving client allocation entry points (manual /
 * requested) must agree on required-slot math — including the in-progress
 * reschedule reduction. Auto mode has no client engine left to compare since
 * #997/#1132 (the server picks under `isAuto`), so the auto cases here — which
 * only ever exercised the deleted client oracle — are gone; the server's picks
 * are covered by slotAllocationService.test.ts ("Auto allocation", "Auto
 * allocation - timezone day shift") and preference-scored-allocation.test.ts.
 */

process.env.TZ = "Asia/Kolkata";

import "./setup";

import {
  AllocationAlgorithms,
  type AllocationOptions,
} from "@/lib/scheduling/allocationAlgorithms";
import { AllocationService } from "@/lib/scheduling/allocationService";
import {
  validateEventSlots,
  getEventConstraints,
  getSlotLimits,
} from "@/lib/scheduling/slotSelectionValidation";
import { type TimeSlot } from "@/lib/scheduling/calendarUtils";
// eslint-disable-next-line jest/no-mocks-import -- shared fixture builders, not module mocks (suite-wide pattern)
import { makeConsecutiveTimeSlots } from "./__mocks__/booking.mockData";

let mockAllocateSlots: jest.SpyInstance;

beforeEach(() => {
  mockAllocateSlots = jest
    .spyOn(AllocationService, "allocateSlots")
    .mockResolvedValue({ success: true, data: [] });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// Pin the clock so Aug 2026 fixtures stay "future" vs `new Date()` past-slot
// guards in AllocationAlgorithms — otherwise CI fails once wall-clock catches
// up (as of 2026-08-03 09:00Z the first fixture day is already past).
beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
  jest.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
});
afterAll(() => {
  jest.useRealTimers();
});

describe("required-count parity across the surviving modes", () => {
  const base: AllocationOptions = {
    eventType: "subscription",
    eventId: "sub-1",
    sessionsPerWeek: 1,
    sessionDurationInHours: 1,
    startDate: new Date("2026-08-02T00:00:00.000Z"),
    endDate: new Date("2026-08-29T23:59:59.000Z"),
    totalSessions: 4, // 4 sessions × 2 atoms = 8 slots
  };

  it("manual and requested reject the same wrong count with the same expectation", async () => {
    const sixSlots = [
      ...makeConsecutiveTimeSlots("2026-08-03T09:00:00.000Z", 2),
      ...makeConsecutiveTimeSlots("2026-08-10T09:00:00.000Z", 2),
      ...makeConsecutiveTimeSlots("2026-08-17T09:00:00.000Z", 2),
    ] as TimeSlot[];

    const manual = await AllocationAlgorithms.manualAllocate(sixSlots, base);
    expect(manual.success).toBe(false);
    expect(manual.error).toContain("Expected 8 slots but received 6");

    const requested = await AllocationAlgorithms.allocateRequestedSlots({
      ...base,
      requestedSlots: sixSlots,
    });
    expect(requested.success).toBe(false);
    expect(requested.error).toContain("Requested 6 slots but need 8");
  });

  it("requested honors pastConfirmedSlotCount like manual (in-progress reschedule)", async () => {
    // 1 of 4 sessions already confirmed in the past → only 6 future atoms due.
    const withPast = { ...base, pastConfirmedSlotCount: 2 };
    const sixSlots = [
      ...makeConsecutiveTimeSlots("2026-08-03T09:00:00.000Z", 2),
      ...makeConsecutiveTimeSlots("2026-08-10T09:00:00.000Z", 2),
      ...makeConsecutiveTimeSlots("2026-08-17T09:00:00.000Z", 2),
    ] as TimeSlot[];

    const manual = await AllocationAlgorithms.manualAllocate(
      sixSlots,
      withPast,
    );
    expect(manual.success).toBe(true);

    const requested = await AllocationAlgorithms.allocateRequestedSlots({
      ...withPast,
      requestedSlots: sixSlots,
    });
    expect(requested.success).toBe(true);
    expect(mockAllocateSlots).toHaveBeenCalledTimes(2);
  });

  it("requested honors totalSessions as authoritative (previously ignored)", async () => {
    // Period spans 4 weeks × 1 call = 4 sessions, but the plan says 2.
    const twoSessionPlan = { ...base, totalSessions: 2 };
    const fourSlots = [
      ...makeConsecutiveTimeSlots("2026-08-03T09:00:00.000Z", 2),
      ...makeConsecutiveTimeSlots("2026-08-10T09:00:00.000Z", 2),
    ] as TimeSlot[];

    const requested = await AllocationAlgorithms.allocateRequestedSlots({
      ...twoSessionPlan,
      requestedSlots: fourSlots,
    });
    expect(requested.success).toBe(true);
  });
});

describe("getSlotLimits defensive bounds", () => {
  it("maxSlots floors at 0 when past sessions exceed the plan total (over-allocated data)", () => {
    const limits = getSlotLimits("subscription", {
      sessionDurationInHours: 1,
      maxTotalCalls: 4,
      // 6 past sessions × 2 atoms — more than the plan's 4 sessions
      pastConfirmedSlotCount: 12,
      sessionsPerWeek: 1,
      startDate: new Date("2026-08-02T00:00:00.000Z"),
      endDate: new Date("2026-08-29T23:59:59.000Z"),
    });
    expect(limits.maxSlots).toBe(0);
  });
});

describe("consecutive-atom rules at the scheduling-timezone day boundary", () => {
  it("a consultation straddling IST midnight is rejected (same-day rule, server parity)", () => {
    // 18:00Z–19:00Z = 23:30–00:30 IST: consecutive but on two IST days.
    const straddling = makeConsecutiveTimeSlots(
      "2026-08-03T18:00:00.000Z",
      2,
    ) as TimeSlot[];
    const options = { durationInHours: 1 };
    const verdict = validateEventSlots(
      straddling,
      "consultation",
      getEventConstraints("consultation", options),
      getSlotLimits("consultation", options),
      options,
    );
    expect(verdict.isValid).toBe(false);
    expect(verdict.errors.join(" ")).toContain("same day");
  });

  it("1.5h and 2h sessions require 3 and 4 consecutive same-day atoms", () => {
    for (const [duration, atoms] of [
      [1.5, 3],
      [2, 4],
    ] as const) {
      const options = { durationInHours: duration };
      const consecutive = makeConsecutiveTimeSlots(
        "2026-08-03T09:00:00.000Z",
        atoms,
      ) as TimeSlot[];
      const gappy = [
        ...makeConsecutiveTimeSlots("2026-08-03T09:00:00.000Z", atoms - 1),
        ...makeConsecutiveTimeSlots("2026-08-03T14:00:00.000Z", 1),
      ] as TimeSlot[];

      const good = validateEventSlots(
        consecutive,
        "consultation",
        getEventConstraints("consultation", options),
        getSlotLimits("consultation", options),
        options,
      );
      expect(good.isValid).toBe(true);

      const bad = validateEventSlots(
        gappy,
        "consultation",
        getEventConstraints("consultation", options),
        getSlotLimits("consultation", options),
        options,
      );
      expect(bad.isValid).toBe(false);
    }
  });
});
