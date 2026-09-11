/**
 * initialAllocation multi-tab guard (service level).
 *
 * Auto locks the whole consultant while manual shards its Redis key by day
 * (#860), so a cross-mode race between two tabs slips past the locks and the
 * manual path would silently delete-and-replace the winner's allocation.
 * With `initialAllocation: true` (sent by the Allocate Slots dialog for fresh
 * PENDING requests) any existing confirmed slot must produce a typed 409.
 * Without the flag, replace/reschedule semantics are preserved.
 */

import "./setup";

// Mock prisma (relative path required — @/ aliases fail in jest.mock)
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    consultation: { findUnique: jest.fn() },
    subscription: { findUnique: jest.fn() },
    webinar: { findUnique: jest.fn() },
    class: { findUnique: jest.fn() },
    appointment: { findMany: jest.fn(), findFirst: jest.fn() },
    slotOfAppointment: { count: jest.fn() },
  },
  ALLOCATION_TX_MAX_WAIT_MS: 8000,
  ALLOCATION_TX_TIMEOUT_MS: 30000,
}));

// Mock SlotValidationService so the race-window test can reach the write
// transaction without a full availability fixture (same pattern as
// slotAllocationService.test.ts).
const mockValidateFn = jest.fn();
const mockRevalidateConflictsFn = jest.fn();
jest.mock("../../utils/slotAllocation/SlotValidationService", () => ({
  ...jest.requireActual("../../utils/slotAllocation/SlotValidationService"),
  SlotValidationService: jest.fn().mockImplementation(() => ({
    validate: mockValidateFn,
    revalidateConflicts: mockRevalidateConflictsFn,
  })),
}));

// Mock appointmentlock to avoid @upstash/redis ESM import issues in Jest
jest.mock("../../utils/appointmentlock", () => ({
  lockAutoAllocate: jest
    .fn()
    .mockResolvedValue({ key: "mock-key", value: "mock-value" }),
  unlockAutoAllocate: jest.fn().mockResolvedValue(undefined),
  lockConsulteeBooking: jest
    .fn()
    .mockResolvedValue({ key: "mock-consultee-key", value: "mock-value" }),
  unlockConsulteeBooking: jest.fn().mockResolvedValue(undefined),
}));

import prisma from "@/lib/prisma";
import { SlotAllocationService } from "@/utils/slotAllocation/SlotAllocationService";

const mockPrisma = prisma as unknown as {
  $transaction: jest.Mock;
  subscription: { findUnique: jest.Mock };
  appointment: { findMany: jest.Mock; findFirst: jest.Mock };
  slotOfAppointment: { count: jest.Mock };
};

const FUTURE_SLOTS = [
  "2026-08-03T09:00:00.000Z",
  "2026-08-03T09:30:00.000Z",
];

beforeEach(() => {
  jest.clearAllMocks();
  // getConsultantProfileId + getConsulteeUserId both read subscription.findUnique
  // with different selects; return a superset that satisfies both.
  mockPrisma.subscription.findUnique.mockResolvedValue({
    subscriptionPlan: { consultantProfileId: "cp-1" },
    requestedBy: { user: { id: "user-1" } },
  });
  mockPrisma.appointment.findFirst.mockResolvedValue(null);
  mockPrisma.appointment.findMany.mockResolvedValue([]);
});

describe("manual allocation with initialAllocation", () => {
  it("returns a typed 409 when another session already confirmed slots", async () => {
    mockPrisma.slotOfAppointment.count.mockResolvedValue(4);

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: FUTURE_SLOTS,
      initialAllocation: true,
    });

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(409);
    expect(result.error).toContain("already allocated in another session");
    // The guard fires before any event data is fetched or written.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("counts only confirmed slots — tentative checkout holds do not trip the guard", async () => {
    mockPrisma.slotOfAppointment.count.mockResolvedValue(0);

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: FUTURE_SLOTS,
      initialAllocation: true,
    });

    // Guard passes (count=0) and the flow proceeds until event data is
    // missing in this harness — a NOT_FOUND, decisively not the 409 guard.
    expect(mockPrisma.slotOfAppointment.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isTentative: false }),
      }),
    );
    expect(result.httpStatus).not.toBe(409);
  });

  it("without the flag, existing confirmed slots do NOT 409 (replace/reschedule preserved)", async () => {
    mockPrisma.slotOfAppointment.count.mockResolvedValue(4);

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: FUTURE_SLOTS,
    });

    expect(mockPrisma.slotOfAppointment.count).not.toHaveBeenCalled();
    expect(result.error).not.toContain("already allocated in another session");
  });
});

