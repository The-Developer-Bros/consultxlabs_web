/**
 * @jest-environment node
 */

/**
 * #1477 — `POST /api/checkout` captured every error that reached its generic
 * tail as a Sentry exception, before it had even been classified. Only the
 * refusals with an explicit `instanceof` branch above that line escaped it, so
 * the #1458 programme-cap codes and the #1467 entitlement codes answered the
 * buyer correctly and still opened an incident on every routine refusal.
 *
 * The route's collaborators are boundary-mocked: what is under test is which
 * report a coded refusal gets on its way out of the catch, not auth, rate
 * limiting, tax context or gateway routing.
 */

jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: jest.fn(async () => ({
    session: { user: { id: "user_1" } },
  })),
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  checkoutLimiter: { limit: jest.fn() },
}));

const handleCheckout = jest.fn();
jest.mock("../../lib/payments/operations/checkout", () => ({
  handleCheckout: (...args: unknown[]) => handleCheckout(...args),
}));

jest.mock("../../lib/payments/operations/checkout-replay", () => ({
  replayByIdempotencyKey: jest.fn(async () => null),
}));

jest.mock("../../lib/payments/tax/checkout-context", () => ({
  resolveCheckoutTaxContext: jest.fn(async () => ({ buyerCountry: "IN" })),
}));

jest.mock("../../lib/payments/gateway-router", () => ({
  routeGateway: jest.fn(() => ({ gateway: "RAZORPAY", reason: "domestic" })),
}));

// The schema is a boundary here: the body only has to survive parsing so the
// handler can reach `handleCheckout` and throw.
jest.mock("../../schemas/checkout", () => ({
  checkoutSchema: { parse: (body: Record<string, unknown>) => ({ ...body }) },
}));

const captureException = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  captureMessage: jest.fn(),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

import { NextRequest } from "next/server";

import { POST } from "../../app/api/checkout/route";

function checkoutRequest() {
  return new NextRequest("https://x.test/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appointmentId: "appt_1", amount: 100 }),
  });
}

/** The context Sentry was handed, for the single capture the route made. */
function soleCaptureContext(): {
  level?: string;
  tags?: Record<string, string>;
} {
  expect(captureException).toHaveBeenCalledTimes(1);
  return (captureException.mock.calls[0]?.[1] ?? {}) as {
    level?: string;
    tags?: Record<string, string>;
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("a business-coded refusal leaves POST /api/checkout as an answer", () => {
  it("answers PROGRAM_ASSIGNMENT_INACTIVE 409 without an error-level capture", async () => {
    handleCheckout.mockRejectedValue(
      Object.assign(
        new Error("No active programme assignment covers this session type"),
        { code: "PROGRAM_ASSIGNMENT_INACTIVE" },
      ),
    );

    const res = await POST(checkoutRequest());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.errorType).toBe("PROGRAM_ASSIGNMENT_INACTIVE_ERROR");

    // Reported, but as a modelled outcome: `expected` tagged true and the level
    // pinned to info. An error-level capture is exactly what paged us.
    const context = soleCaptureContext();
    expect(context.level).toBe("info");
    expect(context.tags?.expected).toBe("true");
  });

  it("still captures an unrecognised failure at Sentry's default level", async () => {
    handleCheckout.mockRejectedValue(new Error("connection terminated"));

    const res = await POST(checkoutRequest());

    expect(res.status).toBe(500);
    // Two captures here (the route's own, then logClassifiedError's). Asserted
    // rather than assumed, so the loop below cannot pass on an empty list; the
    // point of the loop is that neither is downgraded to a modelled outcome.
    expect(captureException).toHaveBeenCalledTimes(2);
    for (const call of captureException.mock.calls) {
      const context = (call[1] ?? {}) as {
        level?: string;
        tags?: Record<string, string>;
      };
      expect(context.level).toBeUndefined();
      expect(context.tags?.expected).not.toBe("true");
    }
  });
});
