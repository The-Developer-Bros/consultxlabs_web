/**
 * @jest-environment node
 */

/**
 * PM-12 / PM-11 — Razorpay core refund + order-receipt correctness.
 *
 * PM-12: createRazorpayRefund / listRazorpayRefunds must target the CAPTURED
 *   payment on an order, not items[0] (which can be an earlier failed attempt).
 * PM-11: createRazorpayOrder receipts must not collide within the same ms —
 *   the uuid suffix keeps them unique.
 *
 * We mock the `razorpay` SDK constructor so the module-load client is a stub
 * whose orders/payments methods we drive per-test.
 *
 * Refund CREATION no longer goes through the SDK — it is a raw POST so the
 * `X-Refund-Idempotency` header can actually be sent (the SDK drops unknown
 * headers). So the PM-12 target assertion now reads the request URL. The
 * order/payment LOOKUP still uses the SDK.
 */

// The client is built at module load from these env vars — set BEFORE the
// razorpay import is resolved.
process.env.RAZORPAY_KEY_ID = "rzp_test_key";
process.env.RAZORPAY_SECRET = "rzp_test_secret";

// Mocks live on a holder object so the hoisted jest.mock factory can reach them
// lazily (referencing top-level `const`s directly throws "before init").
const rzp = {
  ordersFetchPayments: jest.fn(),
  ordersCreate: jest.fn(),
  paymentsRefund: jest.fn(),
  paymentsFetchMultipleRefund: jest.fn(),
};

jest.mock("razorpay", () => {
  return jest.fn().mockImplementation(() => ({
    orders: {
      fetchPayments: (...a: unknown[]) => rzp.ordersFetchPayments(...a),
      create: (...a: unknown[]) => rzp.ordersCreate(...a),
    },
    payments: {
      refund: (...a: unknown[]) => rzp.paymentsRefund(...a),
      fetchMultipleRefund: (...a: unknown[]) =>
        rzp.paymentsFetchMultipleRefund(...a),
    },
  }));
});

import { PaymentGateway } from "@prisma/client";
import {
  createRazorpayRefund,
  listRazorpayRefunds,
  createRazorpayOrder,
} from "@/lib/payments/core/razorpay";

const ordersFetchPayments = rzp.ordersFetchPayments;
const ordersCreate = rzp.ordersCreate;
const paymentsFetchMultipleRefund = rzp.paymentsFetchMultipleRefund;

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

/** Queue one successful create-refund HTTP response. */
function mockRefundResponse(body: Record<string, unknown>) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

/** The payment id the refund was actually POSTed against. */
function refundedPaymentId(call = 0): string {
  const url = fetchMock.mock.calls[call][0] as string;
  return url.match(/\/payments\/([^/]+)\/refund$/)?.[1] ?? "";
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("PM-12 — createRazorpayRefund targets the captured payment", () => {
  it("refunds items[1] (captured) when items[0] is a failed attempt", async () => {
    ordersFetchPayments.mockResolvedValue({
      count: 2,
      items: [
        { id: "pay_failed", status: "failed" },
        { id: "pay_captured", status: "captured" },
      ],
    });
    mockRefundResponse({
      id: "rfnd_1",
      amount: 5000,
      currency: "inr",
      status: "processed",
      notes: {},
    });

    await createRazorpayRefund({
      idempotencyKey: "clx3k2j9a0000abcd1234efgh",
      paymentIntentId: "order_1",
      amount: 5000,
      reason: "requested_by_customer",
    });

    // The refund must be created on the CAPTURED payment, never the failed one.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refundedPaymentId()).toBe("pay_captured");
  });

  it("falls back to items[0] when no payment is captured", async () => {
    ordersFetchPayments.mockResolvedValue({
      count: 1,
      items: [{ id: "pay_only", status: "authorized" }],
    });
    mockRefundResponse({
      id: "rfnd_2",
      amount: 1000,
      currency: "inr",
      status: "pending",
      notes: {},
    });

    await createRazorpayRefund({
      paymentIntentId: "order_2",
      amount: 1000,
      idempotencyKey: "clx3k2j9a0000abcd1234efgh",
    });

    expect(refundedPaymentId()).toBe("pay_only");
  });
});

describe("PM-12 — listRazorpayRefunds resolves the captured payment id", () => {
  it("lists refunds for items[1] (captured), not items[0] (failed)", async () => {
    ordersFetchPayments.mockResolvedValue({
      count: 2,
      items: [
        { id: "pay_failed", status: "failed" },
        { id: "pay_captured", status: "captured" },
      ],
    });
    paymentsFetchMultipleRefund.mockResolvedValue({ items: [] });

    await listRazorpayRefunds("order_3");

    expect(paymentsFetchMultipleRefund).toHaveBeenCalledTimes(1);
    expect(paymentsFetchMultipleRefund.mock.calls[0][0]).toBe("pay_captured");
  });
});

describe("PM-11 — createRazorpayOrder receipts are unique within the same ms", () => {
  it("two orders created back-to-back get distinct receipts", async () => {
    ordersCreate.mockImplementation(async (args: { receipt: string }) => ({
      id: `order_${args.receipt}`,
      amount: 1000,
      currency: "INR",
      status: "created",
    }));

    const params = {
      amount: 1000,
      currency: "INR",
      metadata: { appointmentId: "appt_1", appointmentType: "ONE_ON_ONE" },
      paymentGateway: PaymentGateway.RAZORPAY,
    };
    await createRazorpayOrder(params);
    await createRazorpayOrder(params);

    const r1 = ordersCreate.mock.calls[0][0].receipt as string;
    const r2 = ordersCreate.mock.calls[1][0].receipt as string;

    expect(r1).not.toBe(r2);
    // Shape: receipt_<ms>_<8-char uuid slice>
    expect(r1).toMatch(/^receipt_\d+_[0-9a-f]{8}$/);
  });
});
