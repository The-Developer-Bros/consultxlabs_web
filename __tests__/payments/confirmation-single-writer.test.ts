/**
 * @jest-environment node
 */

/**
 * ADR 21 — payment confirmation has exactly one writer.
 *
 * The bug these pin: /api/checkout/verify-signature used to flip
 * Payment.paymentStatus to SUCCEEDED with a bare updateMany. The client's
 * return from the Razorpay modal normally beats the webhook, so when it won,
 * the later payment.captured event hit handlePaymentSuccess's
 * already-SUCCEEDED early-return and skipped the entire pipeline — no
 * appointment, no earnings, no booking:<paymentId> journal entry, no GST, and
 * no capture-amount parity check (which sits below that early-return). Money
 * taken, never journalled.
 *
 * Both race orderings are asserted, because a fix that only works when the
 * webhook arrives second is not a fix.
 */

// The route dispatches the pipeline from `after()` so Phase 2's outbound work
// (email, Stream channel provisioning) does not sit inside a request under
// Netlify's ~10s function ceiling — the same posture the webhook route has
// always had. Jest has no Next request lifecycle, so capture the callbacks and
// run them on demand.
const afterCallbacks: Array<() => unknown> = [];
jest.mock("next/server", () => {
  const actual = jest.requireActual("next/server");
  return {
    ...actual,
    after: (cb: () => unknown) => {
      afterCallbacks.push(cb);
    },
  };
});

async function flushAfter() {
  for (const cb of afterCallbacks.splice(0)) await cb();
}

const routeCapturedPayment = jest.fn();
jest.mock("../../app/api/webhooks/razorpay-dispatch", () => ({
  routeCapturedPayment: (...args: unknown[]) => routeCapturedPayment(...args),
}));

const paymentsFetch = jest.fn();
jest.mock("../../lib/payments/core/razorpay", () => ({
  razorpayClient: {
    payments: { fetch: (...a: unknown[]) => paymentsFetch(...a) },
  },
  getRazorpayClient: () => ({
    payments: { fetch: (...a: unknown[]) => paymentsFetch(...a) },
  }),
}));

const getSession = jest.fn();
jest.mock("../../lib/auth-server", () => ({
  getSession: () => getSession(),
}));

// #1353 — the route now applies checkoutLimiter per user. In the shared CI
// process the mock-redis store accumulates hits across suites, so these
// success-path POSTs would start answering 429. Boundary-mock it: rate limiting
// is infrastructure, not the single-writer contract under test here.
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn().mockResolvedValue(null),
  checkoutLimiter: { limit: jest.fn() },
}));

// #1353 — the route records a client-confirmation audit event. It is
// fire-and-forget and best-effort in production; here it would reach the real
// prisma module, which this suite stubs to a handful of models.
const recordSystemEvent = jest.fn().mockResolvedValue(undefined);
jest.mock("../../lib/enterprise/system-events", () => ({
  __esModule: true,
  recordSystemEvent: (...args: unknown[]) => recordSystemEvent(...args),
  recordSystemError: jest.fn().mockResolvedValue(undefined),
}));

const findUnique = jest.fn();
const updateMany = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
    },
  },
}));

import { NextRequest } from "next/server";
import crypto from "crypto";
import { POST } from "../../app/api/checkout/verify-signature/route";

const SECRET = "test_secret";
const ORDER_ID = "order_ABC123";
const PAY_ID = "pay_XYZ789";
const USER_ID = "user_1";

function signedRequest(): NextRequest {
  const signature = crypto
    .createHmac("sha256", SECRET)
    .update(`${ORDER_ID}|${PAY_ID}`)
    .digest("hex");
  return new NextRequest("https://x.test/api/checkout/verify-signature", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      razorpay_order_id: ORDER_ID,
      razorpay_payment_id: PAY_ID,
      razorpay_signature: signature,
    }),
  });
}

/** A PENDING payment owned by the caller. */
const pendingPayment = () => ({
  id: "p1",
  userId: USER_ID,
  paymentStatus: "PENDING",
});

beforeEach(() => {
  jest.clearAllMocks();
  afterCallbacks.length = 0;
  process.env.RAZORPAY_SECRET = SECRET;
  getSession.mockResolvedValue({ user: { id: USER_ID } });
  paymentsFetch.mockResolvedValue({
    id: PAY_ID,
    order_id: ORDER_ID,
    amount: 250000,
    status: "captured",
    notes: { appointmentType: "CONSULTATION" },
  });
});

