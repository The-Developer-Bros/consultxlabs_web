/**
 * @jest-environment node
 */

/**
 * #1280 2.7 — the Join button had no re-entry guard on any surface.
 *
 * The window is not theoretical. Every Join handler awaits
 * `waitForGlobalVideoClient()` first, which on a cold provider waits out a
 * retry ladder measured in seconds, and the per-row "joining" flag that looks
 * like a guard is React state — written asynchronously, so the second click
 * reads the stale value and runs the whole chain again.
 *
 * Two concurrent runs mint the call twice. `useLazyJoinMeeting`'s
 * `joinableSlot ?? appointment.slotsOfAppointment?.[0]` fallback reads an
 * UNSORTED array, so the two runs can resolve two different anchor rows and put
 * the two sides of one booking into two different rooms — which is #1061.
 */

// The plain factory, not the React hook. `useInFlightGuard` is a two-line
// `useMemo` over this, and the repo has no React renderer to drive a hook with —
// so the behaviour lives where it can actually be tested.
import { createInFlightGuard } from "../../hooks/scheduling/useInFlightGuard";

/** A promise we can settle by hand, so two calls genuinely overlap. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useInFlightGuard", () => {
  it("drops a second call with the same key while the first is running", async () => {
    const guard = createInFlightGuard();
    const gate = deferred<string>();
    const action = jest.fn(() => gate.promise);

    const first = guard("join:a", action);
    const second = guard("join:a", action);

    // The action ran once. This is the whole point: a double-click must not
    // produce two concurrent mints.
    expect(action).toHaveBeenCalledTimes(1);

    gate.resolve("meeting-1");
    await first;

    // `undefined`, not `false` — a caller has to be able to tell "dropped as a
    // duplicate" from "ran and reported failure"; they want different UI.
    await expect(second).resolves.toBeUndefined();
    await expect(first).resolves.toBe("meeting-1");
  });

  it("does not block a DIFFERENT key", async () => {
    const guard = createInFlightGuard();
    const gateA = deferred<string>();
    const gateB = deferred<string>();
    const actionA = jest.fn(() => gateA.promise);
    const actionB = jest.fn(() => gateB.promise);

    const a = guard("webinar:1", actionA);
    const b = guard("webinar:2", actionB);

    // The planner renders many rows. Blocking a different row's Join because
    // another is mid-flight would be a regression, not a fix.
    expect(actionA).toHaveBeenCalledTimes(1);
    expect(actionB).toHaveBeenCalledTimes(1);

    gateA.resolve("a");
    gateB.resolve("b");
    await Promise.all([a, b]);
  });

  it("releases the key after the action settles, so a retry works", async () => {
    const guard = createInFlightGuard();
    const action = jest.fn(async () => "ok");

    await guard("join:a", action);
    await guard("join:a", action);

    expect(action).toHaveBeenCalledTimes(2);
  });

  it("releases the key when the action THROWS", async () => {
    // The failure mode a naive guard has: leaving the key set on a throw turns
    // it into a permanent lock, so one failed join disables the button until
    // the component unmounts — worse than the race it prevents.
    const guard = createInFlightGuard();
    const failing = jest.fn(async () => {
      throw new Error("stream down");
    });

    await expect(guard("join:a", failing)).rejects.toThrow("stream down");

    const succeeding = jest.fn(async () => "ok");
    await expect(guard("join:a", succeeding)).resolves.toBe("ok");
    expect(succeeding).toHaveBeenCalledTimes(1);
  });
});
