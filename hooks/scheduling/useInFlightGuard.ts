"use client";

import { useMemo } from "react";

/**
 * Run at most one instance of an async action at a time, keyed by a string.
 *
 * #1280 2.7 — every Join surface fires an async chain on click with nothing
 * stopping a second click entering it. `waitForGlobalVideoClient()` is awaited
 * first and can take a second or more on a cold provider, so the window is wide
 * enough to hit by accident, not just by trying.
 *
 * Two concurrent joins mint the call twice. Idempotent call ids and a `P2002`
 * catch bound most of the damage — except that `useLazyJoinMeeting`'s
 * `joinableSlot ?? appointment.slotsOfAppointment?.[0]` fallback is documented
 * as unsafe under exactly this race, because `slotsOfAppointment` arrives
 * unsorted. Two clicks can resolve two different anchor rows and put the two
 * sides of one booking in two different rooms — which is #1061, the bug that
 * started this whole train.
 *
 * ## Why a Set and not React state
 *
 * `ExitMeetingButton.tsx` already gets this right and its comment says why: a
 * `useState` flag is written asynchronously, so both handlers read the stale
 * `false` and sail past the guard. This writes synchronously, before the first
 * `await`, so the second click sees the first click's write. Copying that
 * rather than inventing a second mechanism.
 *
 * The key exists because the planner renders many rows: guarding "any join" and
 * guarding "this webinar's join" are different behaviours, and blocking a
 * different row's Join because another is mid-flight would be a regression.
 * Callers with a single action pass a constant.
 */
export type InFlightGuard = <T>(
  key: string,
  action: () => Promise<T>,
) => Promise<T | undefined>;

/**
 * The guard itself, with no React in it.
 *
 * Split out so the behaviour can be tested directly — this repo has no React
 * renderer in its dev dependencies, and a guard against a double-click is
 * exactly the thing that must not go untested.
 */
export function createInFlightGuard(): InFlightGuard {
  const inFlight = new Set<string>();

  return async function guarded<T>(
    key: string,
    action: () => Promise<T>,
  ): Promise<T | undefined> {
    // Synchronous check-and-set, before any await. This is the line that closes
    // the window; everything else is bookkeeping.
    if (inFlight.has(key)) return undefined;
    inFlight.add(key);
    try {
      return await action();
    } finally {
      // Cleared even on a throw. Leaving the key set would make the guard a
      // permanent lock, so one failed join would disable the button until the
      // component unmounted — worse than the race it prevents.
      inFlight.delete(key);
    }
  };
}

/**
 * React binding. One guard per component instance, stable across renders.
 *
 * Returns `undefined` when a call with this key was already running and this
 * one was dropped — deliberately not `false`, so a caller cannot confuse
 * "dropped as a duplicate" with "ran and reported failure". The two want
 * different UI.
 */
export function useInFlightGuard(): InFlightGuard {
  return useMemo(() => createInFlightGuard(), []);
}
