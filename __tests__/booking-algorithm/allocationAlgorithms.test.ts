/**
 * Tests for AllocationAlgorithms, the client's pre-validation + submission
 * layer.
 *
 * Covers:
 * - manualAllocate (validation, business rules, error handling)
 * - allocateRequestedSlots (validation, delegation; formerly preAllocate)
 *
 * The auto cases that used to live here exercised the client auto-allocator
 * (strategies, scoring, weekly distribution) deleted in #997/#1132 — product
 * code has picked slots server-side since #997 Phase 1. Auto is covered by
 * slotAllocationService.test.ts and preference-scored-allocation.test.ts.
 */

import "./setup";

import {
  AllocationAlgorithms,
  type AllocationOptions,
} from "@/lib/scheduling/allocationAlgorithms";
import { AllocationService } from "@/lib/scheduling/allocationService";
// eslint-disable-next-line jest/no-mocks-import -- shared fixture builders, not module mocks (suite-wide pattern)
import {
  makeTimeSlot,
  makeConsecutiveTimeSlots,
} from "./__mocks__/booking.mockData";

// Use jest.spyOn instead of jest.mock to avoid bracket-path resolution issue
let mockAllocateSlots: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  mockAllocateSlots = jest
    .spyOn(AllocationService, "allocateSlots")
    .mockResolvedValue({ success: true });
});

afterEach(() => {
  jest.useRealTimers();
  mockAllocateSlots.mockRestore();
});

// ─── Helper: create future slots ────────────────────────────────────────────

function makeFutureConsecutiveSlots(
  startISO: string,
  count: number,
  overrides: Partial<{ isBooked: boolean; isAvailable: boolean }> = {},
) {
  return makeConsecutiveTimeSlots(startISO, count, overrides);
}

// ─── manualAllocate ─────────────────────────────────────────────────────────

