/**
 * #1206 — top-up allocation.
 *
 * A partial allocation confirms N of M sessions and leaves the rest unplaced.
 * Re-running the ordinary auto path to recover them deletes every confirmed
 * appointment (and the Payment rows that cascade off it) and re-plans from
 * scratch, which is why the hourly sweep could never do it. `topUp: true`
 * places only the shortfall and touches nothing that exists.
 *
 * The transaction mock below has no delete members at all: any call into
 * `deleteExistingAppointments` throws instead of quietly passing.
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
    appointment: { findMany: jest.fn(), findUnique: jest.fn() },
    rescheduleRequest: { findFirst: jest.fn() },
  },
  ALLOCATION_TX_MAX_WAIT_MS: 8000,
  ALLOCATION_TX_TIMEOUT_MS: 30000,
}));

// Mock appointmentlock to avoid the @upstash/redis ESM import under Jest.
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

// Slot discovery stays REAL — the weekly-cap seeding and the booked-slot set
// are exactly what must keep the fixed sessions out of the search. Only the
// validators are stubbed, as elsewhere in this folder.
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
import { notifyAppointmentBooked } from "@/lib/novu";
import { SlotAllocationService } from "@/utils/slotAllocation/SlotAllocationService";
import { ScheduleType, DayOfWeek } from "@prisma/client";

/** Mondays 09:00–11:00 UTC — room for one 1-hour session a week, forever. */
const MONDAY_MORNINGS = {
  id: "weekly-monday-9",
  startDay: DayOfWeek.MONDAY,
  endDay: DayOfWeek.MONDAY,
  startTimeUtc: 9 * 60,
  endTimeUtc: 11 * 60,
  utcOffsetMinutes: 0,
};

const mockPrisma = prisma as unknown as {
  $transaction: jest.Mock;
  subscription: { findUnique: jest.Mock };
  appointment: { findMany: jest.Mock; findUnique: jest.Mock };
};

const notifyBooked = notifyAppointmentBooked as jest.Mock;

/** One 1-hour session = two 30-minute atoms, both already confirmed. */
function confirmedSession(id: string, startISO: string) {
  const startsAt = new Date(startISO);
  const midpoint = new Date(startsAt.getTime() + 30 * 60 * 1000);
  return {
    id,
    organizationId: null,
    payment: [],
    slotsOfAppointment: [
      {
        id: `${id}-slot-1`,
        startsAt,
        endsAt: midpoint,
        isTentative: false,
      },
      {
        id: `${id}-slot-2`,
        startsAt: midpoint,
        endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
        isTentative: false,
      },
    ],
  };
}

// Weeks 1 and 2 of a four-session plan are already booked and paid for.
const WEEK_1 = confirmedSession("apt-week-1", "2025-01-06T09:00:00.000Z");
const WEEK_2 = confirmedSession("apt-week-2", "2025-01-13T09:00:00.000Z");
// What the same event looks like once the top-up has run.
const WEEK_3 = confirmedSession("apt-week-3", "2025-01-20T09:00:00.000Z");
const WEEK_4 = confirmedSession("apt-week-4", "2025-01-27T09:00:00.000Z");

function makeSubscription(appointments: ReturnType<typeof confirmedSession>[]) {
  return {
    id: "sub-topup",
    schedulingPeriodStartsAt: new Date("2025-01-06T00:00:00Z"),
    schedulingPeriodEndsAt: new Date("2025-02-28T00:00:00Z"),
    subscriptionPlan: {
      title: "Weekly coaching",
      consultantProfileId: "consultant-profile-1",
      durationInMonths: 2,
      sessionsPerWeek: 1,
      sessionDurationInHours: 1,
      totalSessions: 4,
      consultantProfile: {
        user: { id: "consultant-1", name: "Consultant", timezone: "UTC" },
        scheduleType: ScheduleType.WEEKLY,
        slotsOfAvailabilityWeekly: [MONDAY_MORNINGS],
        slotsOfAvailabilityCustom: [],
      },
    },
    requestedBy: { user: { id: "consultee-1", name: "Consultee" } },
    appointments,
  };
}

/**
 * No `delete`, `deleteMany` or `slotOfAppointment.deleteMany`: the top-up path
 * must never reach `deleteExistingAppointments`, and a call here is a
 * TypeError rather than a silent pass.
 */
