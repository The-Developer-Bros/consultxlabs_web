/**
 * @jest-environment node
 */

/**
 * Trial cancellation must not destroy the payment (#1009).
 *
 * Both cancel paths used to hard-delete the trial's appointment to free the
 * slot. `Payment.appointment` is `onDelete: Cascade`, so after paid trials
 * shipped (#1046) that delete took the payment row with it — no refund, no
 * ledger entry, nothing to reconcile against the gateway.
 *
 * Pinned here:
 *  - the appointment is tombstoned, never deleted, and its slots go with it
 *  - a paid trial refunds through the shared policy engine
 *  - a free trial mints no refund at all
 *  - consultant-initiated cancellation uses the consultant tier, not the
 *    time-based one the consultee gets
 *  - a gateway failure leaves the cancellation standing rather than throwing
 */

const mockSlotUpdateMany = jest.fn();
const mockAppointmentUpdateMany = jest.fn();
const mockAppointmentDelete = jest.fn();
const mockAppointmentFindUnique = jest.fn();
const mockPaymentFindFirst = jest.fn();
const mockRefundPayment = jest.fn();
const mockCaptureException = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        slotOfAppointment: {
          updateMany: (...a: unknown[]) => mockSlotUpdateMany(...a),
        },
        appointmentParticipant: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        appointment: {
          updateMany: (...a: unknown[]) => mockAppointmentUpdateMany(...a),
          delete: (...a: unknown[]) => mockAppointmentDelete(...a),
        },
      }),
    appointment: {
      findUnique: (...a: unknown[]) => mockAppointmentFindUnique(...a),
      delete: (...a: unknown[]) => mockAppointmentDelete(...a),
    },
    payment: {
      findFirst: (...a: unknown[]) => mockPaymentFindFirst(...a),
      findUnique: jest.fn().mockResolvedValue({
        id: "pay-1",
        paymentIntent: "pi_test",
        amount: BigInt(100000),
        paymentStatus: "SUCCEEDED",
        deletedAt: null,
      }),
    },
  },
}));

jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...a: unknown[]) => mockRefundPayment(...a),
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: (...a: unknown[]) => mockCaptureException(...a),
}));

import { SlotCompletionStatus } from "@prisma/client";

import {
  refundCancelledTrial,
  softCancelTrialAppointment,
} from "../../lib/trials/cancellation";

const APPOINTMENT_ID = "appt-1";
const PAYMENT_ID = "pay-1";
const TRIAL_ID = "trial-1";
const USER_ID = "user-1";

/** ₹1,000 trial, sitting well outside any cancellation window. */
const paidTrial = {
  id: PAYMENT_ID,
  amount: BigInt(100_000),
  refunds: [],
  disputes: [],
};

function appointmentStartingInHours(hours: number) {
  return {
    cancellationPolicy: null,
    slotsOfAppointment: [
      { startsAt: new Date(Date.now() + hours * 3_600_000) },
    ],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSlotUpdateMany.mockResolvedValue({ count: 1 });
  mockAppointmentUpdateMany.mockResolvedValue({ count: 1 });
});

describe("softCancelTrialAppointment", () => {
  it("tombstones the appointment instead of deleting it", async () => {
    await softCancelTrialAppointment(APPOINTMENT_ID);

    // The whole point of #1009: a delete here cascades into Payment.
    expect(mockAppointmentDelete).not.toHaveBeenCalled();

    expect(mockAppointmentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: APPOINTMENT_ID, deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      }),
    );
  });

  it("cancels and tombstones the slots so they stop reading as live", async () => {
    await softCancelTrialAppointment(APPOINTMENT_ID);

    expect(mockSlotUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { appointmentId: APPOINTMENT_ID, deletedAt: null },
        data: {
          completionStatus: SlotCompletionStatus.CANCELLED,
          deletedAt: expect.any(Date),
        },
      }),
    );
  });
});