describe("manual allocation: transaction race window", () => {
  it("409s when the pre-lock count sees zero but the in-txn count sees confirmed slots", async () => {
    // Tab B commits between tab A's out-of-txn guard and its write txn: the
    // first count returns 0, the advisory-locked in-txn count returns 2.
    mockPrisma.slotOfAppointment.count.mockResolvedValueOnce(0);
    mockPrisma.subscription.findUnique.mockResolvedValue({
      subscriptionPlan: {
        consultantProfileId: "cp-1",
        consultantProfile: {
          user: { id: "consultant-user-1" },
          scheduleType: "WEEKLY",
          slotsOfAvailabilityWeekly: [],
          slotsOfAvailabilityCustom: [],
        },
        durationInMonths: 1,
        sessionsPerWeek: 1,
        sessionDurationInHours: 1,
        totalSessions: 1,
      },
      requestedBy: { user: { id: "user-1" } },
      appointments: [],
      schedulingPeriodStartsAt: new Date("2026-08-02T00:00:00.000Z"),
      schedulingPeriodEndsAt: new Date("2026-08-29T23:59:59.000Z"),
      schedulingTimezone: "Asia/Kolkata",
    });
    mockValidateFn.mockResolvedValue({
      isValid: true,
      errors: [],
      warnings: [],
    });
    mockRevalidateConflictsFn.mockResolvedValue({ isValid: true, errors: [] });

    const mockTx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      slotOfAppointment: { count: jest.fn().mockResolvedValue(2) },
    };
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: FUTURE_SLOTS,
      initialAllocation: true,
    });

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(409);
    // The advisory lock is taken before the in-txn count
    expect(mockTx.$executeRaw).toHaveBeenCalled();
    expect(mockTx.slotOfAppointment.count).toHaveBeenCalled();
  });
});

describe("auto allocation with initialAllocation", () => {
  it("returns a typed 409 when another session already confirmed slots", async () => {
    mockPrisma.slotOfAppointment.count.mockResolvedValue(2);

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "auto",
      initialAllocation: true,
    });

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(409);
    expect(result.error).toContain("already allocated in another session");
  });
});

describe("requested allocation with initialAllocation", () => {
  it("re-checks the guard INSIDE the transaction and 409s", async () => {
    const mockTx = {
      // Advisory xact lock taken before the guard count (ADR B10 atomicity)
      $executeRaw: jest.fn().mockResolvedValue(1),
      slotOfAppointment: { count: jest.fn().mockResolvedValue(2) },
    };
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "requested",
      initialAllocation: true,
    });

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(409);
    expect(mockTx.slotOfAppointment.count).toHaveBeenCalled();
  });
});

describe("advisory lock statement shape (#1518)", () => {
  it("takes the lock through $executeRaw with the per-event key, then continues", async () => {
    // pg_advisory_xact_lock returns void; $queryRaw made the Prisma 7 driver
    // adapter deserialise that column and throw before allocation began.
    const mockTx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([]),
      slotOfAppointment: { count: jest.fn().mockResolvedValue(0) },
    };
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "requested",
      initialAllocation: true,
    });

    expect(mockTx.$queryRaw).not.toHaveBeenCalled();
    expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
    const [fragments, key] = mockTx.$executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      string,
    ];
    expect(Array.from(fragments).join("")).toContain(
      "SELECT pg_advisory_xact_lock(hashtextextended(",
    );
    expect(key).toBe("initial-allocation:subscription:sub-1");
    // The guard ran on past the lock: zero confirmed slots, so no 409.
    expect(mockTx.slotOfAppointment.count).toHaveBeenCalled();
    expect(result.httpStatus).not.toBe(409);
  });
});
