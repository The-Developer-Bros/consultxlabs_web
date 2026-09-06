/**
 * #1012 — expectedTentativeSlotCount stale-tab reschedule precondition.
 */

import "./setup";

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

const mockValidateFn = jest.fn();
const mockRevalidateConflictsFn = jest.fn();
jest.mock("../../utils/slotAllocation/SlotValidationService", () => ({
  ...jest.requireActual("../../utils/slotAllocation/SlotValidationService"),
  SlotValidationService: jest.fn().mockImplementation(() => ({
    validate: mockValidateFn,
    revalidateConflicts: mockRevalidateConflictsFn,
  })),
}));

jest.mock("../../utils/appointmentlock", () => ({
  lockAutoAllocate: jest
    .fn()
    .mockResolvedValue({ key: "mock-key", value: "mock-value" }),
  unlockAutoAllocate: jest.fn().mockResolvedValue(undefined),
  lockConsulteeBooking: jest
    .fn()
    .mockResolvedValue({ key: "mock-consultee-key", value: "mock-value" }),
  unlockConsulteeBooking: jest.fn().mockResolvedValue(undefined),
  lockManualAllocate: jest
    .fn()
    .mockResolvedValue({ key: "mock-manual-key", value: "mock-value" }),
  unlockManualAllocate: jest.fn().mockResolvedValue(undefined),
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

const richSubscription = {
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
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.subscription.findUnique.mockResolvedValue(richSubscription);
  mockPrisma.appointment.findFirst.mockResolvedValue(null);
  mockPrisma.slotOfAppointment.count.mockResolvedValue(0);
});

describe("#1012 expectedTentativeSlotCount", () => {
  it("returns 409 when the page's tentative count no longer matches", async () => {
    // First tab already finished: zero tentative, two confirmed.
    mockPrisma.appointment.findMany.mockResolvedValue([
      {
        id: "appt-1",
        slotsOfAppointment: [
          {
            id: "s1",
            startsAt: new Date(FUTURE_SLOTS[0]),
            endsAt: new Date("2026-08-03T09:30:00.000Z"),
            isTentative: false,
          },
          {
            id: "s2",
            startsAt: new Date(FUTURE_SLOTS[1]),
            endsAt: new Date("2026-08-03T10:00:00.000Z"),
            isTentative: false,
          },
        ],
      },
    ]);

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: FUTURE_SLOTS,
      // Stale tab still thinks the reschedule has 2 tentative slots.
      expectedTentativeSlotCount: 2,
    });

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(409);
    expect(result.error).toMatch(/Reschedule state changed/);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("proceeds past the precondition when the tentative count matches", async () => {
    mockPrisma.appointment.findMany.mockResolvedValue([
      {
        id: "appt-1",
        slotsOfAppointment: [
          {
            id: "s1",
            startsAt: new Date(FUTURE_SLOTS[0]),
            endsAt: new Date("2026-08-03T09:30:00.000Z"),
            isTentative: true,
          },
          {
            id: "s2",
            startsAt: new Date(FUTURE_SLOTS[1]),
            endsAt: new Date("2026-08-03T10:00:00.000Z"),
            isTentative: true,
          },
        ],
      },
    ]);

    // Validation will fail later (incomplete mock fixture) — we only assert
    // that the #1012 guard did NOT 409 on a matching count.
    mockValidateFn.mockResolvedValue({
      isValid: false,
      errors: ["fixture incomplete"],
      warnings: [],
    });

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: FUTURE_SLOTS,
      expectedTentativeSlotCount: 2,
    });

    expect(result.httpStatus).not.toBe(409);
    expect(result.error ?? "").not.toMatch(/Reschedule state changed/);
  });

  it("skips the precondition when expectedTentativeSlotCount is omitted", async () => {
    mockPrisma.appointment.findMany.mockResolvedValue([
      {
        id: "appt-1",
        slotsOfAppointment: [
          {
            id: "s1",
            startsAt: new Date(FUTURE_SLOTS[0]),
            endsAt: new Date("2026-08-03T09:30:00.000Z"),
            isTentative: false,
          },
        ],
      },
    ]);
    mockValidateFn.mockResolvedValue({
      isValid: false,
      errors: ["fixture incomplete"],
      warnings: [],
    });

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: FUTURE_SLOTS,
    });

    expect(result.error ?? "").not.toMatch(/Reschedule state changed/);
  });

  it("re-asserts the tentative count inside the write transaction", async () => {
    // Pre-txn view still matches (2 tentative) so we enter the write txn;
    // inside the txn another tab already confirmed — in-txn re-read 409s.
    const matchingTentative = [
      {
        id: "appt-1",
        slotsOfAppointment: [
          {
            id: "s1",
            startsAt: new Date(FUTURE_SLOTS[0]),
            endsAt: new Date("2026-08-03T09:30:00.000Z"),
            isTentative: true,
          },
          {
            id: "s2",
            startsAt: new Date(FUTURE_SLOTS[1]),
            endsAt: new Date("2026-08-03T10:00:00.000Z"),
            isTentative: true,
          },
        ],
      },
    ];
    const confirmedAfterRace = [
      {
        id: "appt-1",
        slotsOfAppointment: [
          {
            id: "s1",
            startsAt: new Date(FUTURE_SLOTS[0]),
            endsAt: new Date("2026-08-03T09:30:00.000Z"),
            isTentative: false,
          },
          {
            id: "s2",
            startsAt: new Date(FUTURE_SLOTS[1]),
            endsAt: new Date("2026-08-03T10:00:00.000Z"),
            isTentative: false,
          },
        ],
      },
    ];
    mockPrisma.appointment.findMany.mockResolvedValue(matchingTentative);
    mockValidateFn.mockResolvedValue({
      isValid: true,
      errors: [],
      warnings: [],
    });
    mockRevalidateConflictsFn.mockResolvedValue({
      isValid: true,
      errors: [],
      warnings: [],
    });

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        appointment: {
          findMany: jest.fn().mockResolvedValue(confirmedAfterRace),
          findFirst: jest.fn().mockResolvedValue(null),
        },
        slotOfAppointment: {
          count: jest.fn().mockResolvedValue(0),
        },
      };
      return fn(tx);
    });

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: FUTURE_SLOTS,
      expectedTentativeSlotCount: 2,
    });

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(409);
    expect(result.error).toMatch(/Reschedule state changed/);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });
});
