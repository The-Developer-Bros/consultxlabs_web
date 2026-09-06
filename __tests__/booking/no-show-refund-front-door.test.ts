/**
 * @jest-environment node
 */

/**
 * E2E-audit P1 — consultant no-show refunds must go through the booking
 * front door, and must not skip credit-funded bookings.
 *
 * Two defects, one job (`detect-consultant-no-shows`, hourly):
 *
 * 1. It refunded via raw `refundPayment`, which only understands gateway
 *    intents. An ORG-FUNDED booking carries an internal intent id
 *    (org_wallet_ / org_invoice_ / org_license_), so the call threw
 *    UNKNOWN_GATEWAY *after* the booking had already been claimed as
 *    CANCELLED — stranding a PENDING refund placeholder until the reconcile
 *    cron failed it a day later. `refundBookingPayment` is the front door
 *    that splits the gateway / in-ledger-org / credits rails (doctrine
 *    rule 3).
 *
 * 2. Both the candidate query and the payment picker required `amount > 0`,
 *    so a session paid entirely out of referral credits was invisible to the
 *    job: the consultant no-showed, and the consultee got neither a
 *    cancellation nor their credits back.
 */

import "../booking-algorithm/setup";

const refundBookingPayment = jest.fn();
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  __esModule: true,
  refundBookingPayment: (...a: unknown[]) =>
    refundBookingPayment(...(a as [never])),
}));

// The raw gateway-only refund must never be reached from this job again.
const refundPayment = jest.fn();
jest.mock("../../lib/payments/operations/refund", () => ({
  __esModule: true,
  refundPayment: (...a: unknown[]) => refundPayment(...(a as [never])),
}));

// `clearMocks: true` wipes implementations before every test, so the
// resolved value is re-armed in beforeEach — the job does
// `recordSystemError(...).catch(...)` and needs a real promise back.
const recordSystemError = jest.fn();
jest.mock("../../lib/enterprise/system-events", () => ({
  __esModule: true,
  recordSystemError: (...a: unknown[]) => recordSystemError(...(a as [never])),
}));

jest.mock("../../lib/novu/service", () => ({
  __esModule: true,
  notifyAppointmentCancelled: jest.fn(),
  notifyRefundProcessed: jest.fn(),
}));

// #1493 — claimConsultantNoShow now runs the cancel through
// transitionConsultationRequest inside prisma.$transaction, so the mock needs
// $transaction (running its callback against this same client),
// consultation.findUnique (the helper's pre-read of the from-status), and
// bookingStatusHistory.create (the audit row the helper appends).
jest.mock("../../lib/prisma", () => {
  const client: Record<string, unknown> = {
    consultation: {
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({
        status: "APPROVED",
        appointment: { id: "appt-1" },
      }),
    },
    slotOfAppointment: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    bookingStatusHistory: {
      create: jest.fn().mockResolvedValue({}),
    },
    $disconnect: jest.fn(),
  };
  client.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(client));
  return { __esModule: true, default: client };
});

// #1280 — the detector now corroborates against Stream before refunding,
// because our attendance rows come from per-participant webhook deliveries that
// can be lost independently. These cases model a no-show Stream AGREES with:
// exactly one participant was in the call. Without this the suite exercises the
// refusal path instead, and no refund fires at all.
jest.mock("../../lib/stream/call-presence", () => ({
  getCallPresenceEvidence: jest.fn(async () => ({
    unique: 1,
    maxConcurrent: 1,
  })),
}));

jest.mock("../../lib/support/create-ticket", () => ({
  createSupportTicket: jest.fn(async () => ({ id: "ticket-1" })),
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
}));

import prisma from "../../lib/prisma";
import { detectConsultantNoShows } from "../../scripts/appointments/detect-consultant-no-shows";

const CONSULTANT_USER = "user-consultant";
const CONSULTEE_USER = "user-consultee";

/**
 * A candidate the job will classify as a real no-show: the consultee
 * attended, the consultant did not.
 */
