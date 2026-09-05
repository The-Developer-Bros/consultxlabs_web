/**
 * AE-2 (#784) — the co-host guard runs in EVERY allocation mode.
 *
 * `assertCollaboratorsAvailable` used to be called from exactly one place (the
 * webinar crud-with-plan PATCH), so a class scheduled through the allocator
 * could be committed onto a time an ACCEPTED co-host was already busy for.
 * Co-hosts are not slot participants, so neither slot_no_confirmed_overlap nor
 * the owner-scoped validators can see the clash.
 */

import "./setup";

import fs from "fs";
import path from "path";

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

/** One weekly availability row, in the shape ConsultantAllocationData wants. */
const weeklyRow = (
  day: DayOfWeek,
  startHourUtc: number,
  endHourUtc: number,
) => ({
  id: `weekly-${day}-${startHourUtc}`,
  startDay: day,
  startTimeUtc: startHourUtc * 60,
  endDay: day,
  endTimeUtc: endHourUtc * 60,
  utcOffsetMinutes: 0,
});

/** Monday 2025-01-06, the first Monday after the frozen clock. */
const MON_0900 = "2025-01-06T09:00:00.000Z";
const MON_0930 = "2025-01-06T09:30:00.000Z";

function makeMockTx() {
  return {
    class: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    webinar: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    consultation: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    subscription: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    consultantProfile: {
      findFirst: jest.fn().mockResolvedValue({ id: "consultant-profile-1" }),
    },
    // AE-2 — the two reads the guard makes.
    collaborator: { findMany: jest.fn().mockResolvedValue([]) },
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
      create: jest
        .fn()
        .mockResolvedValue({ id: "apt-1", slotsOfAppointment: [] }),
      update: jest
        .fn()
        .mockResolvedValue({ id: "apt-1", slotsOfAppointment: [] }),
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
}

function makeConsultantProfile() {
  return {
    user: { id: "consultant-user-1", timezone: "UTC" },
    scheduleType: ScheduleType.WEEKLY,
    slotsOfAvailabilityWeekly: [weeklyRow(DayOfWeek.MONDAY, 9, 11)],
    slotsOfAvailabilityCustom: [],
  };
}

function makeClassEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "class-1",
    classPlanId: "class-plan-1",
    classPlan: {
      id: "class-plan-1",
      consultantProfileId: "consultant-profile-1",
      durationInMonths: 1,
      sessionsPerWeek: 1,
      sessionDurationInHours: 1,
      consultantProfile: makeConsultantProfile(),
      classContents: [],
    },
    schedulingPeriodStartsAt: new Date("2025-01-06T00:00:00Z"),
    schedulingPeriodEndsAt: new Date("2025-01-10T00:00:00Z"),
    appointments: [],
    ...overrides,
  };
}

function makeWebinarEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "webinar-1",
    webinarPlanId: "webinar-plan-1",
    webinarPlan: {
      id: "webinar-plan-1",
      consultantProfileId: "consultant-profile-1",
      durationInHours: 1,
      consultantProfile: makeConsultantProfile(),
    },
    ...overrides,
  };
}

/** One ACCEPTED co-host who is busy at the times under test. */
function busyCoHost(mockTx: ReturnType<typeof makeMockTx>) {
  mockTx.collaborator.findMany.mockResolvedValue([
    {
      consultantProfileId: "co-host-profile-1",
      consultantProfile: { user: { name: "Priya" } },
    },
  ]);
  mockTx.slotOfAppointment.findFirst.mockResolvedValue({ id: "busy-slot-1" });
}

let mockTx: ReturnType<typeof makeMockTx>;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2025-01-01T00:00:00Z"));

  mockTx = makeMockTx();
  (prisma.$transaction as jest.Mock).mockImplementation(
    async (callback: (tx: unknown) => unknown) => callback(mockTx),
  );

  const base = prisma as unknown as Record<string, Record<string, jest.Mock>>;
  base.appointment = mockTx.appointment;
  base.class.findUnique = mockTx.class.findUnique;
  base.webinar.findUnique = mockTx.webinar.findUnique;
  mockTx.class.findUnique.mockResolvedValue(makeClassEvent());
  mockTx.webinar.findUnique.mockResolvedValue(makeWebinarEvent());
  base.rescheduleRequest.findFirst.mockResolvedValue(null);

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

