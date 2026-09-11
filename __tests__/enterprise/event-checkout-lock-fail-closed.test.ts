/**
 * @jest-environment node
 *
 * CN-1 (#676) — lockEventCheckout must fail CLOSED when Redis is unreachable.
 *
 * The old implementation rewrote EVERY error (including a Redis outage) as a
 * benign "another user is checking out" contention message. The caller treats
 * that as retry-later and, on the unlocked path, two concurrent buyers could
 * both clear the same finite event capacity. These tests pin the corrected
 * behaviour: Redis down ⇒ a distinct EventCheckoutLockUnavailableError (so the
 * route can 503), while GENUINE contention still surfaces the benign message.
 *
 * Retry backoff (acquireLockWithRetry) is exponential and would otherwise burn
 * real wall-clock + trip Jest's 5s timeout, so the lock-held / Redis-error
 * cases run under fake timers and drain the pending delays explicitly.
 */

import {
  lockEventCheckout,
  EventCheckoutLockUnavailableError,
  LockContentionError,
} from "../../utils/appointmentlock";

// The real withCircuitBreaker is kept (so we exercise the actual breaker), but
// checkRedisHealth and the default redis client are controllable per-test.
const mockHealth = jest.fn();
const mockSet = jest.fn();
const mockEval = jest.fn();

jest.mock("../../lib/redis", () => {
  const actual = jest.requireActual("../../lib/redis");
  return {
    __esModule: true,
    // Default export = the redis client appointmentlock.ts acquires through.
    default: {
      set: (...args: unknown[]) => mockSet(...args),
      eval: (...args: unknown[]) => mockEval(...args),
    },
    withCircuitBreaker: actual.withCircuitBreaker,
    resetCircuitBreaker: actual.resetCircuitBreaker,
    checkRedisHealth: (...args: unknown[]) => mockHealth(...args),
  };
});

const TTL = 1000;

/**
 * Run a promise that may schedule exponential-backoff setTimeouts, draining the
 * fake-timer queue until it settles. Returns the resolved value or thrown error.
 */
async function settleWithTimers<T>(p: Promise<T>): Promise<T | Error> {
  const tracked = p.then(
    (v) => ({ ok: true as const, v }),
    (e: Error) => ({ ok: false as const, e }),
  );
  // 12 acquireLockWithRetry attempts; flush generously past the largest delay.
  for (let i = 0; i < 15; i++) {
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(200_000);
  }
  const r = await tracked;
  return r.ok ? r.v : r.e;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Reset the shared circuit breaker between tests so one test's failures
  // don't leak an OPEN state into the next.
  const { resetCircuitBreaker } = jest.requireActual("../../lib/redis");
  resetCircuitBreaker();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("lockEventCheckout — CN-1 fail-closed", () => {
  it("rejects with EventCheckoutLockUnavailableError when Redis is unhealthy (down at entry)", async () => {
    mockHealth.mockResolvedValue(false);

    await expect(
      lockEventCheckout("WEBINAR", "event-1", TTL),
    ).rejects.toBeInstanceOf(EventCheckoutLockUnavailableError);

    // Fail CLOSED: we must NOT have attempted to take the lock, and must NOT
    // have returned a benign contention result that lets checkout proceed.
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("carries a 503 + stable code so the route can reject", async () => {
    mockHealth.mockResolvedValue(false);

    const err = await lockEventCheckout("CLASS", "event-2", TTL).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(EventCheckoutLockUnavailableError);
    expect((err as EventCheckoutLockUnavailableError).httpStatus).toBe(503);
    expect((err as EventCheckoutLockUnavailableError).code).toBe(
      "EVENT_CHECKOUT_LOCK_UNAVAILABLE",
    );
  });

  it("returns the lock when Redis is healthy and the lock is free", async () => {
    mockHealth.mockResolvedValue(true);
    mockSet.mockResolvedValue("OK");

    const lock = await lockEventCheckout("WEBINAR", "event-4", TTL);

    expect(lock.key).toBe("event-checkout:WEBINAR:event-4");
    expect(typeof lock.value).toBe("string");
    expect(mockSet).toHaveBeenCalledTimes(1);
  });

  it("rejects with EventCheckoutLockUnavailableError when Redis throws mid-acquisition", async () => {
    // Health passes, but the SET command itself errors on every attempt
    // (connection reset). This must still fail closed, not look like contention.
    jest.useFakeTimers();
    mockHealth.mockResolvedValue(true);
    mockSet.mockRejectedValue(new Error("ECONNRESET"));

    const err = await settleWithTimers(
      lockEventCheckout("WEBINAR", "event-3", TTL),
    );

    expect(err).toBeInstanceOf(EventCheckoutLockUnavailableError);
  });

  it("surfaces the benign contention message (NOT the unavailable error) when the lock is genuinely held", async () => {
    // Health passes; SET NX keeps returning null (lock held) → retries exhaust.
    jest.useFakeTimers();
    mockHealth.mockResolvedValue(true);
    mockSet.mockResolvedValue(null);

    const err = (await settleWithTimers(
      lockEventCheckout("CLASS", "event-5", TTL),
    )) as Error;

    // Genuine contention must NOT be misreported as an outage (fail OPEN here).
    expect(err).not.toBeInstanceOf(EventCheckoutLockUnavailableError);
    expect(err).not.toBeInstanceOf(LockContentionError);
    expect(err.message).toContain("Another user is currently");
    // It did try (and retry) to acquire.
    expect(mockSet.mock.calls.length).toBeGreaterThan(1);
  });
});