function makeNoDeleteTx() {
  return {
    subscription: {
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    consultantProfile: {
      findFirst: jest.fn().mockResolvedValue({ id: "consultant-profile-1" }),
    },
    appointment: {
      findMany: jest.fn().mockResolvedValue([]),
      // #1499 — createAppointments reads the originating appointment to
      // inherit the policy version the booking was sold under. Null here:
      // these fixtures predate the FK, so the created rows carry no policy.
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: `created-${Math.random()}`, ...data }),
        ),
    },
    appointmentParticipant: {
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
    slotOfAppointment: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

let mockTx: ReturnType<typeof makeNoDeleteTx>;

/** Slot start times, in order, of every appointment this run created. */
function createdSlotStarts(): string[] {
  return mockTx.appointment.create.mock.calls.flatMap(
    ([args]: [
      { data: { slotsOfAppointment: { create: { startsAt: Date }[] } } },
    ]) =>
      args.data.slotsOfAppointment.create.map((slot) =>
        slot.startsAt.toISOString(),
      ),
  );
}

/** Let the fire-and-forget notification promise settle. */
async function flushNotifications(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2025-01-01T00:00:00Z"));

  mockTx = makeNoDeleteTx();
  mockPrisma.$transaction.mockImplementation(
    (callback: (tx: typeof mockTx) => unknown) => callback(mockTx),
  );
  mockTx.subscription.findUnique.mockResolvedValue(
    makeSubscription([WEEK_1, WEEK_2]),
  );
  mockPrisma.subscription.findUnique.mockImplementation(() =>
    mockTx.subscription.findUnique(),
  );
  // One array answers all three reads: the event's own appointments, the
  // consultant's occupancy scan and the consultee's. The confirmed sessions
  // therefore block their own intervals, which is what a top-up requires.
  mockPrisma.appointment.findMany.mockResolvedValue([WEEK_1, WEEK_2]);

  mockValidateFn.mockResolvedValue({ isValid: true, errors: [], warnings: [] });
  mockRevalidateConflictsFn.mockResolvedValue({
    isValid: true,
    errors: [],
    warnings: [],
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("#1206 top-up allocation", () => {
  it("places only the two missing sessions and deletes nothing", async () => {
    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-topup",
      mode: "auto",
      topUp: true,
      allowPartial: true,
    });

    expect(result.success).toBe(true);
    expect(result.noChange).toBeUndefined();
    // Two new Appointment rows = the two sessions the plan was short.
    expect(result.appointments).toHaveLength(2);
    // Weeks 1 and 2 are untouched: they are already at the weekly cap and
    // their atoms are in the booked set, so the search skipped straight to
    // weeks 3 and 4.
    expect(createdSlotStarts()).toEqual([
      "2025-01-20T09:00:00.000Z",
      "2025-01-20T09:30:00.000Z",
      "2025-01-27T09:00:00.000Z",
      "2025-01-27T09:30:00.000Z",
    ]);
    // The plan is whole again, so no partial notice is owed.
    expect(result.partial).toBeUndefined();
  });

  it("returns noChange and notifies nobody once the plan is complete", async () => {
    // The state the run above leaves behind: all four sessions confirmed.
    const complete = [WEEK_1, WEEK_2, WEEK_3, WEEK_4];
    mockTx.subscription.findUnique.mockResolvedValue(
      makeSubscription(complete),
    );
    mockPrisma.appointment.findMany.mockResolvedValue(complete);

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-topup",
      mode: "auto",
      topUp: true,
      allowPartial: true,
    });
    await flushNotifications();

    expect(result.success).toBe(true);
    expect(result.noChange).toBe(true);
    // Derived from the shortfall: a whole plan is not partial.
    expect(result.partial).toBe(false);
    expect(result.placedSessions).toBe(0);
    expect(result.requiredSessions).toBe(4);
    expect(result.unplacedSessions).toBe(0);
    // Nothing was written, and — the point of the suppressor — the consultee
    // is not paged by an hourly sweep that changed nothing.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(notifyBooked).not.toHaveBeenCalled();
  });

  it("without the flag, the same event still goes for the delete", async () => {
    // The contrast that makes the pin above mean something. Same fixture, no
    // flag: the ordinary auto path re-plans, which starts by deleting the two
    // paid sessions — and this transaction has no delete to give it.
    mockTx.appointment.findMany.mockResolvedValue([WEEK_1, WEEK_2]);

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-topup",
      mode: "auto",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/delete/i);
  });
});