describe("verify-signature drives the canonical pipeline", () => {
  it("never writes paymentStatus itself", async () => {
    findUnique.mockResolvedValue(pendingPayment());

    await POST(signedRequest());
    await flushAfter();

    // The whole point: this route no longer sets the status. If it did, the
    // webhook's already-SUCCEEDED guard would skip the pipeline.
    expect(updateMany).not.toHaveBeenCalled();
    expect(routeCapturedPayment).toHaveBeenCalledTimes(1);
  });

  it("passes gateway truth — amount and notes — so the parity check can run", async () => {
    findUnique.mockResolvedValue(pendingPayment());

    await POST(signedRequest());
    await flushAfter();

    // The signature proves the id pair came from Razorpay but carries neither
    // the captured amount nor the notes; both have to come off the gateway.
    expect(routeCapturedPayment).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      notes: { appointmentType: "CONSULTATION" },
      amountPaise: 250000,
      gatewayPaymentId: PAY_ID,
    });
  });

  it("responds before the pipeline runs, and says so", async () => {
    findUnique.mockResolvedValue(pendingPayment());

    const body = await (await POST(signedRequest())).json();

    // Dispatched, not finished. checkout-success polls /api/checkout/verify
    // until the appointment appears and renders "confirming your booking"
    // meanwhile — never an unqualified success.
    expect(body).toMatchObject({ verified: true, pendingConfirmation: true });
    expect(routeCapturedPayment).not.toHaveBeenCalled(); // still queued
  });
});

describe("the race, both directions", () => {
  it("webhook first: verify-signature becomes a no-op", async () => {
    // The webhook already ran the pipeline and set SUCCEEDED.
    findUnique.mockResolvedValue({
      id: "p1",
      userId: USER_ID,
      paymentStatus: "SUCCEEDED",
    });

    const body = await (await POST(signedRequest())).json();
    await flushAfter();

    expect(routeCapturedPayment).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(body).toMatchObject({ verified: true, paymentStatus: "SUCCEEDED" });
  });

  it("verify-signature first: it drives the pipeline, and a later webhook is idempotent", async () => {
    findUnique.mockResolvedValue(pendingPayment());

    await POST(signedRequest());
    await flushAfter();
    expect(routeCapturedPayment).toHaveBeenCalledTimes(1);

    // The webhook arriving afterwards calls the same idempotent entry point;
    // handlePaymentSuccess's already-SUCCEEDED guard makes it a no-op. That
    // guard is now CORRECT, because SUCCEEDED again implies the pipeline ran.
    routeCapturedPayment.mockClear();
    findUnique.mockResolvedValue({
      id: "p1",
      userId: USER_ID,
      paymentStatus: "SUCCEEDED",
    });
    await POST(signedRequest());
    await flushAfter();
    expect(routeCapturedPayment).not.toHaveBeenCalled();
  });
});

describe("capture state is verified, not assumed", () => {
  it("refuses to run the pipeline on an authorized-but-uncaptured payment", async () => {
    // With a non-zero auto-capture delay on the account, the modal handler
    // fires while the payment is still `authorized`. Confirming there would
    // journal a CASH debit for money never received — and Razorpay voids the
    // authorization days later, leaving the ledger simply wrong. The webhook
    // path cannot hit this (payment.captured fires on capture by definition),
    // so this route is the only place that has to look.
    paymentsFetch.mockResolvedValue({
      id: PAY_ID,
      order_id: ORDER_ID,
      amount: 250000,
      status: "authorized",
      notes: { appointmentType: "CONSULTATION" },
    });
    findUnique.mockResolvedValue(pendingPayment());

    const body = await (await POST(signedRequest())).json();
    await flushAfter();

    expect(routeCapturedPayment).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(body.pendingConfirmation).toBe(true);
  });
});

describe("gateway-fetch failure", () => {
  it("defers to the webhook instead of falling back to a bare status flip", async () => {
    findUnique.mockResolvedValue(pendingPayment());
    paymentsFetch.mockRejectedValue(new Error("ECONNRESET"));

    const body = await (await POST(signedRequest())).json();
    await flushAfter();

    // Falling back to the flip is exactly the behaviour being removed: it
    // would confirm a payment whose amount we never verified, and poison the
    // webhook's guard on the way.
    expect(updateMany).not.toHaveBeenCalled();
    expect(routeCapturedPayment).not.toHaveBeenCalled();
    expect(body.pendingConfirmation).toBe(true);
  });
});

describe("signature and ownership are still enforced", () => {
  it("rejects a bad signature without touching the pipeline", async () => {
    const req = new NextRequest(
      "https://x.test/api/checkout/verify-signature",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          razorpay_order_id: ORDER_ID,
          razorpay_payment_id: PAY_ID,
          razorpay_signature: "a".repeat(64),
        }),
      },
    );

    const res = await POST(req);
    await flushAfter();

    expect(res.status).toBe(400);
    expect(routeCapturedPayment).not.toHaveBeenCalled();
  });

  it("rejects another user's payment", async () => {
    findUnique.mockResolvedValue({
      id: "p1",
      userId: "someone_else",
      paymentStatus: "PENDING",
    });

    const res = await POST(signedRequest());
    await flushAfter();

    expect(res.status).toBe(403);
    expect(routeCapturedPayment).not.toHaveBeenCalled();
  });
});
