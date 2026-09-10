/**
 * @jest-environment node
 */

/**
 * #1169 / #1319 — the abandoned-payment sweeper.
 *
 * The sweep used to DELETE the request, which cascaded the Appointment and
 * every Payment under it (#1074 class). It now soft-cancels: the request moves
 * to EXPIRED through the CAS helper, the slots are tombstoned by status, and
 * the money rows stay readable. Three things are pinned here: no delete member
 * exists on the mock (a surviving delete path throws a TypeError rather than
 * passing), the referral-credit reversal still runs before the rows are
 * expired inside the same transaction, and a CAS miss escapes that transaction
 * so the reversal rolls back with it instead of committing on a paid booking.
 */

const order: string[] = [];

jest.mock("../../lib/prisma", () => {
  const tx = {
    payment: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    slotOfAppointment: {
      count: jest.fn(),
      updateManyAndReturn: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    appointment: { updateMany: jest.fn() },
    consultation: { findUnique: jest.fn(), updateMany: jest.fn() },
    subscription: { findUnique: jest.fn(), updateMany: jest.fn() },
    // #1319 A12 — every CAS helper appends its history row in the same tx.
    bookingStatusHistory: { create: jest.fn() },
  };
  const client = {
    ...tx,
    appointment: { findMany: jest.fn(), updateMany: tx.appointment.updateMany },
    $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    __tx: tx,
  };
  return { __esModule: true, default: client };
});

jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: jest.fn(),
}));
jest.mock("../../lib/payments/core/razorpay", () => ({
  cancelRazorpayOrder: jest.fn().mockResolvedValue(undefined),
}));
// #1464 — the sweep reaches Stripe only through the fenced core client, so
// mocking the core is what proves the fence: a call to `getStripeClient` is a
// gateway call, and with the fence shut there must not be one.
const stripeClient = {
  paymentIntents: { cancel: jest.fn() },
  checkout: { sessions: { expire: jest.fn() } },
};
jest.mock("../../lib/payments/core/stripe", () => ({
  __esModule: true,
  getStripeClient: jest.fn(() => stripeClient),
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: jest.fn((_job: string, _opts: unknown, fn: () => unknown) =>
    fn(),
  ),
  CronLockHeldError: class CronLockHeldError extends Error {},
  CronLockUnavailableError: class CronLockUnavailableError extends Error {},
}));

import prisma from "../../lib/prisma";
import { reverseCreditsForPayment } from "../../lib/referrals/service";
import { cancelRazorpayOrder } from "../../lib/payments/core/razorpay";
import { getStripeClient } from "../../lib/payments/core/stripe";
import {
  cancelGatewayIntents,
  cleanupAbandonedPayments,
} from "../../scripts/payments/cleanup-abandoned-payments";
import { REQUEST_ALLOWED_FROM } from "../../lib/booking/transitions";
import { IllegalTransitionError } from "../../lib/enterprise/transitions";

