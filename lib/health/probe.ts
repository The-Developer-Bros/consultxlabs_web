/**
 * #1557 / #1124 — health probes that survive a cold-instance stall.
 *
 * A brand-new `___netlify-server-handler` instance blocks its event loop for
 * 24–39 s during the handler's first `await`, before any application work
 * (#1124, measured on deploy preview 1123 and again on 2026-08-23). Nothing
 * scheduled on the loop can run inside that window — not a `setTimeout`, not
 * a socket callback — so every deadline armed before the stall fires on the
 * first tick after it, and fires together. `/api/health` used to arm its DB
 * budget, hit the stall, and then report `database: "unreachable"` because
 * the timers woke before the query got a turn. The database was never slow:
 * Sentry shows the same "DB health probe failed" line on every stall, and the
 * retry `lib/prisma.ts` describes connects in ~330 ms.
 *
 * Two pieces:
 *
 *   - {@link measureEventLoopStall} yields once and reports how long the yield
 *     took. Called before anything else in the handler it ABSORBS the stall,
 *     so every budget armed afterwards measures its dependency and not the
 *     platform. The number is also the only reliable record of the stall:
 *     the function log strips `console.*` (#1122) and the handler emits no
 *     `Init Duration` line, which #1124 lists as its observability gap.
 *
 *   - {@link probeWithBudget} races an operation against a deadline and says
 *     whether a timeout is trustworthy. A deadline that fired at more than
 *     twice its own budget did not measure the operation — the loop was
 *     blocked — and {@link probeWithStallRetry} re-runs the probe exactly once
 *     with a fresh budget in that case, and only in that case. A timeout that
 *     fired on schedule is a real one and is reported as such.
 */

export interface ProbeOutcome {
  ok: boolean;
  /** Wall-clock milliseconds the attempt took, stall included. */
  elapsedMs: number;
  /** The deadline won the race. */
  timedOut: boolean;
  /**
   * The deadline won, but so late that it cannot have been measuring the
   * operation: the loop was blocked. Only ever true alongside `timedOut`.
   */
  staleTimer: boolean;
  /** The operation's own rejection, or the timeout error. Unset on success. */
  error?: unknown;
}

export class ProbeTimeout extends Error {
  constructor(budgetMs: number) {
    super(`Probe exceeded ${budgetMs}ms`);
    this.name = "ProbeTimeout";
  }
}

/** Injectable for tests; production uses the monotonic clock. */
export type Clock = () => number;

const defaultClock: Clock = () => performance.now();

/**
 * Yield to the event loop once and report how long the yield took.
 *
 * On a warm instance this is 0–2 ms. On a brand-new instance under concurrent
 * creation it is the whole #1124 stall, because that stall lands on the
 * handler's first await and this is arranged to be it.
 */
export async function measureEventLoopStall(
  clock: Clock = defaultClock,
): Promise<number> {
  const started = clock();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return Math.max(0, Math.round(clock() - started));
}

/**
 * Race `operation` against `budgetMs`.
 *
 * Never throws — a health check reports outcomes, it does not fail on them.
 * The operation is not cancelled on timeout (Prisma exposes no signal to
 * cancel a query with); it settles on its own and its result is discarded,
 * the same accepted leak `lib/stream/health.ts` documents for its probe.
 */
export async function probeWithBudget(
  operation: () => Promise<unknown>,
  budgetMs: number,
  clock: Clock = defaultClock,
): Promise<ProbeOutcome> {
  const started = clock();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeout(budgetMs)), budgetMs);
      }),
    ]);
    return {
      ok: true,
      elapsedMs: Math.round(clock() - started),
      timedOut: false,
      staleTimer: false,
    };
  } catch (error) {
    const elapsedMs = Math.round(clock() - started);
    const timedOut = error instanceof ProbeTimeout;
    return {
      ok: false,
      elapsedMs,
      timedOut,
      // A deadline that fires at more than twice its budget was not measuring
      // the operation. The factor is deliberately generous: a 5 s budget that
      // wakes at 6 s is a slow platform, at 30 s it is a blocked loop.
      staleTimer: timedOut && elapsedMs > budgetMs * 2,
      error,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * {@link probeWithBudget}, re-run once when the first attempt's timeout was
 * stale. A genuine timeout is returned as-is — retrying it would only delay
 * the "unreachable" verdict that a saturated pooler (#912) has earned.
 */
export async function probeWithStallRetry(
  operation: () => Promise<unknown>,
  budgetMs: number,
  clock: Clock = defaultClock,
): Promise<ProbeOutcome & { retried: boolean }> {
  const first = await probeWithBudget(operation, budgetMs, clock);
  if (!first.staleTimer) return { ...first, retried: false };
  const second = await probeWithBudget(operation, budgetMs, clock);
  return { ...second, retried: true };
}
