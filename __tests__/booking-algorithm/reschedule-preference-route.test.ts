/**
 * @jest-environment node
 */

/**
 * POST /api/appointments/[id]/reschedule — the preference-only request (#1065).
 *
 * Releasing without naming a time used to write NO RescheduleRequest at all, so
 * a stated preference had nowhere to live. It now opens the same record with an
 * empty proposal, and three properties of that row are load-bearing:
 *
 *  1. It claims `openForAppointmentId`. That nullable-unique is the ONLY thing
 *     enforcing "at most one live reschedule per appointment", and the
 *     consultant's request card, the withdraw route and slotsAllowReschedule
 *     all read that as given. A row that opted out could shadow a real proposal.
 *  2. It reports `rescheduleRequestId: null`. The caller reads that id as "your
 *     times were sent"; a preference names no times, and the auto-confirm pass
 *     keys off it too.
 *  3. It stores `releasedSlotIds`, which is what the allocator later matches the
 *     preference on — not the appointment the row is filed against.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    appointment: { findUnique: jest.fn().mockResolvedValue(null) },
    dispute: { findFirst: jest.fn().mockResolvedValue(null) },
  },
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  eventMutationLimiter: {},
}));
jest.mock("../../utils/appointmentlock", () => ({
  __esModule: true,
  withAppointmentLock: jest.fn(
    async (_id: string, fn: () => Promise<unknown>) => fn(),
  ),
  BookingLockUnavailableError: class extends Error {},
  AppointmentBusyError: class extends Error {},
}));
jest.mock("../../lib/auth-server", () => ({ getSession: jest.fn() }));
jest.mock("../../lib/activity/log-activity", () => ({
  logActivity: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyAppointmentRescheduled: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/booking/reschedule-auto-confirm", () => ({
  tryAutoConfirmProposal: jest.fn().mockResolvedValue({ confirmed: false }),
}));

import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { tryAutoConfirmProposal } from "@/lib/booking/reschedule-auto-confirm";
import { POST as rescheduleHandler } from "@/app/api/appointments/[appointmentId]/reschedule/route";

const APPOINTMENT_ID = "apt-1";
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

function consulteeSession() {
  return {
    user: {
      id: "consultee-user",
      name: "John Doe",
      role: "CONSULTEE",
      consultantProfileId: null,
      consulteeProfileId: "ce-001",
    },
  };
}

/** A two-session subscription; both sessions are released together. */
function subscriptionAppointment() {
  return {
    id: APPOINTMENT_ID,
    appointmentType: "SUBSCRIPTION",
    organizationId: null,
    slotsOfAppointment: [
      { id: "slot-1", appointmentId: APPOINTMENT_ID, startsAt: FUTURE },
    ],
    consultation: null,
    subscription: {
      id: "sub-1",
      subscriptionPlan: {
        title: "Test Plan",
        consultantProfileId: "cp-001",
        consultantProfile: {
          id: "cp-001",
          user: { id: "consultant-user", name: "Dr. Smith" },
        },
      },
      requestedById: "ce-001",
      requestedBy: { id: "ce-001", user: { id: "consultee-user" } },
    },
    webinar: null,
    class: null,
  };
}

/**
 * Sibling sessions live on their own appointments, which is the whole reason
 * the row's appointmentId is not a safe key for the preference.
 */
const SIBLING_SLOTS = [
  // `completionStatus` is `@default(SCHEDULED)` and non-nullable; whole-series
  // flows now filter on SLOT_RESCHEDULABLE_FROM so a delivered session cannot
  // brick the aggregate request, and an unset fixture reads as not-live.
  {
    id: "slot-1",
    appointmentId: APPOINTMENT_ID,
    startsAt: FUTURE,
    completionStatus: "SCHEDULED",
  },
  {
    id: "slot-2",
    appointmentId: "apt-2",
    startsAt: FUTURE,
    completionStatus: "SCHEDULED",
  },
];

let createdData: Record<string, unknown> | null = null;