const db = prisma as unknown as {
  appointment: { findMany: jest.Mock };
  $transaction: jest.Mock;
  __tx: {
    payment: {
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    slotOfAppointment: {
      count: jest.Mock;
      updateManyAndReturn: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
    };
    appointment: { updateMany: jest.Mock };
    consultation: { findUnique: jest.Mock; updateMany: jest.Mock };
    subscription: { findUnique: jest.Mock; updateMany: jest.Mock };
    bookingStatusHistory: { create: jest.Mock };
  };
};
const tx = db.__tx;
const mockReverse = reverseCreditsForPayment as jest.Mock;

/** One abandoned consultation with a single PENDING Razorpay payment. */
function abandonedConsultation() {
  return {
    id: "apt_1",
    payment: [
      {
        id: "pay_1",
        userId: "user_1",
        paymentIntent: "order_abc",
        paymentGateway: "RAZORPAY",
        paymentStatus: "PENDING",
      },
    ],
    consultation: { id: "cons_1" },
    subscription: null,
    webinar: null,
    class: null,
    slotsOfAppointment: [{ id: "slot_1", isTentative: true }],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  order.length = 0;

  db.appointment.findMany.mockResolvedValue([abandonedConsultation()]);
  tx.payment.findUnique.mockResolvedValue({
    id: "pay_1",
    paymentStatus: "PENDING",
  });
  tx.payment.update.mockResolvedValue({});
  tx.slotOfAppointment.count.mockResolvedValue(0);
  tx.slotOfAppointment.updateManyAndReturn.mockImplementation(() => {
    order.push("cancelSlots");
    return Promise.resolve([{ id: "slot_1" }]);
  });
  tx.slotOfAppointment.findMany.mockResolvedValue([
    { id: "slot_1", completionStatus: "SCHEDULED" },
  ]);
  tx.slotOfAppointment.update.mockResolvedValue({});
  tx.appointment.updateMany.mockImplementation(() => {
    order.push("tombstoneAppointment");
    return Promise.resolve({ count: 1 });
  });
  tx.consultation.updateMany.mockImplementation(() => {
    order.push("expireConsultation");
    return Promise.resolve({ count: 1 });
  });
  tx.subscription.updateMany.mockResolvedValue({ count: 1 });
  tx.consultation.findUnique.mockResolvedValue({ status: "PENDING" });
  tx.subscription.findUnique.mockResolvedValue({ status: "PENDING" });
  tx.bookingStatusHistory.create.mockResolvedValue({});
  mockReverse.mockImplementation(() => {
    order.push("reverseCredits");
    return Promise.resolve(500);
  });

  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe("cleanupAbandonedPayments — soft-cancel + credit reversal (#1319)", () => {
  it("restores credits for every pending payment it expires", async () => {
    const result = await cleanupAbandonedPayments();

    expect(mockReverse).toHaveBeenCalledTimes(1);
    expect(mockReverse).toHaveBeenCalledWith("pay_1", tx);
    expect(result.cleanedCount).toBe(1);
    expect(result.success).toBe(true);
  });

  it("never deletes: the request is EXPIRED through the CAS, slots and appointment are tombstoned", async () => {
    await cleanupAbandonedPayments();

    // The cohort's money predicate is re-evaluated by the UPDATE itself: a
    // capture that landed since the read matches zero rows.
    expect(tx.consultation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "cons_1",
        appointment: { payment: { none: { paymentStatus: "SUCCEEDED" } } },
        status: { in: REQUEST_ALLOWED_FROM.EXPIRED },
      },
      data: { status: "EXPIRED" },
    });
    expect(tx.slotOfAppointment.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          appointmentId: "apt_1",
          deletedAt: null,
        }),
        data: expect.objectContaining({
          completionStatus: "CANCELLED",
          deletedAt: expect.any(Date),
        }),
      }),
    );
    expect(tx.appointment.updateMany).toHaveBeenCalledWith({
      where: { id: "apt_1", deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it("reverses credits before the rows are expired, inside the transaction", async () => {
    await cleanupAbandonedPayments();

    expect(order).toEqual([
      "reverseCredits",
      "expireConsultation",
      "cancelSlots",
      "tombstoneAppointment",
    ]);
    const [, handle] = mockReverse.mock.calls[0];
    expect(handle).toBe(tx);
    expect(handle).not.toBe(prisma);
  });

  it("marks the payment EXPIRED rather than FAILED", async () => {
    await cleanupAbandonedPayments();

    // Conditional on PENDING: a capture racing the sweep keeps SUCCEEDED.
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "pay_1", paymentStatus: "PENDING" },
      data: { paymentStatus: "EXPIRED" },
    });
    expect(tx.payment.update).not.toHaveBeenCalled();
  });

  it("touches nothing when the payment succeeded mid-sweep", async () => {
    tx.payment.findUnique.mockResolvedValue({
      id: "pay_1",
      paymentStatus: "SUCCEEDED",
    });

    const result = await cleanupAbandonedPayments();

    expect(mockReverse).not.toHaveBeenCalled();
    expect(tx.consultation.updateMany).not.toHaveBeenCalled();
    expect(tx.appointment.updateMany).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(result.errorCount).toBe(0);
  });

  it("skips the row, without an error, when the CAS finds it already moved on", async () => {
    // A capture or an approval landed between the cohort read and the write.
    tx.consultation.updateMany.mockResolvedValue({ count: 0 });

    const result = await cleanupAbandonedPayments();

    expect(tx.slotOfAppointment.updateManyAndReturn).not.toHaveBeenCalled();
    expect(tx.appointment.updateMany).not.toHaveBeenCalled();
    expect(result.errorCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.cleanedCount).toBe(0);
  });

  it("lets the CAS miss escape the transaction so the credit restoration rolls back", async () => {
    // Swallowing IllegalTransitionError inside the callback would COMMIT the
    // payment expiry and the credit reversal that ran before the CAS — credits
    // handed back on a booking whose capture landed mid-transaction. The
    // rejection is what makes Prisma roll the whole unit back.
    tx.consultation.updateMany.mockResolvedValue({ count: 0 });

    await cleanupAbandonedPayments();

    expect(mockReverse).toHaveBeenCalledWith("pay_1", tx);
    await expect(db.$transaction.mock.results[0].value).rejects.toThrow(
      IllegalTransitionError,
    );
  });

  it("still frees the slot when the credit reversal fails", async () => {
    mockReverse.mockRejectedValue(new Error("credit ledger unavailable"));

    const result = await cleanupAbandonedPayments();

    expect(tx.consultation.updateMany).toHaveBeenCalled();
    expect(result.cleanedCount).toBe(1);
    expect(result.success).toBe(true);
  });

  it("keeps a confirmed appointment, releases only the tentative holds, and still returns its credits", async () => {
    tx.slotOfAppointment.count.mockResolvedValue(1);

    await cleanupAbandonedPayments();

    expect(mockReverse).toHaveBeenCalledWith("pay_1", tx);
    expect(tx.consultation.updateMany).not.toHaveBeenCalled();
    expect(tx.appointment.updateMany).not.toHaveBeenCalled();
    expect(tx.slotOfAppointment.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          appointmentId: "apt_1",
          isTentative: true,
          deletedAt: null,
        }),
        data: expect.objectContaining({ completionStatus: "CANCELLED" }),
      }),
    );
  });
});

