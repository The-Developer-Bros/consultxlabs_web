/**
 * @jest-environment node
 */

/**
 * #677 / #990 — defence-in-depth capture-amount parity in handlePaymentSuccess.
 *
 * The gateway order is created at checkout for exactly Payment.amount and the
 * webhook is HMAC-verified, so a captured amount that differs is a gateway
 * anomaly or our-own bug. handlePaymentSuccess must NOT confirm the booking.
 * #990 changed the remediation: Phase 1 pages (Sentry, fatal) and stamps
 * REQUIRES_MANUAL_RECOVERY as a FALLBACK marker, then Phase 2 AUTO-REFUNDS the
 * wrong-amount capture via refundPayment and clears the marker. The manual
 * marker only survives if the refund call itself throws. Either way the booking
 * is never confirmed (no appointment lookup, no earnings, no Phase-2 confirm
 * work). The matching-amount happy path is inert on the guard.
 */

const captureException = jest.fn();
const captureMessage = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: (...a: unknown[]) => captureException(...a),
  captureMessage: (...a: unknown[]) => captureMessage(...a),
}));

const withSerializableRetry = jest.fn(async (fn: () => unknown) => fn());
jest.mock("../../lib/db/serializable-retry", () => ({
  __esModule: true,
  withSerializableRetry: (fn: () => unknown) => withSerializableRetry(fn),
}));

// #1439 — every in-tx status stamp is now a CAS, so the tx writer is
// `updateMany` and its count decides whether the flow continues.
const paymentUpdateMany = jest.fn(
  async (_args: {
    where: { paymentStatus?: string };
    data: { description?: string };
  }) => ({ count: 1 }),
);
const paymentFindUnique = jest.fn();
const appointmentFindUnique = jest.fn();
const txStub = {
  payment: { findUnique: paymentFindUnique, updateMany: paymentUpdateMany },
  appointment: { findUnique: appointmentFindUnique },
};
// #990 — the Phase-2 clear-marker write runs on the base client (outside the
// tx). Give it its own update mock so the auto-refund success path completes.
const prismaPaymentUpdate = jest.fn(
  async (_args: { where: unknown; data: { description?: string } }) => ({}),
);
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => unknown) => fn(txStub),
    payment: {
      update: (...a: unknown[]) => prismaPaymentUpdate(...(a as [never])),
    },
  },
}));

// Side-effectful import graph — present only so the module loads; the mismatch
// branch returns before any of it runs.
const createEarningsFromPayment = jest.fn();
jest.mock("../../lib/payments/payouts", () => ({
  createEarningsFromPayment: (...a: unknown[]) =>
    createEarningsFromPayment(...a),
}));
const refundPayment = jest.fn();
jest.mock("../../lib/payments/operations/refund", () => ({
  refundPayment: (...a: unknown[]) => refundPayment(...a),
}));
jest.mock("../../lib/email", () => ({
  sendPaymentSuccessEmail: jest.fn(),
  sendPaymentFailedEmail: jest.fn(),
}));
jest.mock("../../lib/novu", () => ({
  notifyPaymentSuccess: jest.fn(),
  notifyPaymentFailed: jest.fn(),
  notifyAppointmentBooked: jest.fn(),
}));
jest.mock("../../lib/referrals/service", () => ({
  processQualifyingAction: jest.fn(),
  processConsultantBookingReferral: jest.fn(),
}));
jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  addUserToEventChannel: jest.fn(),
}));
jest.mock("../../actions/stream/chat/channel.action", () => ({
  createDirectMessageChannel: jest.fn(),
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { info: jest.fn(), error: jest.fn() },
}));
const recordSystemError = jest.fn(
  async (_args: { context?: Record<string, unknown> }) => undefined,
);
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: (...a: unknown[]) => recordSystemError(...(a as [never])),
}));
const validateWebhookMetadata = jest.fn();
jest.mock("../../schemas/webhooks/metadata", () => ({
  normalizeLegacySlotKeys: (m: unknown) => m,
  validateWebhookMetadata: (...a: unknown[]) => validateWebhookMetadata(...a),
}));

import { handlePaymentSuccess } from "../../lib/payments/webhooks/handlers";

beforeEach(() => {
  jest.clearAllMocks();
  paymentUpdateMany.mockImplementation(async () => ({ count: 1 }));
  validateWebhookMetadata.mockImplementation(() => undefined);
  paymentFindUnique.mockResolvedValue({
    id: "pay1",
    paymentIntent: "order1",
    amount: 10000,
    paymentStatus: "PENDING",
    userId: "u1",
    currency: "INR",
    appointmentId: "appt1",
    user: { email: "buyer@example.com", name: "Buyer", consulteeProfile: {} },
  });
});