describe("AE-2 (#784) — a busy co-host blocks a class in every mode", () => {
  it("rejects AUTO allocation with a typed 409", async () => {
    busyCoHost(mockTx);

    const result = await SlotAllocationService.allocate({
      eventType: "class",
      eventId: "class-1",
      mode: "auto",
    });

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(409);
    expect(result.errorCode).toBe("COLLABORATOR_UNAVAILABLE");
    expect(result.error).toContain("Priya");
    // The guard fires BEFORE any appointment is written.
    expect(mockTx.appointment.create).not.toHaveBeenCalled();
  });

  it("rejects MANUAL allocation with a typed 409", async () => {
    busyCoHost(mockTx);

    const result = await SlotAllocationService.allocate({
      eventType: "class",
      eventId: "class-1",
      mode: "manual",
      slots: [MON_0900, MON_0930],
    });

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(409);
    expect(result.errorCode).toBe("COLLABORATOR_UNAVAILABLE");
    expect(mockTx.appointment.create).not.toHaveBeenCalled();
  });

  /**
   * The requested path carries the same guard, but a class/webinar cannot
   * reach it today: fetchEventData only derives `requestedSlots` for
   * consultation/subscription, so useRequestedSlots 400s on a group event
   * before any co-host is consulted. Pinned here so the guard is not mistaken
   * for dead code, and so this changes loudly if group events ever gain the
   * path.
   */
  it("carries the guard on the REQUESTED path, which group events cannot reach yet", async () => {
    busyCoHost(mockTx);
    mockTx.appointment.findMany.mockResolvedValue([
      {
        id: "apt-req-1",
        slotsOfAppointment: [
          {
            id: "s1",
            startsAt: new Date(MON_0900),
            endsAt: new Date(MON_0930),
            isTentative: true,
            completionStatus: "SCHEDULED",
          },
        ],
      },
    ]);

    const result = await SlotAllocationService.allocate({
      eventType: "class",
      eventId: "class-1",
      mode: "requested",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No requested slots found");
    // Nothing was confirmed, so no co-host could be double-booked either way.
    expect(mockTx.slotOfAppointment.updateMany).not.toHaveBeenCalled();

    // The guard IS wired into the requested transaction, between validation
    // and the isTentative flip that confirms the stored times.
    const source = fs.readFileSync(
      path.join(process.cwd(), "utils/slotAllocation/SlotAllocationService.ts"),
      "utf8",
    );
    const requestedBody = source.slice(
      source.indexOf("private static async useRequestedSlots("),
      source.indexOf("private static isWithinAvailability("),
    );
    expect(requestedBody).toContain(
      "SlotAllocationService.assertCollaboratorsFree(",
    );
    expect(requestedBody.indexOf("assertCollaboratorsFree(")).toBeLessThan(
      requestedBody.indexOf("await this.updateEventStatus("),
    );
  });

  it("merges the session's 30-minute atoms into ONE overlap window", async () => {
    // Free co-host: the fast-path probe runs and finds nothing.
    mockTx.collaborator.findMany.mockResolvedValue([
      {
        consultantProfileId: "co-host-profile-1",
        consultantProfile: { user: { name: "Priya" } },
      },
    ]);

    const result = await SlotAllocationService.allocate({
      eventType: "class",
      eventId: "class-1",
      mode: "manual",
      slots: [MON_0900, MON_0930],
    });

    expect(result.success).toBe(true);
    const where = mockTx.slotOfAppointment.findFirst.mock.calls[0][0].where as {
      OR: { startsAt: { lt: Date }; endsAt: { gt: Date } }[];
      isTentative?: boolean;
    };
    // Two contiguous atoms collapse to a single 09:00-10:00 range.
    expect(where.OR).toHaveLength(1);
    expect(where.OR[0].startsAt.lt.toISOString()).toBe(
      "2025-01-06T10:00:00.000Z",
    );
    expect(where.OR[0].endsAt.gt.toISOString()).toBe(MON_0900);
    // #1319 — occupancy, not the tentative flag, decides what blocks a co-host.
    expect(where.isTentative).toBeUndefined();
  });
});

describe("AE-2 — the webinar path is unchanged", () => {
  it("allocates a webinar with no co-hosts without probing for clashes", async () => {
    const result = await SlotAllocationService.allocate({
      eventType: "webinar",
      eventId: "webinar-1",
      mode: "auto",
    });

    expect(result.success).toBe(true);
    // No accepted collaborators → the guard short-circuits before any probe.
    expect(mockTx.collaborator.findMany).toHaveBeenCalledTimes(1);
    expect(mockTx.slotOfAppointment.findFirst).not.toHaveBeenCalled();
  });

  it("still blocks a webinar whose co-host is busy", async () => {
    busyCoHost(mockTx);

    const result = await SlotAllocationService.allocate({
      eventType: "webinar",
      eventId: "webinar-1",
      mode: "auto",
    });

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(409);
    expect(result.errorCode).toBe("COLLABORATOR_UNAVAILABLE");
  });
});

describe("AE-2 — non-collaborative event types skip the guard", () => {
  it("never reads collaborators for a consultation", async () => {
    (
      prisma as unknown as Record<string, Record<string, jest.Mock>>
    ).consultation.findUnique = mockTx.consultation.findUnique;
    mockTx.consultation.findUnique.mockResolvedValue({
      id: "consult-1",
      consultationPlan: {
        consultantProfileId: "consultant-profile-1",
        durationInHours: 1,
        consultantProfile: makeConsultantProfile(),
      },
      requestedBy: { user: { id: "consultee-1" } },
      appointment: null,
    });

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    expect(result.success).toBe(true);
    expect(mockTx.collaborator.findMany).not.toHaveBeenCalled();
  });
});
