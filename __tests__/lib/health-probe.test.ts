/**
 * @jest-environment node
 */

/**
 * #1557 / #1124 — the health probe must tell a blocked event loop from a slow
 * dependency.
 *
 * The bug this pins: a deadline armed before a cold-instance stall fires on
 * the first tick after it, together with everything else that was waiting, and
 * before the operation it was supposed to bound has run at all. Reported as a
 * timeout, that is a lie about the dependency. The helpers here recognise the
 * lie (a deadline that wakes at more than twice its budget) and retry exactly
 * once, and only then — a timeout that fired on schedule is real and stays.
 */

import {
  measureEventLoopStall,
  probeWithBudget,
  probeWithStallRetry,
  ProbeTimeout,
} from "../../lib/health/probe";

/** A clock that hands out the given readings in order, then the last one. */
function scriptedClock(readings: number[]): () => number {
  let i = 0;
  return () => readings[Math.min(i++, readings.length - 1)];
}

const never = () => new Promise<never>(() => {});

/** Block the loop synchronously for `ms` on its next turn. */
function blockLoopSoon(ms: number): void {
  setTimeout(() => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* busy */
    }
  }, 0);
}

describe("measureEventLoopStall", () => {
  it("reads ~0 on a loop that is running", async () => {
    expect(await measureEventLoopStall()).toBeLessThan(50);
  });

  it("reports a synchronous block that lands on its yield", async () => {
    // The block is queued before the yield, so it runs first and the yield's
    // own timer cannot fire until it is done — the shape of #1124's stall.
    blockLoopSoon(60);
    expect(await measureEventLoopStall()).toBeGreaterThanOrEqual(55);
  });

  it("never reports a negative stall", async () => {
    expect(await measureEventLoopStall(scriptedClock([100, 90]))).toBe(0);
  });
});

describe("probeWithBudget", () => {
  it("reports success with its elapsed time", async () => {
    const outcome = await probeWithBudget(
      async () => "row",
      1_000,
      scriptedClock([0, 12]),
    );
    expect(outcome).toEqual({
      ok: true,
      elapsedMs: 12,
      timedOut: false,
      staleTimer: false,
    });
  });

  it("reports the operation's own rejection as neither timeout nor stale", async () => {
    const boom = new Error("connection refused");
    const outcome = await probeWithBudget(
      () => Promise.reject(boom),
      1_000,
      scriptedClock([0, 3]),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.staleTimer).toBe(false);
    expect(outcome.error).toBe(boom);
  });

  it("a deadline that fires on schedule is a real timeout, not a stale one", async () => {
    const outcome = await probeWithBudget(never, 20, scriptedClock([0, 25]));
    expect(outcome.ok).toBe(false);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.staleTimer).toBe(false);
    expect(outcome.error).toBeInstanceOf(ProbeTimeout);
  });

  it("a deadline that fires at more than twice its budget is stale", async () => {
    // Real 20 ms timer; the clock says 30 s passed. That is what a 5 s budget
    // armed before a 30 s stall looks like from inside the handler.
    const outcome = await probeWithBudget(
      never,
      20,
      scriptedClock([0, 30_000]),
    );
    expect(outcome.timedOut).toBe(true);
    expect(outcome.staleTimer).toBe(true);
    expect(outcome.elapsedMs).toBe(30_000);
  });

  it("a deadline at exactly twice its budget is still trusted", async () => {
    const outcome = await probeWithBudget(never, 20, scriptedClock([0, 40]));
    expect(outcome.staleTimer).toBe(false);
  });
});

describe("probeWithStallRetry", () => {
  it("does not retry a success", async () => {
    const op = jest.fn(async () => "row");
    const outcome = await probeWithStallRetry(op, 1_000, scriptedClock([0, 1]));
    expect(outcome.ok).toBe(true);
    expect(outcome.retried).toBe(false);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("does not retry a genuine timeout — a saturated pooler has earned its verdict", async () => {
    const op = jest.fn(never);
    const outcome = await probeWithStallRetry(op, 20, scriptedClock([0, 25]));
    expect(outcome.ok).toBe(false);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.retried).toBe(false);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("does not retry the operation's own rejection", async () => {
    const op = jest.fn(() => Promise.reject(new Error("refused")));
    const outcome = await probeWithStallRetry(op, 1_000, scriptedClock([0, 2]));
    expect(outcome.retried).toBe(false);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries a stale timeout exactly once and reports the second attempt", async () => {
    const op = jest
      .fn<Promise<unknown>, []>()
      .mockImplementationOnce(never)
      .mockResolvedValueOnce("row");
    // First attempt: armed at 0, woke at 30 000 (stale). Second: 0 → 330 ms,
    // the retry lib/prisma.ts describes.
    const outcome = await probeWithStallRetry(
      op,
      20,
      scriptedClock([0, 30_000, 0, 330]),
    );
    expect(outcome).toEqual({
      ok: true,
      elapsedMs: 330,
      timedOut: false,
      staleTimer: false,
      retried: true,
    });
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("a second stale timeout is reported, not retried again", async () => {
    const op = jest.fn(never);
    const outcome = await probeWithStallRetry(
      op,
      20,
      scriptedClock([0, 30_000, 0, 30_000]),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.staleTimer).toBe(true);
    expect(outcome.retried).toBe(true);
    expect(op).toHaveBeenCalledTimes(2);
  });
});