function makeMockTx() {
  return {
    appointment: {
      findUnique: jest.fn().mockResolvedValue(subscriptionAppointment()),
      findMany: jest.fn().mockResolvedValue([
        { id: APPOINTMENT_ID, slotsOfAppointment: [SIBLING_SLOTS[0]] },
        { id: "apt-2", slotsOfAppointment: [SIBLING_SLOTS[1]] },
      ]),
    },
    // Each transition helper reads the from-status before its CAS and appends
    // one BookingStatusHistory row after it.
    subscription: {
      findUnique: jest.fn().mockResolvedValue({ status: "APPROVED" }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(1),
    },
    consultation: {
      findUnique: jest.fn().mockResolvedValue({ status: "APPROVED" }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    webinar: {
      findUnique: jest.fn().mockResolvedValue({ status: "SCHEDULED" }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    class: {
      findUnique: jest.fn().mockResolvedValue({ status: "SCHEDULED" }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
    slotOfAppointment: {
      findMany: jest.fn().mockResolvedValue([]),
      updateManyAndReturn: jest
        .fn()
        .mockResolvedValue([{ id: "slot-1" }, { id: "slot-2" }]),
    },
    rescheduleRequest: {
      create: jest.fn().mockImplementation(({ data }) => {
        createdData = data;
        return Promise.resolve({ id: "rr-1" });
      }),
    },
  };
}

function post(body: Record<string, unknown>) {
  return new Request(
    `http://localhost/api/appointments/${APPOINTMENT_ID}/reschedule?type=SUBSCRIPTION`,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    },
  ) as never;
}

const params = { params: Promise.resolve({ appointmentId: APPOINTMENT_ID }) };

describe("reschedule route — preference without times", () => {
  let mockTx: ReturnType<typeof makeMockTx>;

  beforeEach(() => {
    jest.clearAllMocks();
    createdData = null;
    mockTx = makeMockTx();
    (getSession as jest.Mock).mockResolvedValue(consulteeSession());
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: (tx: unknown) => unknown) => callback(mockTx),
    );
  });

  it("opens a request carrying the preference and no proposed times", async () => {
    const res = await rescheduleHandler(
      post({ preferredTimeOfDay: "MORNING", preferredDays: "WEEKDAYS" }),
      params,
    );

    expect(res.status).toBe(200);
    expect(mockTx.rescheduleRequest.create).toHaveBeenCalledTimes(1);

    // The enums round-trip exactly as the allocator will read them.
    expect(createdData?.preferredTimeOfDay).toBe("MORNING");
    expect(createdData?.preferredDays).toBe("WEEKDAYS");
    expect(createdData?.proposedSlots).toEqual({ create: [] });
  });

  it("claims the openForAppointmentId reservation like any other reschedule", async () => {
    await rescheduleHandler(post({ preferredTimeOfDay: "EVENING" }), params);

    // Load-bearing: this nullable-unique is the only guard behind "at most one
    // live reschedule per appointment", which four readers assume.
    expect(createdData?.openForAppointmentId).toBe(APPOINTMENT_ID);
  });

  it("stores every released slot, including a sibling appointment's", async () => {
    await rescheduleHandler(post({ preferredDays: "WEEKENDS" }), params);

    // This is what the allocator matches the preference on. A row filed against
    // apt-1 must still carry apt-2's slot, or releasing a later session loses
    // the preference entirely.
    expect(createdData?.releasedSlotIds).toEqual(["slot-1", "slot-2"]);
  });

  it("reports no rescheduleRequestId and never tries to auto-confirm", async () => {
    const res = await rescheduleHandler(
      post({ preferredTimeOfDay: "MORNING" }),
      params,
    );
    const body = await res.json();

    // The caller reads this id as "your requested time has been sent"; nothing
    // was requested, so it must stay null and the message must be the ordinary
    // release copy.
    expect(body.rescheduleRequestId).toBeNull();
    expect(body.message).toMatch(/marked for rescheduling/);
    expect(tryAutoConfirmProposal).not.toHaveBeenCalled();
  });

  it("opens no request at all when neither times nor a preference are given", async () => {
    const res = await rescheduleHandler(post({}), params);

    expect(res.status).toBe(200);
    // Unchanged behaviour: a bare release still writes nothing, so it cannot
    // strand a reservation.
    expect(mockTx.rescheduleRequest.create).not.toHaveBeenCalled();
  });

  it("rejects a preference value outside the enum", async () => {
    const res = await rescheduleHandler(
      post({ preferredTimeOfDay: "LATE_NIGHT" }),
      params,
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_PROPOSAL");
    expect(mockTx.rescheduleRequest.create).not.toHaveBeenCalled();
  });
});