describe("refundCancelledTrial", () => {
  it("refunds a paid trial through the policy engine", async () => {
    mockPaymentFindFirst.mockResolvedValue(paidTrial);
    mockAppointmentFindUnique.mockResolvedValue(appointmentStartingInHours(72));
    mockRefundPayment.mockResolvedValue({ amountRefundedPaise: 100_000 });

    const result = await refundCancelledTrial({
      trialId: TRIAL_ID,
      appointmentId: APPOINTMENT_ID,
      paymentId: PAYMENT_ID,
      initiatedByUserId: USER_ID,
      isConsultantInitiated: false,
    });

    expect(mockRefundPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: PAYMENT_ID,
        initiatedByUserId: USER_ID,
      }),
    );
    expect(result?.amountRefundedPaise).toBe(100_000);
    expect(result?.failed).toBeUndefined();
  });

  it("mints no refund for a free trial", async () => {
    // No SUCCEEDED payment with amount > 0 exists for a free trial.
    mockPaymentFindFirst.mockResolvedValue(null);

    const result = await refundCancelledTrial({
      trialId: TRIAL_ID,
      appointmentId: APPOINTMENT_ID,
      paymentId: null,
      initiatedByUserId: USER_ID,
      isConsultantInitiated: false,
    });

    expect(result).toBeNull();
    expect(mockRefundPayment).not.toHaveBeenCalled();
  });

  it("gives the consultant tier when the consultant cancels, however late", async () => {
    mockPaymentFindFirst.mockResolvedValue(paidTrial);
    // One hour out — a consultee cancelling this late gets nothing back.
    mockAppointmentFindUnique.mockResolvedValue(appointmentStartingInHours(1));
    mockRefundPayment.mockResolvedValue({ amountRefundedPaise: 100_000 });

    const consultee = await refundCancelledTrial({
      trialId: TRIAL_ID,
      appointmentId: APPOINTMENT_ID,
      paymentId: PAYMENT_ID,
      initiatedByUserId: USER_ID,
      isConsultantInitiated: false,
    });

    jest.clearAllMocks();
    mockPaymentFindFirst.mockResolvedValue(paidTrial);
    mockAppointmentFindUnique.mockResolvedValue(appointmentStartingInHours(1));
    mockRefundPayment.mockResolvedValue({ amountRefundedPaise: 100_000 });

    const consultant = await refundCancelledTrial({
      trialId: TRIAL_ID,
      appointmentId: APPOINTMENT_ID,
      paymentId: PAYMENT_ID,
      initiatedByUserId: USER_ID,
      isConsultantInitiated: true,
    });

    // The learner is not penalised for a decision that wasn't theirs.
    expect(consultant!.refundPct).toBeGreaterThan(consultee!.refundPct);
  });

  it("clamps to what is still refundable", async () => {
    // The same shape as the cancel route and the seat refund: a percentage of
    // the gross overshoots a payment that has already given some back, the
    // operation rejects the WHOLE request, and the catch turns that into
    // "refunded 0" — so the buyer loses the remainder instead of receiving it.
    mockPaymentFindFirst.mockResolvedValue({
      ...paidTrial,
      refunds: [{ amountPaise: 70_000, status: "SUCCEEDED" }],
    });
    mockAppointmentFindUnique.mockResolvedValue(appointmentStartingInHours(72));
    mockRefundPayment.mockResolvedValue({ amountRefundedPaise: 30_000 });

    const result = await refundCancelledTrial({
      trialId: TRIAL_ID,
      appointmentId: APPOINTMENT_ID,
      paymentId: PAYMENT_ID,
      initiatedByUserId: USER_ID,
      isConsultantInitiated: true,
    });

    expect(mockRefundPayment).toHaveBeenCalledWith(
      expect.objectContaining({ amountPaise: 30_000 }),
    );
    expect(result?.amountRefundedPaise).toBe(30_000);
  });

  it("leaves the cancellation standing when the gateway fails", async () => {
    mockPaymentFindFirst.mockResolvedValue(paidTrial);
    mockAppointmentFindUnique.mockResolvedValue(appointmentStartingInHours(72));
    mockRefundPayment.mockRejectedValue(new Error("gateway down"));

    // Must not throw — the trial is already CANCELLED by the time this runs.
    const result = await refundCancelledTrial({
      trialId: TRIAL_ID,
      appointmentId: APPOINTMENT_ID,
      paymentId: PAYMENT_ID,
      initiatedByUserId: USER_ID,
      isConsultantInitiated: false,
    });

    expect(result?.failed).toBe(true);
    expect(result?.amountRefundedPaise).toBe(0);
    // A silently swallowed refund failure is how money goes missing unnoticed.
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it("falls back to the appointment's payment when the trial link is unwritten", async () => {
    // The capture webhook writes TrialSession.paymentId after the Payment row;
    // a cancellation racing that write must still find the money.
    mockPaymentFindFirst.mockResolvedValue(paidTrial);
    mockAppointmentFindUnique.mockResolvedValue(appointmentStartingInHours(72));
    mockRefundPayment.mockResolvedValue({ amountRefundedPaise: 100_000 });

    await refundCancelledTrial({
      trialId: TRIAL_ID,
      appointmentId: APPOINTMENT_ID,
      paymentId: null,
      initiatedByUserId: USER_ID,
      isConsultantInitiated: false,
    });

    expect(mockPaymentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ appointmentId: APPOINTMENT_ID }),
      }),
    );
  });
});
