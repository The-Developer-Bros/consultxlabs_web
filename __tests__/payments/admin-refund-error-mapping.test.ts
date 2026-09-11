/**
 * @jest-environment node
 */

/**
 * POST /api/admin/refunds must map a failed refund to its typed status.
 *
 * The bug this pins: wrapping the handler in `withIdempotency` was written as
 * `return withIdempotency(...)` inside the route's `try`. In an async function
 * that returns before the promise settles, so the rejection is adopted by the
 * route's own promise and never reaches the `catch` below it. Next answers an
 * unhandled route-handler rejection in production with a bare 500 and a
 * zero-length body — no `error`, no `code`, no Sentry event.
 *
 * Every caller-actionable refund failure went through that hole:
 * REFUND_BLOCKED_BY_DISPUTE, ALREADY_FULLY_REFUNDED, AMOUNT_EXCEEDS_REFUNDABLE,
 * PAYMENT_NOT_SUCCEEDED. The operator saw "500" and could not tell a blocked
 * refund from an outage.
 *
 * Verified against the deploy preview before the fix: `{paymentId}` returned
 * 500 with content-length 0 and no content-type, while the `{classId}` branch
 * — which returns normally instead of throwing — returned 200.
 */

const refundPayment = jest.fn();

/**
 * The error classes are defined in the mock rather than pulled from the real
 * module so this stays a route-plumbing test: the route imports them from this
 * same path, so `instanceof` compares identical constructors. Dragging in the
 * real refund module would boot the whole money graph to prove a control-flow
 * point. They live inside the factory because jest hoists it above every
 * declaration in this file.
 */
// #1237 follow-up — the route now applies moneyOpsLimiter per actor; in the
// shared CI process the mock-redis store accumulates hits across suites and
// these success-path POSTs start answering 429. Boundary-mock the limiter:
// rate limiting is infrastructure, not the contract under test here.
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn().mockResolvedValue(null),
  moneyOpsLimiter: { limit: jest.fn() },
}));
jest.mock("../../lib/payments/operations/refund", () => {
  class RefundValidationError extends Error {
    constructor(
      message: string,
      public code: string,
    ) {
      super(message);
      this.name = "RefundValidationError";
    }
  }
  class RefundGatewayError extends Error {
    constructor(
      message: string,
      public code: string,
    ) {
      super(message);
      this.name = "RefundGatewayError";
    }
  }
  return {
    refundPayment: (...args: unknown[]) => refundPayment(...args),
    RefundValidationError,
    RefundGatewayError,
  };
});

// #1319 — the single-payment arm now goes through the booking front door so
// org-funded intents reverse in-ledger; the same spy answers it.
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...args: unknown[]) => refundPayment(...args),
}));

const refundWholeEventPayments = jest.fn();
jest.mock("../../lib/payments/operations/event-refunds", () => ({
  refundWholeEventPayments: (...args: unknown[]) =>
    refundWholeEventPayments(...args),
}));

jest.mock("../../lib/auth-helpers", () => ({
  requirePrivilegedAuth: jest.fn(async () => ({
    session: { user: { id: "admin_1" } },
  })),
  requireBackofficeSurface: jest.fn(async () => ({
    session: { user: { id: "admin_1" } },
  })),
}));

const captureException = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
}));

// Async by construction: the wrapper chains `.catch()` onto `delete()` when it
// frees a claim, so a mock that returns undefined would fail for its own reason
// rather than the one under test.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    idempotencyRecord: {
      create: jest.fn(async () => ({})),
      findUnique: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
      delete: jest.fn(async () => ({})),
    },
    refund: {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
    },
  },
}));

import { NextRequest } from "next/server";
import { POST } from "../../app/api/admin/refunds/route";

// Same constructors the route holds, so `instanceof` in its catch is a true test.
const { RefundValidationError, RefundGatewayError } = jest.requireMock(
  "../../lib/payments/operations/refund",
) as {
  RefundValidationError: new (m: string, c: string) => Error;
  RefundGatewayError: new (m: string, c: string) => Error;
};

function refundRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("https://x.test/api/admin/refunds", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const SINGLE = { paymentId: "pay_row_1", reason: "customer asked" };

beforeEach(() => {
  jest.clearAllMocks();
});

describe("a thrown refund reaches the route's catch", () => {
  it("maps RefundValidationError to 400 with its code", async () => {
    refundPayment.mockRejectedValue(
      new RefundValidationError(
        "Payment pay_row_1 has an open dispute (UNDER_REVIEW); resolve it before refunding",
        "REFUND_BLOCKED_BY_DISPUTE",
      ),
    );

    const res = await POST(refundRequest(SINGLE));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe("REFUND_BLOCKED_BY_DISPUTE");
    // The operator needs the reason, not just the status.
    expect(body.error).toContain("open dispute");
  });

  it("maps RefundGatewayError to 502", async () => {
    refundPayment.mockRejectedValue(
      new RefundGatewayError("Razorpay refund failed", "GATEWAY_REFUND_FAILED"),
    );

    const res = await POST(refundRequest(SINGLE));

    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("GATEWAY_REFUND_FAILED");
  });

  it("still answers an unexpected error with a JSON body, and reports it", async () => {
    refundPayment.mockRejectedValue(new Error("connection terminated"));

    const res = await POST(refundRequest(SINGLE));
    const text = await res.text();

    expect(res.status).toBe(500);
    // The regression's signature was length 0 with no content-type — an empty
    // 500 means the rejection never reached the catch.
    expect(text.length).toBeGreaterThan(0);
    expect(JSON.parse(text).error).toBe("Refund failed");
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("holds when an Idempotency-Key is present, which routes through runAndRecord", async () => {
    // The keyed path returns through a different frame (runAndRecord re-throws
    // after freeing the claim), so it needs its own assertion.
    refundPayment.mockRejectedValue(
      new RefundValidationError(
        "no refundable balance",
        "ALREADY_FULLY_REFUNDED",
      ),
    );

    const res = await POST(
      refundRequest(SINGLE, { "Idempotency-Key": "admin-refund-key-0001" }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("ALREADY_FULLY_REFUNDED");
  });
});

describe("the success paths are unchanged", () => {
  it("returns the single-payment result", async () => {
    refundPayment.mockResolvedValue({
      refundId: "rfnd_1",
      amountPaise: 250000,
    });

    const res = await POST(refundRequest(SINGLE));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      kind: "payment",
      result: { refundId: "rfnd_1", amountPaise: 250000 },
    });
  });

  it("returns the whole-event summary", async () => {
    refundWholeEventPayments.mockResolvedValue({
      refundsIssued: 0,
      refundedPaise: 0,
      childRefundIds: [],
      failures: [],
    });

    const res = await POST(
      refundRequest({ classId: "class_1", reason: "cancelled" }),
    );

    expect(res.status).toBe(200);
    expect((await res.json()).kind).toBe("class");
  });

  it("rejects a payload naming more than one target", async () => {
    const res = await POST(
      refundRequest({ paymentId: "p1", classId: "c1", reason: "both" }),
    );

    expect(res.status).toBe(400);
    expect(refundPayment).not.toHaveBeenCalled();
  });
});
