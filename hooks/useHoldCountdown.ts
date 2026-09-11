"use client";

import { useEffect, useState } from "react";

export interface HoldCountdown {
  /** Whole minutes remaining, floored; 0 once inside the final minute. */
  minutesLeft: number;
  /** True once `now` has passed `deadline`. */
  isExpired: boolean;
}

/**
 * Live minutes-remaining countdown against a tentative-hold deadline
 * (Payment.expiresAt). Shared by SessionTimeline's held row and any other
 * surface that needs to say "this reservation releases at <time>" — one
 * ticking clock instead of each caller re-deriving `now` on its own timer.
 *
 * Before the deadline: minutesLeft counts down, isExpired is false.
 * After the deadline: minutesLeft clamps to 0, isExpired flips true and the
 * interval stops (nothing left to tick towards).
 */
export function useHoldCountdown(deadline: Date | null): HoldCountdown {
  const [now, setNow] = useState(() => Date.now());
  const target = deadline ? deadline.getTime() : null;
  const isExpired = target === null || now >= target;

  useEffect(() => {
    if (target === null || Date.now() >= target) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [target]);

  const minutesLeft =
    // Floor, not ceil: this clock sits on a payment deadline, so rounding UP
    // would promise time the hold does not have ("2m left" at 61s remaining).
    // 0 therefore means "inside the final minute", which the badge words.
    target === null ? 0 : Math.max(0, Math.floor((target - now) / 60_000));

  return { minutesLeft, isExpired };
}