describe("AllocationAlgorithms.manualAllocate", () => {
  const baseOptions: AllocationOptions = {
    eventType: "consultation",
    eventId: "event-1",
    durationInHours: 1,
  };

  it("should reject when slot count doesn't match required", async () => {
    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 1);
    const result = await AllocationAlgorithms.manualAllocate(
      slots as any,
      baseOptions,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Expected 2 slots but received 1");
  });

  it("should reject past slots", async () => {
    const slots = makeFutureConsecutiveSlots("2024-01-01T09:00:00Z", 2);
    const result = await AllocationAlgorithms.manualAllocate(
      slots as any,
      baseOptions,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("past");
  });

  it("should accept valid consultation slots", async () => {
    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 2);
    const result = await AllocationAlgorithms.manualAllocate(
      slots as any,
      baseOptions,
    );
    expect(result.success).toBe(true);
    expect(result.strategy).toBe("manual");
    expect(mockAllocateSlots).toHaveBeenCalledTimes(1);
  });

  it("should reject non-consecutive webinar slots", async () => {
    const slots = [
      makeTimeSlot("2025-06-01T09:00:00Z", "2025-06-01T09:30:00Z"),
      makeTimeSlot("2025-06-01T10:00:00Z", "2025-06-01T10:30:00Z"),
    ];

    const result = await AllocationAlgorithms.manualAllocate(slots as any, {
      ...baseOptions,
      eventType: "webinar",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("consecutive");
  });

  it("should accept consecutive webinar slots", async () => {
    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 2);
    const result = await AllocationAlgorithms.manualAllocate(slots as any, {
      ...baseOptions,
      eventType: "webinar",
    });
    expect(result.success).toBe(true);
  });

  it("should require sessionsPerWeek for subscription", async () => {
    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 2);
    const result = await AllocationAlgorithms.manualAllocate(slots as any, {
      eventType: "subscription",
      eventId: "event-1",
      durationInHours: 1,
      startDate: new Date("2025-06-01"),
      endDate: new Date("2025-06-07"),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Calls per week is required");
  });

  it("should validate slot distribution for subscriptions", async () => {
    // 4 slots total (matches required: 0.5hr × 1 call/wk × 4 weeks = 4 slots)
    // but 3 are in the same week → exceeds sessionsPerWeek = 1
    const slots = [
      makeTimeSlot("2025-06-02T09:00:00Z", "2025-06-02T09:30:00Z"),
      makeTimeSlot("2025-06-03T09:00:00Z", "2025-06-03T09:30:00Z"),
      makeTimeSlot("2025-06-04T09:00:00Z", "2025-06-04T09:30:00Z"),
      makeTimeSlot("2025-06-09T09:00:00Z", "2025-06-09T09:30:00Z"),
    ];

    const result = await AllocationAlgorithms.manualAllocate(slots as any, {
      eventType: "subscription",
      eventId: "event-1",
      durationInHours: 0.5,
      sessionsPerWeek: 1,
      startDate: new Date("2025-06-01"),
      endDate: new Date("2025-06-28"),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Too many slots");
  });

  it("should handle AllocationService failure", async () => {
    mockAllocateSlots.mockResolvedValue({
      success: false,
      error: "Server error",
    });

    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 2);
    const result = await AllocationAlgorithms.manualAllocate(
      slots as any,
      baseOptions,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("Server error");
  });

  it("should handle thrown errors gracefully", async () => {
    mockAllocateSlots.mockRejectedValue(new Error("Network error"));

    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 2);
    const result = await AllocationAlgorithms.manualAllocate(
      slots as any,
      baseOptions,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("Network error");
  });

  // ─── In-progress reallocation (pastConfirmedSlotCount) ───────────────────

  it("should adjust required slots for in-progress class with past slots", async () => {
    // Class: 4 total sessions × 2 slots/session = 8 total required
    // Past: 4 slots (2 sessions completed)
    // Expected: 4 future slots needed
    const futureSlots = makeFutureConsecutiveSlots("2025-06-02T09:00:00Z", 4);
    const result = await AllocationAlgorithms.manualAllocate(
      futureSlots as any,
      {
        eventType: "class",
        eventId: "class-1",
        sessionDurationInHours: 1,
        sessionsPerWeek: 2,
        durationInMonths: 1,
        startDate: new Date("2025-05-01"),
        endDate: new Date("2025-06-30"),
        totalSessions: 4,
        pastConfirmedSlotCount: 4,
      },
    );
    expect(result.success).toBe(true);
  });

  it("should reject wrong slot count for in-progress class", async () => {
    // Class: 4 total sessions × 2 slots = 8 total required
    // Past: 4 slots → need 4 future, but providing 8
    const futureSlots = makeFutureConsecutiveSlots("2025-06-02T09:00:00Z", 8);
    const result = await AllocationAlgorithms.manualAllocate(
      futureSlots as any,
      {
        eventType: "class",
        eventId: "class-1",
        sessionDurationInHours: 1,
        sessionsPerWeek: 2,
        durationInMonths: 1,
        startDate: new Date("2025-05-01"),
        endDate: new Date("2025-06-30"),
        totalSessions: 4,
        pastConfirmedSlotCount: 4,
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Expected 4 slots but received 8");
  });

  it("should adjust required slots for in-progress subscription with past slots", async () => {
    // Subscription: 2 calls/week × 4 weeks = 8 total required (1hr = 2 slots each)
    // Past: 4 slots (2 sessions completed)
    // Expected: 4 future slots needed
    const futureSlots = makeFutureConsecutiveSlots("2025-06-02T09:00:00Z", 4);
    const result = await AllocationAlgorithms.manualAllocate(
      futureSlots as any,
      {
        eventType: "subscription",
        eventId: "sub-1",
        sessionDurationInHours: 1,
        sessionsPerWeek: 2,
        durationInMonths: 1,
        startDate: new Date("2025-05-01"),
        endDate: new Date("2025-06-30"),
        totalSessions: 4,
        pastConfirmedSlotCount: 4,
      },
    );
    expect(result.success).toBe(true);
  });

  it("should reject wrong slot count for in-progress subscription", async () => {
    // Subscription: 4 total sessions × 2 slots = 8 total required
    // Past: 4 slots → need 4 future, but providing 8
    const futureSlots = makeFutureConsecutiveSlots("2025-06-02T09:00:00Z", 8);
    const result = await AllocationAlgorithms.manualAllocate(
      futureSlots as any,
      {
        eventType: "subscription",
        eventId: "sub-1",
        sessionDurationInHours: 1,
        sessionsPerWeek: 2,
        durationInMonths: 1,
        startDate: new Date("2025-05-01"),
        endDate: new Date("2025-06-30"),
        totalSessions: 4,
        pastConfirmedSlotCount: 4,
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Expected 4 slots but received 8");
  });

  it("should not adjust required slots for non-recurring events", async () => {
    // Consultation: pastConfirmedSlotCount should be ignored
    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 2);
    const result = await AllocationAlgorithms.manualAllocate(slots as any, {
      ...baseOptions,
      pastConfirmedSlotCount: 4, // should be ignored for consultations
    });
    expect(result.success).toBe(true);
  });
});

// ─── allocateRequestedSlots ─────────────────────────────────────────────────

describe("AllocationAlgorithms.allocateRequestedSlots", () => {
  it("should reject when no requested slots provided", async () => {
    const result = await AllocationAlgorithms.allocateRequestedSlots({
      eventType: "consultation",
      eventId: "event-1",
      durationInHours: 1,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("No requested slots");
  });

  it("should reject when requested slots is empty array", async () => {
    const result = await AllocationAlgorithms.allocateRequestedSlots({
      eventType: "consultation",
      eventId: "event-1",
      durationInHours: 1,
      requestedSlots: [],
    });
    expect(result.success).toBe(false);
  });

  it("should reject wrong number of requested slots", async () => {
    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 1);
    const result = await AllocationAlgorithms.allocateRequestedSlots({
      eventType: "consultation",
      eventId: "event-1",
      durationInHours: 1,
      requestedSlots: slots as any,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Requested 1 slots but need 2");
  });

  it("should succeed with correct number of slots", async () => {
    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 2);
    const result = await AllocationAlgorithms.allocateRequestedSlots({
      eventType: "consultation",
      eventId: "event-1",
      durationInHours: 1,
      requestedSlots: slots as any,
    });
    expect(result.success).toBe(true);
    expect(result.strategy).toBe("requested-slots");
    expect(mockAllocateSlots).toHaveBeenCalledWith(
      "consultation",
      "event-1",
      slots,
      {
        useRequestedSlots: true,
        idempotencyKey: undefined,
        initialAllocation: undefined,
      },
    );
  });

  it("should handle AllocationService failure", async () => {
    mockAllocateSlots.mockResolvedValue({
      success: false,
      error: "Slot taken",
    });

    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 2);
    const result = await AllocationAlgorithms.allocateRequestedSlots({
      eventType: "consultation",
      eventId: "event-1",
      durationInHours: 1,
      requestedSlots: slots as any,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Slot taken");
  });

  it("should handle thrown errors", async () => {
    mockAllocateSlots.mockRejectedValue(new Error("Connection failed"));

    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 2);
    const result = await AllocationAlgorithms.allocateRequestedSlots({
      eventType: "consultation",
      eventId: "event-1",
      durationInHours: 1,
      requestedSlots: slots as any,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Connection failed");
  });
});
