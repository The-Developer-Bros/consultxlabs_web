/**
 * Poll-decision policy for the availability heatmap (#1164). The hook owns the
 * timers; these three functions own the decisions, so the behaviour that
 * matters — never poll a hidden tab, refetch on a stale return, don't hammer
 * the endpoint on an alt-tab flick — is pinned without a DOM.
 */

import "./setup";

import {
  AVAILABILITY_POLL_INTERVAL_MS,
  RETURN_REFETCH_MIN_STALENESS_MS,
  createAvailabilityPoller,
  nextPollDelay,
  shouldPoll,
  shouldRefetchOnReturn,
} from "@/lib/scheduling/availabilityPolling";

describe("shouldPoll", () => {
  it("polls a visible tab that the hook has enabled", () => {
    expect(shouldPoll({ enabled: true, visibilityState: "visible" })).toBe(true);
  });

  it("never polls a hidden tab", () => {
    expect(shouldPoll({ enabled: true, visibilityState: "hidden" })).toBe(false);
  });

  it("never polls when the fetch gate itself is off", () => {
    // autoLoad=false / no consultantId — the same gate the fetch effects use.
    expect(shouldPoll({ enabled: false, visibilityState: "visible" })).toBe(
      false,
    );
  });
});

describe("nextPollDelay", () => {
  it("waits a full interval when the data was just fetched", () => {
    expect(nextPollDelay(0)).toBe(AVAILABILITY_POLL_INTERVAL_MS);
  });

  it("waits only the remainder of the current interval", () => {
    expect(nextPollDelay(20_000)).toBe(AVAILABILITY_POLL_INTERVAL_MS - 20_000);
  });

  it("fires immediately once the interval has already elapsed", () => {
    // A tab hidden longer than the interval must not sit out another minute.
    expect(nextPollDelay(AVAILABILITY_POLL_INTERVAL_MS + 5 * 60_000)).toBe(0);
  });

  it("treats an unknown last-fetch time as a fresh interval", () => {
    // NaN is the pre-first-fetch state; scheduling at 0 would busy-loop.
    expect(nextPollDelay(Number.NaN)).toBe(AVAILABILITY_POLL_INTERVAL_MS);
    expect(nextPollDelay(-1)).toBe(AVAILABILITY_POLL_INTERVAL_MS);
  });

  it("honours a caller-supplied interval", () => {
    expect(nextPollDelay(1_000, 10_000)).toBe(9_000);
  });
});

describe("shouldRefetchOnReturn", () => {
  it("refetches when the grid is at least as stale as the floor", () => {
    expect(shouldRefetchOnReturn(RETURN_REFETCH_MIN_STALENESS_MS)).toBe(true);
    expect(shouldRefetchOnReturn(60_000)).toBe(true);
  });

  it("only re-arms after an alt-tab flick", () => {
    // focus and visibilitychange both fire on a return; the second one must
    // not issue a duplicate request behind the first.
    expect(shouldRefetchOnReturn(0)).toBe(false);
    expect(shouldRefetchOnReturn(RETURN_REFETCH_MIN_STALENESS_MS - 1)).toBe(
      false,
    );
  });

  it("refetches when the last fetch time is unknown", () => {
    expect(shouldRefetchOnReturn(Number.NaN)).toBe(true);
  });
});

/**
 * R17 — the timer loop itself, now that it is liftable out of the hook.
 *
 * Two defects lived here. `useCalendarData` passed a literal `enabled: true`
 * into `shouldPoll`, so the gate that decides whether polling should run at
 * all could only ever answer yes. And `onReturn` called `tick()` on a stale
 * return without clearing the timeout it had already armed, so the pending
 * timer fired behind the fetch the return had just started — two ticks, two
 * requests, the second bumping the request id out from under the first.
 */
describe("createAvailabilityPoller", () => {
  const makeHarness = (
    overrides: Partial<{
      enabled: boolean;
      visibility: DocumentVisibilityState;
      msSinceLastFetch: number;
    }> = {},
  ) => {
    const state = {
      enabled: overrides.enabled ?? true,
      visibility:
        overrides.visibility ?? ("visible" as DocumentVisibilityState),
      msSinceLastFetch: overrides.msSinceLastFetch ?? 0,
    };
    const fetches: Array<() => void> = [];
    const fetchFn = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          fetches.push(resolve);
        }),
    );
    const poller = createAvailabilityPoller({
      isEnabled: () => state.enabled,
      visibilityState: () => state.visibility,
      msSinceLastFetch: () => state.msSinceLastFetch,
      inFlight: () => null,
      fetch: fetchFn,
    });
    return { state, fetchFn, fetches, poller };
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("fires exactly one tick when a stale return races the armed timer", () => {
    // Armed just under a full interval ago, so the pending timeout is about to
    // fire; the return is over the staleness floor, so it refetches now.
    const h = makeHarness({
      msSinceLastFetch: AVAILABILITY_POLL_INTERVAL_MS - 1,
    });
    h.poller.arm();

    h.state.msSinceLastFetch = 30_000;
    h.poller.onReturn();
    expect(h.fetchFn).toHaveBeenCalledTimes(1);

    // The old timeout must be gone. Before the fix it was still pending here
    // and this drain fired a second poll behind the in-flight one.
    jest.advanceTimersByTime(AVAILABILITY_POLL_INTERVAL_MS * 2);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);

    h.poller.dispose();
  });

  it("only re-arms on an alt-tab flick, and the re-arm is a single timer", () => {
    const h = makeHarness({ msSinceLastFetch: 0 });
    h.poller.arm();

    // focus and visibilitychange both fire; neither is stale enough to refetch.
    h.poller.onReturn();
    h.poller.onVisibilityChange();
    expect(h.fetchFn).not.toHaveBeenCalled();

    jest.advanceTimersByTime(AVAILABILITY_POLL_INTERVAL_MS);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);

    h.poller.dispose();
  });

  it("honours the enable gate the hook used to hardcode to true", () => {
    const h = makeHarness({ enabled: false });
    h.poller.arm();
    jest.advanceTimersByTime(AVAILABILITY_POLL_INTERVAL_MS * 2);
    expect(h.fetchFn).not.toHaveBeenCalled();

    // And a return while disabled neither fetches nor arms anything.
    h.poller.onReturn();
    jest.advanceTimersByTime(AVAILABILITY_POLL_INTERVAL_MS * 2);
    expect(h.fetchFn).not.toHaveBeenCalled();

    h.poller.dispose();
  });

  it("pauses on hide and does not leave a timer running", () => {
    const h = makeHarness({ msSinceLastFetch: 0 });
    h.poller.arm();

    h.state.visibility = "hidden";
    h.poller.onVisibilityChange();
    jest.advanceTimersByTime(AVAILABILITY_POLL_INTERVAL_MS * 3);
    expect(h.fetchFn).not.toHaveBeenCalled();

    h.poller.dispose();
  });

  it("stops scheduling once disposed", () => {
    const h = makeHarness({ msSinceLastFetch: 0 });
    h.poller.arm();
    h.poller.dispose();
    jest.advanceTimersByTime(AVAILABILITY_POLL_INTERVAL_MS * 2);
    expect(h.fetchFn).not.toHaveBeenCalled();
  });
});
