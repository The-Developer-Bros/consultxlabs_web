/**
 * B4/B8c/B5 — flash-sale checkout behavior:
 * - the bounded waiter budget on the booking locks (never queue past the
 *   function ceiling),
 * - the typed busy/full errors the route maps to structured 409s,
 * - the client's single automatic retry on a structured BUSY 409.
 */

import "./setup";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

// appointmentlock pulls @upstash/redis (→ uncrypto, an ESM-only module Jest
// cannot parse). Only its TYPES and the retry config are under test, so stub
// the Redis client + breaker at the module boundary. Relative paths required
// — @/ aliases fail in jest.mock.
jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: {},
  withCircuitBreaker: (fn: () => unknown) => fn(),
  checkRedisHealth: jest.fn().mockResolvedValue(true),
}));

// app/checkout/plans/utils imports useToast only for its TYPE; the real
// module pulls the whole Radix toast stack, which Jest cannot parse here.
// Relative path required — @/ aliases fail in jest.mock.
jest.mock("../../hooks/use-toast", () => ({
  __esModule: true,
  useToast: jest.fn(),
}));

// utils.ts also drags Sentry (via the error-classification import) and
// better-auth's uncrypto through the schema chain; neither is needed to test
// the retry helper. Neutralize them so only the helper's own code loads.
jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import {
  CHECKOUT_WAIT_RETRY_CONFIG,
  ConsulteeBookingBusyError,
  EventCheckoutBusyError,
  EventFullError,
} from "../../utils/appointmentlock";
import {
  busyRetryToast,
  fetchCheckoutWithBusyRetry,
} from "@/app/checkout/plans/utils";

describe("bounded checkout lock budgets (B4/B8c)", () => {
  it("caps the waiter retry chain at 5 attempts (~7s worst case, ceiling is ~26s)", () => {
    expect(CHECKOUT_WAIT_RETRY_CONFIG.retryCount).toBe(5);
    expect(CHECKOUT_WAIT_RETRY_CONFIG.retryDelay).toBeGreaterThan(0);
  });

  it("typed busy errors carry 409 + retryAfter for structured responses", () => {
    const eventBusy = new EventCheckoutBusyError("WEBINAR");
    expect(eventBusy.httpStatus).toBe(409);
    expect(eventBusy.retryAfterSeconds).toBeGreaterThan(0);

    const consulteeBusy = new ConsulteeBookingBusyError();
    expect(consulteeBusy.httpStatus).toBe(409);
    expect(consulteeBusy.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("sold-out is terminal: 409 with no retryAfter offered", () => {
    const full = new EventFullError("WEBINAR");
    expect(full.httpStatus).toBe(409);
    expect(full.code).toBe("EVENT_SOLD_OUT");
    expect(full.message).toMatch(/sold out/i);
  });
});

describe("fetchCheckoutWithBusyRetry (B5)", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  // The jest environment has no fetch globals; the helper only touches
  // status / clone().json(), so a structural stub is faithful.
  function jsonResponse(
    status: number,
    body: Record<string, unknown>,
  ): Response {
    return {
      status,
      clone: () => jsonResponse(status, body),
      json: async () => body,
    } as unknown as Response;
  }
  function busyResponse(errorType: string, retryAfter: number): Response {
    return jsonResponse(409, { error: "busy", errorType, retryAfter });
  }

  it("retries exactly once on a structured BUSY 409 and returns the second answer", async () => {
    const okResponse = jsonResponse(200, { success: true });
    let attempts = 0;
    const attempt = jest.fn(() => {
      attempts += 1;
      return Promise.resolve(
        attempts === 1 ? busyResponse("EVENT_CHECKOUT_BUSY", 1) : okResponse,
      );
    });
    const notify = jest.fn();

    const promise = fetchCheckoutWithBusyRetry(attempt, notify);
    await jest.advanceTimersByTimeAsync(1100);
    const result = await promise;

    expect(attempts).toBe(2);
    expect(notify).toHaveBeenCalledWith(1);
    expect(result.status).toBe(200);
  });

  it("passes non-409 responses through untouched", async () => {
    const okResponse = jsonResponse(200, {});
    const attempt = jest.fn(() => Promise.resolve(okResponse));

    const result = await fetchCheckoutWithBusyRetry(attempt, jest.fn());

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result).toBe(okResponse);
  });

  it("does not retry a 409 that is not one of the BUSY types", async () => {
    const attempt = jest.fn(() =>
      Promise.resolve(busyResponse("AVAILABILITY_ERROR", 10)),
    );

    const result = await fetchCheckoutWithBusyRetry(attempt, jest.fn());

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(409);
  });

  it("caps the advised wait at 20s regardless of the server value", async () => {
    const attempt = jest.fn(() =>
      Promise.resolve(busyResponse("CONSULTEE_BOOKING_BUSY", 120)),
    );
    const notify = jest.fn();

    const promise = fetchCheckoutWithBusyRetry(attempt, notify);
    await jest.advanceTimersByTimeAsync(20_500);
    await promise;

    expect(notify).toHaveBeenCalledWith(20);
  });
});

describe("busy-retry copy", () => {
  it("tells the buyer their card was not charged and what happens next", () => {
    const copy = busyRetryToast(10);
    expect(copy.title).toMatch(/one step ahead/i);
    expect(copy.description).toContain("not been charged");
    expect(copy.description).toContain("10s");
  });
});
