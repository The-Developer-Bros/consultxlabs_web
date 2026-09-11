/**
 * @jest-environment node
 */

/**
 * Refund idempotency — createRazorpayRefund must send `X-Refund-Idempotency`
 * so a retry after a network error returns the ORIGINAL refund instead of
 * debiting the customer a second time.
 *
 * razorpay-node cannot send that header (getValidHeaders() whitelists only
 * X-Razorpay-Account and Content-Type), so the create call is a raw POST.
 * These tests pin the request shape and the 409 concurrent-duplicate handling.
 */

process.env.RAZORPAY_KEY_ID = "rzp_test_key";
process.env.RAZORPAY_SECRET = "rzp_test_secret";

const rzp = {
  ordersFetchPayments: jest.fn(),
};

jest.mock("razorpay", () => {
  return jest.fn().mockImplementation(() => ({
    orders: {
      fetchPayments: (...a: unknown[]) => rzp.ordersFetchPayments(...a),
    },
    payments: {},
  }));
});

import { createRazorpayRefund } from "@/lib/payments/core/razorpay";
import { RefundError } from "@/lib/payments/core/types";

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

const REFUND_BODY = {
  id: "rfnd_original",
  amount: 5000,
  currency: "inr",
  status: "processed",
  notes: {},
};

function okResponse(body: Record<string, unknown> = REFUND_BODY) {
  return { ok: true, status: 200, json: async () => body };
}

function headersOf(call = 0): Record<string, string> {
  return (fetchMock.mock.calls[call][1] as { headers: Record<string, string> })
    .headers;
}

function bodyOf(call = 0): Record<string, unknown> {
  return JSON.parse(
    (fetchMock.mock.calls[call][1] as { body: string }).body,
  ) as Record<string, unknown>;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  rzp.ordersFetchPayments.mockResolvedValue({
    count: 1,
    items: [{ id: "pay_captured", status: "captured" }],
  });
});

