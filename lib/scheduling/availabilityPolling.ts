/**
 * #1164 — poll-decision logic for the availability heatmap, kept pure so the
 * policy is unit-testable without a DOM. The hook (useCalendarData) owns the
 * timers and listeners; this module owns the two decisions they consult.
 *
 * Polling, not push (#1164 decision): the grid is a hint, allocation
 * re-validates server-side, so bounded staleness is fine and a socket is not.
 */

export const AVAILABILITY_POLL_INTERVAL_MS = 60_000;

/**
 * Staleness floor for the visibility/focus refetch. Both listeners fire on a
 * tab return (focus + visibilitychange), and the first one to refetch stamps
 * the fetch time — so the second sees sub-floor staleness and only re-arms.
 * The same floor absorbs a quick alt-tab flick.
 */
export const RETURN_REFETCH_MIN_STALENESS_MS = 5_000;

export interface PollContext {
  /** autoLoad && consultantId — the same gate the fetch effects use. */
  enabled: boolean;
  /** document.visibilityState at decision time. */
  visibilityState: DocumentVisibilityState;
}

/** A hidden tab never polls; it re-arms on the visibilitychange back. */
export function shouldPoll(ctx: PollContext): boolean {
  return ctx.enabled && ctx.visibilityState !== "hidden";
}

/**
 * Delay before the next poll, given how stale the data already is. On a
 * return to a tab hidden longer than the interval this is 0 — refetch now;
 * a quick alt-tab flick keeps the remainder of the current interval instead
 * of hammering the endpoint.
 */
export function nextPollDelay(
  msSinceLastFetch: number,
  intervalMs: number = AVAILABILITY_POLL_INTERVAL_MS,
): number {
  if (!Number.isFinite(msSinceLastFetch) || msSinceLastFetch < 0) {
    return intervalMs;
  }
  return Math.max(0, intervalMs - msSinceLastFetch);
}

/**
 * Whether a return to the tab/window (focus or visibilitychange→visible)
 * refetches immediately rather than just re-arming the timer. An unknown
 * last-fetch time (NaN) counts as stale — refetching is the safe answer.
 */
export function shouldRefetchOnReturn(msSinceLastFetch: number): boolean {
  return (
    !Number.isFinite(msSinceLastFetch) ||
    msSinceLastFetch >= RETURN_REFETCH_MIN_STALENESS_MS
  );
}

/** Everything the scheduler asks the hook, so none of it is captured stale. */
export interface AvailabilityPollerDeps {
  /** `autoLoad && consultantId` — the same gate the fetch effects use. */
  isEnabled: () => boolean;
  visibilityState: () => DocumentVisibilityState;
  /** Milliseconds since the last availability fetch stamped its time. */
  msSinceLastFetch: () => number;
  /** A navigation/allocation fetch already running, or null. */
  inFlight: () => Promise<unknown> | null;
  /** Runs one background availability fetch. */
  fetch: () => Promise<unknown>;
}

export interface AvailabilityPoller {
  /** Schedule the next poll from the current staleness. */
  arm(): void;
  /** focus / visibilitychange→visible. */
  onReturn(): void;
  /** visibilitychange, either direction. */
  onVisibilityChange(): void;
  dispose(): void;
}

/**
 * The timer half of the poll loop, lifted out of `useCalendarData` so it can
 * be driven by fake timers instead of only by a browser (#1164 R17).
 *
 * Two defects came out with it. The hook passed a literal `enabled: true` into
 * `shouldPoll`, so the gate that decides whether polling should happen at all
 * could only ever answer "yes" — a dead branch wearing the shape of a
 * decision. And `onReturn` called `tick()` on a stale return WITHOUT clearing
 * the timer it had already armed, so the pending timeout fired behind the
 * fetch the return had just started: two ticks, two requests, and the second
 * one bumping the request id out from under the first.
 */
export function createAvailabilityPoller(
  deps: AvailabilityPollerDeps,
): AvailabilityPoller {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearPending = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const mayPoll = (): boolean =>
    !disposed &&
    shouldPoll({
      enabled: deps.isEnabled(),
      visibilityState: deps.visibilityState(),
    });

  const arm = () => {
    if (!mayPoll()) return;
    clearPending();
    timer = setTimeout(tick, nextPollDelay(deps.msSinceLastFetch()));
  };

  const tick = () => {
    timer = null;
    if (!mayPoll()) return;
    // A navigation (or post-allocation) fetch is still running. Starting a
    // poll now would bump the request id out from under it and strand its
    // id-guarded `setLoading(false)` — the grid would sit on the skeleton
    // until the next navigation. Wait for that answer, which is the fresher
    // one anyway, and re-arm behind it.
    const inFlight = deps.inFlight();
    if (inFlight) {
      void inFlight.then(arm, arm);
      return;
    }
    // Serialized: the next tick is armed only once this fetch settles, so a
    // slow response never stacks polls behind it.
    void deps.fetch().then(arm, arm);
  };

  const onReturn = () => {
    // Drop whatever was armed BEFORE deciding. A return either refetches now
    // or re-arms from the new staleness; either way the old timeout is stale,
    // and leaving it pending is what let a second tick fire behind the first.
    clearPending();
    if (!mayPoll()) return;
    if (shouldRefetchOnReturn(deps.msSinceLastFetch())) tick();
    else arm();
  };

  const onVisibilityChange = () => {
    // Paused: nothing polls a hidden tab; the return re-arms it.
    if (deps.visibilityState() === "hidden") clearPending();
    else onReturn();
  };

  return {
    arm,
    onReturn,
    onVisibilityChange,
    dispose: () => {
      disposed = true;
      clearPending();
    },
  };
}
