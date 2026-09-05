/**
 * Allocation-time org metering must resolve the same assignment checkout does.
 *
 * SUBSCRIPTION is the only event type whose engagements are debited lazily, at
 * allocation rather than at checkout, so `recordSubscriptionAllocationCap`
 * re-resolves the ProgramAssignment itself. It re-implemented checkout's
 * resolver but dropped `status: "ACTIVE"` (#1132), so a ROLLED / CLOSED /
 * CANCELLED assignment whose period window still covered today could be
 * debited by a session booked months later.
 */

import "../booking-algorithm/setup";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    consultation: { findUnique: jest.fn() },
    subscription: { findUnique: jest.fn() },
    webinar: { findUnique: jest.fn() },
    class: { findUnique: jest.fn() },
    appointment: { findMany: jest.fn() },
    rescheduleRequest: { findFirst: jest.fn() },
  },
  ALLOCATION_TX_MAX_WAIT_MS: 8000,
  ALLOCATION_TX_TIMEOUT_MS: 30000,
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
}));

const recordBookingUtilization = jest.fn().mockResolvedValue({
  wasOverage: false,
  engagementsConsumedDelta: 0,
  engagementsUsedAfter: 0,
  cap: null,
  programType: "LICENSED_SEAT",
  consumedPaiseAfter: 0,
  creditBudgetPaise: null,
});
const reverseBookingUtilization = jest.fn().mockResolvedValue({
  reversed: true,
  engagementsReversed: 1,
  fullyReversed: false,
});
jest.mock("../../lib/api/organizations/program-helpers", () => ({
  __esModule: true,
  recordBookingUtilization: (...args: unknown[]) =>
    recordBookingUtilization(...args),
  reverseBookingUtilization: (...args: unknown[]) =>
    reverseBookingUtilization(...args),
  ProgramAssignmentLimitError: class ProgramAssignmentLimitError extends Error {},
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

import prisma from "@/lib/prisma";
import { SlotAllocationService } from "@/utils/slotAllocation/SlotAllocationService";
import { ScheduleType, DayOfWeek } from "@prisma/client";

const base = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const MON_0900 = "2025-01-06T09:00:00.000Z";
const MON_0930 = "2025-01-06T09:30:00.000Z";

const ORG_PAYMENT = {
  id: "pay-1",
  organizationId: "org-1",
  amount: 500_000,
  createdAt: new Date("2024-12-01T00:00:00Z"),
};

/** The org-funded signup placeholder the lazy debit hangs off. */
function subscriptionFixture() {
  return {
    id: "sub-1",
    subscriptionPlan: {
      consultantProfileId: "consultant-profile-1",
      durationInMonths: 1,
      sessionsPerWeek: 1,
      sessionDurationInHours: 1,
      totalSessions: 1,
      consultantProfile: {
        user: { id: "consultant-user-1", timezone: "UTC" },
        scheduleType: ScheduleType.WEEKLY,
        slotsOfAvailabilityWeekly: [
          {
            id: "weekly-mon",
            startDay: DayOfWeek.MONDAY,
            startTimeUtc: 9 * 60,
            endDay: DayOfWeek.MONDAY,
            endTimeUtc: 11 * 60,
            utcOffsetMinutes: 0,
          },
        ],
        slotsOfAvailabilityCustom: [],
      },
    },
    requestedBy: { user: { id: "consultee-1" } },
    schedulingPeriodStartsAt: new Date("2025-01-06T00:00:00Z"),
    schedulingPeriodEndsAt: new Date("2025-01-10T00:00:00Z"),
    appointments: [
      {
        id: "placeholder-apt",
        organizationId: "org-1",
        slotsOfAppointment: [],
        payment: [ORG_PAYMENT],
      },
    ],
  };
}

const mockTx = {
  subscription: {
    findUnique: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    update: jest.fn(),
  },
  consultantProfile: {
    findFirst: jest.fn().mockResolvedValue({ id: "consultant-profile-1" }),
  },
  collaborator: { findMany: jest.fn().mockResolvedValue([]) },
  membership: { findUnique: jest.fn() },
  programAssignment: { findFirst: jest.fn() },
  bookingUtilization: { findUnique: jest.fn(), update: jest.fn() },
  // #1319 A9/A12 — allocation shadow-writes the participant edge and
  // appends status history inside the CAS helpers.
  appointmentParticipant: {
    createMany: jest.fn().mockResolvedValue({ count: 1 }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
  appointment: {
    findMany: jest.fn().mockResolvedValue([]),
    // #1499 — createAppointments reads the originating appointment to
    // inherit the policy version the booking was sold under. Null here:
    // these fixtures predate the FK, so the created rows carry no policy.
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
    update: jest.fn(),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  slotOfAppointment: {
    findFirst: jest.fn().mockResolvedValue(null),
    update: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
  },
  $queryRaw: jest.fn().mockResolvedValue([]),
};

/** The dead assignment whose period window still covers "now". */
const ROLLED_ASSIGNMENT = { id: "assign-rolled" };

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2025-01-01T00:00:00Z"));

  (prisma.$transaction as jest.Mock).mockImplementation(
    async (callback: (tx: unknown) => unknown) => callback(mockTx),
  );
  base.appointment = mockTx.appointment;
  base.subscription.findUnique = mockTx.subscription.findUnique;
  base.rescheduleRequest.findFirst.mockResolvedValue(null);

  mockTx.subscription.findUnique.mockResolvedValue(subscriptionFixture());
  mockTx.appointment.findMany.mockResolvedValue([]);
  mockTx.appointment.create.mockResolvedValue({
    id: "apt-new-1",
    slotsOfAppointment: [],
  });
  mockTx.membership.findUnique.mockResolvedValue({
    id: "membership-1",
    status: "ACTIVE",
  });
  mockTx.bookingUtilization.findUnique.mockResolvedValue(null);
  // Simulates the DB: the row is ROLLED, so it only comes back when the query
  // forgets to filter on status.
  mockTx.programAssignment.findFirst.mockImplementation(
    async (args: { where?: { status?: string } }) =>
      args?.where?.status === "ACTIVE" ? null : ROLLED_ASSIGNMENT,
  );
  recordBookingUtilization.mockClear();
  reverseBookingUtilization.mockClear();

  mockValidateFn.mockReset();
  mockValidateFn.mockResolvedValue({ isValid: true, errors: [], warnings: [] });
  mockRevalidateConflictsFn.mockReset();
  mockRevalidateConflictsFn.mockResolvedValue({
    isValid: true,
    errors: [],
    warnings: [],
  });
});

afterEach(() => {
  jest.useRealTimers();
});

async function allocateOneSession() {
  return SlotAllocationService.allocate({
    eventType: "subscription",
    eventId: "sub-1",
    mode: "manual",
    slots: [MON_0900, MON_0930],
  });
}

describe("#1132 — a dead assignment cannot be debited at allocation time", () => {
  it("filters the allocation-time resolve on status: ACTIVE", async () => {
    const result = await allocateOneSession();

    expect(result.error).toBeUndefined();
    expect(mockTx.programAssignment.findFirst).toHaveBeenCalled();
    const where = mockTx.programAssignment.findFirst.mock.calls[0][0].where;
    expect(where.status).toBe("ACTIVE");
  });

  it("skips the debit when the only in-window assignment is ROLLED", async () => {
    const result = await allocateOneSession();

    expect(result.success).toBe(true);
    // The ROLLED row is invisible to the filtered query, so nothing is metered.
    expect(recordBookingUtilization).not.toHaveBeenCalled();
  });

  it("still debits when the in-window assignment is ACTIVE", async () => {
    mockTx.programAssignment.findFirst.mockResolvedValue({ id: "assign-live" });

    const result = await allocateOneSession();

    expect(result.success).toBe(true);
    expect(recordBookingUtilization).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        programAssignmentId: "assign-live",
        paymentId: "pay-1",
        appointmentIds: ["apt-new-1"],
      }),
    );
  });
});

describe("removed subscription sessions return the engagement", () => {
  /**
   * Three sessions were metered; this allocation replaces them with one. The
   * substitution below cancels exactly one of them out — the other two were
   * removed and never re-created, and used to stay debited forever.
   */
  function trackedThreeSessions() {
    mockTx.programAssignment.findFirst.mockResolvedValue({ id: "assign-live" });
    mockTx.bookingUtilization.findUnique.mockResolvedValue({
      id: "util-1",
      appointmentIds: ["apt-old-1", "apt-old-2", "apt-old-3"],
    });
  }

  it("reverses the net removal when 3 sessions become 1", async () => {
    trackedThreeSessions();
    // Post-delete/post-create state: only the placeholder and the new session
    // are still live, so all three tracked ids are stale.
    mockTx.subscription.findUnique.mockResolvedValue({
      ...subscriptionFixture(),
      appointments: [
        {
          id: "placeholder-apt",
          organizationId: "org-1",
          slotsOfAppointment: [],
          payment: [ORG_PAYMENT],
        },
        {
          id: "apt-new-1",
          organizationId: "org-1",
          slotsOfAppointment: [],
          payment: [],
        },
      ],
    });

    const result = await allocateOneSession();

    expect(result.error).toBeUndefined();
    expect(reverseBookingUtilization).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        paymentId: "pay-1",
        engagementsToReverse: 2,
      }),
    );
    // One stale id was substituted by the new session, so nothing new is
    // debited on top of the reversal.
    expect(recordBookingUtilization).not.toHaveBeenCalled();
  });

  it("reverses nothing on a like-for-like reschedule", async () => {
    mockTx.programAssignment.findFirst.mockResolvedValue({ id: "assign-live" });
    mockTx.bookingUtilization.findUnique.mockResolvedValue({
      id: "util-1",
      appointmentIds: ["apt-old-1"],
    });
    mockTx.subscription.findUnique.mockResolvedValue({
      ...subscriptionFixture(),
      appointments: [
        {
          id: "placeholder-apt",
          organizationId: "org-1",
          slotsOfAppointment: [],
          payment: [ORG_PAYMENT],
        },
        {
          id: "apt-new-1",
          organizationId: "org-1",
          slotsOfAppointment: [],
          payment: [],
        },
      ],
    });

    const result = await allocateOneSession();

    expect(result.error).toBeUndefined();
    // One out, one in: the substitution absorbs it entirely.
    expect(reverseBookingUtilization).not.toHaveBeenCalled();
    expect(recordBookingUtilization).not.toHaveBeenCalled();
  });

  it("reverses nothing when no tracked session went away", async () => {
    mockTx.programAssignment.findFirst.mockResolvedValue({ id: "assign-live" });
    mockTx.bookingUtilization.findUnique.mockResolvedValue({
      id: "util-1",
      appointmentIds: ["apt-old-1"],
    });
    mockTx.subscription.findUnique.mockResolvedValue({
      ...subscriptionFixture(),
      appointments: [
        {
          id: "placeholder-apt",
          organizationId: "org-1",
          slotsOfAppointment: [],
          payment: [ORG_PAYMENT],
        },
        {
          id: "apt-old-1",
          organizationId: "org-1",
          slotsOfAppointment: [],
          payment: [],
        },
        {
          id: "apt-new-1",
          organizationId: "org-1",
          slotsOfAppointment: [],
          payment: [],
        },
      ],
    });

    const result = await allocateOneSession();

    expect(result.error).toBeUndefined();
    expect(reverseBookingUtilization).not.toHaveBeenCalled();
    // The new session is genuinely additional, so it IS debited.
    expect(recordBookingUtilization).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({ appointmentIds: ["apt-new-1"] }),
    );
  });
});