describe("#677 / #990 — handlePaymentSuccess capture-amount parity", () => {
  it("blocks confirmation, pages, and AUTO-REFUNDS when captured amount ≠ Payment.amount", async () => {
    refundPayment.mockResolvedValue({ id: "rfnd1" });

    await handlePaymentSuccess(
      "order1",
      { appointmentType: "CONSULTATION" },
      9999,
    );

    // Paged exactly once with the mismatch error (the fatal Phase-1 page). No
    // second page fires because the refund succeeds.
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(String(captureException.mock.calls[0][0])).toContain(
      "Capture amount mismatch",
    );

    // Phase 1 stamped the REQUIRES_MANUAL_RECOVERY fallback marker (in-tx),
    // and #1439 puts the PENDING predicate in the WHERE.
    expect(paymentUpdateMany).toHaveBeenCalledTimes(1);
    const update = paymentUpdateMany.mock.calls[0][0];
    expect(update.where.paymentStatus).toBe("PENDING");
    expect(update.data.description).toContain("REQUIRES_MANUAL_RECOVERY");

    // #990 — Phase 2 auto-refunded the wrong-amount capture for this payment.
    expect(refundPayment).toHaveBeenCalledTimes(1);
    expect(refundPayment.mock.calls[0][0]).toMatchObject({
      paymentId: "pay1",
      initiatedByUserId: null,
    });

    // …then cleared the fallback marker on the base client (refund succeeded).
    expect(prismaPaymentUpdate).toHaveBeenCalledTimes(1);
    expect(prismaPaymentUpdate.mock.calls[0][0].data.description).toContain(
      "Auto-refunded",
    );

    // Booking was never confirmed and no Phase-2 confirm work ran.
    expect(appointmentFindUnique).not.toHaveBeenCalled();
    expect(createEarningsFromPayment).not.toHaveBeenCalled();
  });

  it("keeps REQUIRES_MANUAL_RECOVERY + pages twice when the auto-refund itself fails", async () => {
    // #990 fallback: if refundPayment throws, the manual-recovery marker is NOT
    // cleared (no clear-marker write) and the refund failure is paged too.
    refundPayment.mockRejectedValue(new Error("gateway 500"));

    await handlePaymentSuccess(
      "order1",
      { appointmentType: "CONSULTATION" },
      9999,
    );

    // Two pages: the Phase-1 mismatch page + the Phase-2 refund-failure page.
    expect(captureException).toHaveBeenCalledTimes(2);
    expect(String(captureException.mock.calls[0][0])).toContain(
      "Capture amount mismatch",
    );

    // The REQUIRES_MANUAL_RECOVERY marker survives (clear-marker write skipped).
    expect(refundPayment).toHaveBeenCalledTimes(1);
    expect(prismaPaymentUpdate).not.toHaveBeenCalled();

    // Still no booking confirmation.
    expect(appointmentFindUnique).not.toHaveBeenCalled();
    expect(createEarningsFromPayment).not.toHaveBeenCalled();
  });

  it("treats an exact match as no mismatch (guard does not fire)", async () => {
    // A matching capture must not produce the manual-recovery write or a page,
    // proving the guard is inert on the happy path. We stop the flow right after
    // the guard by having the tentative-appointment lookup short-circuit.
    appointmentFindUnique.mockResolvedValue(null); // flow throws after the guard
    await handlePaymentSuccess(
      "order1",
      { appointmentType: "CONSULTATION" },
      10000,
    ).catch(() => undefined); // we only assert the guard did not fire

    expect(captureException).not.toHaveBeenCalled();
    const recoveryWrite = paymentUpdateMany.mock.calls.find((c) =>
      String(c[0].data.description ?? "").includes("REQUIRES_MANUAL_RECOVERY"),
    );
    expect(recoveryWrite).toBeUndefined();
    // The guard let the flow proceed to the tentative-appointment lookup.
    expect(appointmentFindUnique).toHaveBeenCalled();
  });
});

describe("#1439 — a capture landing on a terminal payment never restamps it", () => {
  it("leaves an EXPIRED payment EXPIRED when the metadata fails validation", async () => {
    // The abandoned-payments sweep expired the row and released its hold; a
    // late capture then failed metadata validation. The old bare `update`
    // flipped it to SUCCEEDED and the tentative hold leaked forever.
    paymentFindUnique.mockResolvedValue({
      id: "pay1",
      paymentIntent: "order1",
      amount: 10000,
      paymentStatus: "EXPIRED",
      userId: "u1",
      currency: "INR",
      appointmentId: "appt1",
      user: { email: "buyer@example.com", name: "Buyer", consulteeProfile: {} },
    });
    paymentUpdateMany.mockImplementation(async () => ({ count: 0 }));
    validateWebhookMetadata.mockImplementation(() => {
      throw new Error("userId: Required");
    });

    await handlePaymentSuccess("order1", { appointmentType: "CONSULTATION" });

    // The stamp was attempted as a CAS on PENDING and matched nothing.
    expect(paymentUpdateMany).toHaveBeenCalledTimes(1);
    expect(paymentUpdateMany.mock.calls[0][0].where).toMatchObject({
      paymentStatus: "PENDING",
    });
    // The terminal race is recorded once, as a warning, naming the row.
    expect(recordSystemError).toHaveBeenCalledTimes(1);
    expect(recordSystemError.mock.calls[0][0].context).toMatchObject({
      paymentId: "pay1",
      orderId: "order1",
      currentStatus: "EXPIRED",
    });
    expect(captureMessage).toHaveBeenCalledTimes(1);
    // Nothing downstream ran: no ledger posting, no refund, no marker rewrite.
    expect(createEarningsFromPayment).not.toHaveBeenCalled();
    expect(refundPayment).not.toHaveBeenCalled();
    expect(prismaPaymentUpdate).not.toHaveBeenCalled();
  });
});