function noShowCandidate(payment: {
  id: string;
  amount: number;
  paymentStatus?: string;
}) {
  return {
    id: "cons-1",
    consultationPlan: {
      title: "Career strategy",
      consultantProfile: {
        userId: CONSULTANT_USER,
        user: { name: "Consultant" },
      },
    },
    requestedBy: { userId: CONSULTEE_USER, user: { name: "Consultee" } },
    appointment: {
      id: "apt-1",
      payment: [
        {
          currency: "INR",
          paymentStatus: "SUCCEEDED",
          ...payment,
        },
      ],
      slotsOfAppointment: [
        {
          meetingSession: {
            // #1280 — the detector now asks Stream to corroborate before any
            // money moves, so the session needs a call id for it to ask about.
            // Without one it refuses, which is the correct behaviour and not
            // what these cases are exercising.
            streamCallId: "slot-cons-1",
            // Only the consultee shows up.
            attendances: [{ userId: CONSULTEE_USER }],
          },
        },
      ],
    },
  };
}

describe("consultant no-show refunds", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.consultation.updateMany as jest.Mock).mockResolvedValue({
      count: 1,
    });
    recordSystemError.mockResolvedValue(undefined);
    refundBookingPayment.mockResolvedValue({
      amountRefundedPaise: 150000,
      rail: "GATEWAY",
    });
  });

  it("refunds through the front door, never the raw gateway path", async () => {
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([
      noShowCandidate({ id: "pay-1", amount: 150000 }),
    ]);

    const result = await detectConsultantNoShows();

    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay-1",
        initiatedByUserId: null,
        reason: expect.stringContaining("no-show"),
      }),
    );
    // The whole point of the fix: org-funded intents die inside refundPayment.
    expect(refundPayment).not.toHaveBeenCalled();
    expect(result.detected).toBe(1);
    expect(result.refunded).toBe(1);
  });

  it("handles a fully credit-funded booking (amount 0) instead of skipping it", async () => {
    // Pre-fix this row was filtered out at BOTH the candidate query and the
    // payment picker, so the booking was never even cancelled.
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([
      noShowCandidate({ id: "pay-free", amount: 0 }),
    ]);
    refundBookingPayment.mockResolvedValue({
      amountRefundedPaise: 0,
      rail: "CREDITS",
    });

    const result = await detectConsultantNoShows();

    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay-free" }),
    );
    expect(result.detected).toBe(1);
    expect(result.refunded).toBe(1);
    // And the booking itself was cancelled, not left live.
    expect(prisma.consultation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CANCELLED" }),
      }),
    );
  });

  it("does not filter the candidate query on a positive amount", async () => {
    await detectConsultantNoShows();

    const [args] = (prisma.consultation.findMany as jest.Mock).mock.calls[0];
    const paymentFilter = args.where.appointment.payment.some;
    expect(paymentFilter).toEqual({
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
    });
    expect(paymentFilter).not.toHaveProperty("amount");
  });

  it("records a durable system event when the refund fails", async () => {
    // Pre-fix a refund failure existed only in this job's stdout, so ops had
    // no signal that a cancelled booking still owed money.
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([
      noShowCandidate({ id: "pay-boom", amount: 150000 }),
    ]);
    refundBookingPayment.mockRejectedValue(new Error("gateway refused"));

    const result = await detectConsultantNoShows();

    expect(recordSystemError).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "PAYMENT",
        summary: expect.stringContaining("cons-1"),
        context: expect.objectContaining({ paymentId: "pay-boom" }),
      }),
    );
    expect(result.refunded).toBe(0);
    expect(result.success).toBe(false);
  });

  it("leaves a session the consultant actually attended alone", async () => {
    const attended = noShowCandidate({ id: "pay-1", amount: 150000 });
    attended.appointment.slotsOfAppointment[0].meetingSession.attendances = [
      { userId: CONSULTEE_USER },
      { userId: CONSULTANT_USER },
    ];
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([attended]);

    const result = await detectConsultantNoShows();

    expect(result.detected).toBe(0);
    expect(refundBookingPayment).not.toHaveBeenCalled();
    expect(prisma.consultation.updateMany).not.toHaveBeenCalled();
  });
});