/**
 * #1459 — the Netlify ticker gives this sweep a six-second budget and the
 * cancels used to run one after another, so five stuck payments were enough to
 * spend it all and every tick aborted mid-sweep. The cancels now fan out, and
 * the ceiling on that fan-out is the only thing keeping the sweep from opening
 * an unbounded burst against the gateway.
 */
describe("cleanupAbandonedPayments gateway cancel concurrency (#1459)", () => {
  it("never has more than five gateway cancels in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    (cancelRazorpayOrder as jest.Mock).mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
    });

    const payments = Array.from({ length: 12 }, (_, i) => ({
      id: `pay_${i}`,
      paymentIntent: `order_${i}`,
      paymentGateway: "RAZORPAY" as const,
    }));

    const failures = await cancelGatewayIntents(payments);

    expect(cancelRazorpayOrder).toHaveBeenCalledTimes(12);
    expect(peak).toBeLessThanOrEqual(5);
    // Twelve over a ceiling of five is three chunks, so the fan-out is real
    // rather than an accidental sequence of one.
    expect(peak).toBeGreaterThan(1);
    expect(failures.size).toBe(0);
  });

  it("reports a failed cancel against its own payment and lets the rest through", async () => {
    (cancelRazorpayOrder as jest.Mock).mockImplementation(
      async (intent: string) => {
        if (intent === "order_1") throw new Error("gateway refused");
      },
    );

    const failures = await cancelGatewayIntents([
      { id: "pay_0", paymentIntent: "order_0", paymentGateway: "RAZORPAY" },
      { id: "pay_1", paymentIntent: "order_1", paymentGateway: "RAZORPAY" },
    ]);

    expect([...failures.keys()]).toEqual(["pay_1"]);
    expect(failures.get("pay_1")).toBe("gateway refused");
  });
});