describe("X-Refund-Idempotency header", () => {
  it("sends the caller's key verbatim when it is valid", async () => {
    fetchMock.mockResolvedValue(okResponse());

    await createRazorpayRefund({
      paymentIntentId: "order_1",
      amount: 5000,
      idempotencyKey: "clx3k2j9a0000abcd1234efgh",
    });

    expect(headersOf()["X-Refund-Idempotency"]).toBe(
      "clx3k2j9a0000abcd1234efgh",
    );
  });

  it("always sends the header, because the key is no longer optional", async () => {
    fetchMock.mockResolvedValue(okResponse());

    // #1352 — this used to assert the opposite: with no key supplied, no
    // header. Optionality was the only way to express a non-idempotent refund,
    // and a network-error retry of one credits the customer's card twice. The
    // key is required at the type level now, so every refund carries it.
    await createRazorpayRefund({
      paymentIntentId: "order_1",
      amount: 5000,
      idempotencyKey: "clx3k2j9a0000abcd1234efgh",
    });

    expect(headersOf()["X-Refund-Idempotency"]).toBe(
      "clx3k2j9a0000abcd1234efgh",
    );
  });

  it("refuses a key that cannot satisfy Razorpay's >=10 char rule", async () => {
    fetchMock.mockResolvedValue(okResponse());

    // Previously this silently dropped the header and issued the refund anyway,
    // which downgraded an explicitly-idempotent call to at-least-once delivery
    // against a customer's card with no signal. A caller that supplies a key is
    // asking for exactly-once; if we can't honour that, refuse.
    await expect(
      createRazorpayRefund({
        paymentIntentId: "order_1",
        amount: 5000,
        idempotencyKey: "short",
      }),
    ).rejects.toThrow(/not a valid Razorpay key/);

    // And crucially: no request was sent, so no money moved.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a key containing characters Razorpay does not allow", async () => {
    fetchMock.mockResolvedValue(okResponse());

    // Sanitizing instead of rejecting is lossy: "refund:abc/def" and
    // "refund/abc:def" both reduce to "refundabcdef", so two distinct refunds
    // would share one header value and Razorpay would answer the second with
    // the first one's result.
    await expect(
      createRazorpayRefund({
        paymentIntentId: "order_1",
        amount: 5000,
        idempotencyKey: "refund:abc/def ghi+jkl",
      }),
    ).rejects.toThrow(/not a valid Razorpay key/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reuses the same key across a retry of the same logical refund", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue(okResponse());

    const params = {
      paymentIntentId: "order_1",
      amount: 5000,
      idempotencyKey: "clx3k2j9a0000abcd1234efgh",
    };
    await expect(createRazorpayRefund(params)).rejects.toThrow();
    const result = await createRazorpayRefund(params);

    expect(headersOf(0)["X-Refund-Idempotency"]).toBe(
      headersOf(1)["X-Refund-Idempotency"],
    );
    // Same key -> Razorpay replays the original refund, no second debit.
    expect(result.refundId).toBe("rfnd_original");
  });
});

describe("request shape", () => {
  it("POSTs to the captured payment with basic auth and omits amount on a full refund", async () => {
    fetchMock.mockResolvedValue(okResponse());

    await createRazorpayRefund({
      paymentIntentId: "order_1",
      idempotencyKey: "clx3k2j9a0000abcd1234efgh",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string }];
    expect(url).toBe(
      "https://api.razorpay.com/v1/payments/pay_captured/refund",
    );
    expect(init.method).toBe("POST");
    expect(headersOf().Authorization).toBe(
      `Basic ${Buffer.from("rzp_test_key:rzp_test_secret").toString("base64")}`,
    );
    // A full refund must not pin an amount — Razorpay refunds the balance.
    expect(bodyOf()).not.toHaveProperty("amount");
  });

  it("sends the amount in paise for a partial refund", async () => {
    fetchMock.mockResolvedValue(okResponse());

    await createRazorpayRefund({
      paymentIntentId: "order_1",
      amount: 5000,
      idempotencyKey: "clx3k2j9a0000abcd1234efgh",
    });

    expect(bodyOf().amount).toBe(5000);
  });
});

describe("409 concurrent duplicate", () => {
  it("retries once and returns the original refund", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({}) })
      .mockResolvedValue(okResponse());

    const result = await createRazorpayRefund({
      paymentIntentId: "order_1",
      amount: 5000,
      idempotencyKey: "clx3k2j9a0000abcd1234efgh",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.refundId).toBe("rfnd_original");
  });

  it("gives up after a second 409 so the reconcile cron owns recovery", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({}),
    });

    await expect(
      createRazorpayRefund({
        paymentIntentId: "order_1",
        amount: 5000,
        idempotencyKey: "clx3k2j9a0000abcd1234efgh",
      }),
    ).rejects.toMatchObject({ code: "REFUND_IN_FLIGHT" });
  });
});

describe("error passthrough", () => {
  it("surfaces Razorpay's error code and description", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          code: "BAD_REQUEST_ERROR",
          description: "The amount is more than the refundable amount",
        },
      }),
    });

    await expect(
      createRazorpayRefund({
        paymentIntentId: "order_1",
        amount: 999_999,
        idempotencyKey: "clx3k2j9a0000abcd1234efgh",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST_ERROR",
      message: "The amount is more than the refundable amount",
    });
  });

  it("classifies an envelope with no error body instead of throwing a TypeError", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: undefined }),
    });

    // #1353 — the `"error" in error` guard passed on this shape and then read
    // `.code` off undefined, so reconcile-refunds died on the TypeError instead
    // of recording a classified failure (E2E 2026-09-04).
    const thrown = await createRazorpayRefund({
      paymentIntentId: "order_1",
      amount: 5000,
      idempotencyKey: "clx3k2j9a0000abcd1234efgh",
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(RefundError);
    expect(thrown).toMatchObject({
      code: "UNKNOWN_ERROR",
      message: "Failed to process refund",
    });
  });
});

describe("status mapping", () => {
  it.each([
    ["processed", "SUCCEEDED"],
    ["pending", "PENDING"],
    ["failed", "FAILED"],
    // Previously fell through to PENDING, so a cancelled refund was polled forever.
    ["cancelled", "CANCELLED"],
    ["canceled", "CANCELLED"],
  ])("maps %s -> %s", async (gatewayStatus, expected) => {
    fetchMock.mockResolvedValue(
      okResponse({ ...REFUND_BODY, status: gatewayStatus }),
    );

    const result = await createRazorpayRefund({
      paymentIntentId: "order_1",
      amount: 5000,
      idempotencyKey: "clx3k2j9a0000abcd1234efgh",
    });

    expect(result.status).toBe(expected);
  });
});
