// The marked booking window.
//
// Cleanup cannot query the database and the checkout response carries neither
// an appointment id nor a payment id — only the gateway order id. So the run
// marks its own rows the one way it can: every consultation it books starts
// inside a single, declared window, and anything of the buyer pool's that
// starts inside that window belongs to this run.
//
// The atom is thirty minutes, which is the calendar's unit (ADR B1). A booking
// window that is not an exact multiple of it is read as one atom regardless of
// its stated end, so every window this module produces is exactly one atom.

import { WINDOW_ATOMS, WINDOW_START } from "./config.js";

export const ATOM_MS = 30 * 60 * 1000;

/**
 * Resolved once. Deriving "tomorrow" per call would move the window under a run
 * that crosses midnight UTC, and a window that moves between booking and
 * cleanup leaves production rows behind. This memo only covers one k6 process —
 * the storm, the integrity check and the cleanup are three of them — so the
 * workflow resolves WINDOW_START once and passes the same instant to all three.
 * A standalone run must set WINDOW_START explicitly for the same reason.
 */
let resolvedStartMs = null;

/** Start of the marked window as epoch milliseconds. */
export function windowStartMs() {
  if (resolvedStartMs !== null) return resolvedStartMs;
  if (WINDOW_START) {
    const parsed = Date.parse(WINDOW_START);
    if (Number.isNaN(parsed)) {
      throw new Error(`WINDOW_START is not a parseable date: ${WINDOW_START}`);
    }
    resolvedStartMs = parsed;
    return resolvedStartMs;
  }
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + 1);
  base.setUTCHours(4, 0, 0, 0); // 09:30 IST
  resolvedStartMs = base.getTime();
  return resolvedStartMs;
}

export function windowEndMs() {
  return windowStartMs() + WINDOW_ATOMS * ATOM_MS;
}

/** The nth atom of the window, as the pair checkout wants. */
export function atomAt(index) {
  const startsAt = new Date(
    windowStartMs() + (Math.abs(index) % WINDOW_ATOMS) * ATOM_MS,
  );
  const endsAt = new Date(startsAt.getTime() + ATOM_MS);
  return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
}

/** True when an ISO instant falls inside the marked window. */
export function isInWindow(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= windowStartMs() && t < windowEndMs();
}