/**
 * #1464 — a gateway cancel that failed used to skip the PENDING→EXPIRED CAS
 * while the credits were still restored and the slot still released, and the
 * run reported `success: true`. The payment was then invisible to every later
 * sweep, because nothing about it still looked abandoned.
 */
describe("cleanupAbandonedPayments — a failed gateway cancel (#1464)", () => {
  const originalStripeEnabled = process.env.STRIPE_ENABLED;

  afterEach(() => {
    if (originalStripeEnabled === undefined) delete process.env.STRIPE_ENABLED;
    else process.env.STRIPE_ENABLED = originalStripeEnabled;
  });

  it("still expires the payment and returns its credits, and fails the run", async () => {
    (cancelRazorpayOrder as jest.Mock).mockRejectedValue(
      new Error("gateway refused"),
    );

    const result = await cleanupAbandonedPayments();

    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "pay_1", paymentStatus: "PENDING" },
      data: { paymentStatus: "EXPIRED" },
    });
    expect(mockReverse).toHaveBeenCalledWith("pay_1", tx);
    expect(result.cleanedCount).toBe(1);
    // Counted, not just listed: `success` is what the HTTP twin turns into a
    // non-2xx, and the listing alone left the run looking healthy.
    expect(result.errorCount).toBe(1);
    expect(result.success).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining("Payment cancellation failed for order_abc"),
    ]);
  });

  it("makes no gateway call for a Stripe row while the fence is shut", async () => {
    delete process.env.STRIPE_ENABLED;
    const appointment = abandonedConsultation();
    appointment.payment[0].paymentGateway = "STRIPE";
    db.appointment.findMany.mockResolvedValue([appointment]);

    const result = await cleanupAbandonedPayments();

    expect(getStripeClient).not.toHaveBeenCalled();
    // Fenced is "nothing to cancel", not a failure: the row still expires.
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "pay_1", paymentStatus: "PENDING" },
      data: { paymentStatus: "EXPIRED" },
    });
    expect(result.errorCount).toBe(0);
    expect(result.success).toBe(true);
  });

  /**
   * #1461 — `payment_intent_unexpected_state` used to be blanket-suppressed as
   * "already gone". On a `processing` intent that is false: Stripe is still
   * holding the buyer's money behind a payment this sweep has just marked
   * EXPIRED, and the run reported itself healthy.
   */
  it("counts an uncancellable but still-live Stripe intent as a failure", async () => {
    process.env.STRIPE_ENABLED = "true";
    const appointment = abandonedConsultation();
    appointment.payment[0].paymentGateway = "STRIPE";
    appointment.payment[0].paymentIntent = "pi_live_1";
    db.appointment.findMany.mockResolvedValue([appointment]);
    stripeClient.paymentIntents.cancel.mockRejectedValue(
      Object.assign(new Error("cannot cancel a processing PaymentIntent"), {
        code: "payment_intent_unexpected_state",
        payment_intent: { status: "processing" },
      }),
    );

    const result = await cleanupAbandonedPayments();

    // #1464 still holds: the row expires regardless of the cancel's outcome.
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "pay_1", paymentStatus: "PENDING" },
      data: { paymentStatus: "EXPIRED" },
    });
    expect(result.errorCount).toBe(1);
    expect(result.success).toBe(false);
  });

  it("leaves a succeeded intent alone — that one really is nothing to cancel", async () => {
    process.env.STRIPE_ENABLED = "true";
    const appointment = abandonedConsultation();
    appointment.payment[0].paymentGateway = "STRIPE";
    appointment.payment[0].paymentIntent = "pi_done_1";
    db.appointment.findMany.mockResolvedValue([appointment]);
    stripeClient.paymentIntents.cancel.mockRejectedValue(
      Object.assign(new Error("cannot cancel a succeeded PaymentIntent"), {
        code: "payment_intent_unexpected_state",
        // Nested under `raw`, the other shape the SDK wraps errors in.
        raw: { payment_intent: { status: "succeeded" } },
      }),
    );

    const result = await cleanupAbandonedPayments();

    expect(result.errorCount).toBe(0);
    expect(result.success).toBe(true);
  });
});
