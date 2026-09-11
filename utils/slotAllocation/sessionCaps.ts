/**
 * Per-day session caps for the recurring event types — the ONE source both
 * the validator and the auto-allocator must read, so selection can never
 * produce a placement the validator then rejects (or stay more conservative
 * than the rules it feeds).
 *
 * These caps are keyed by the event's scheduling-timezone day (ADR B9) via
 * SlotCalculationService.dayKey — the same key on both sides.
 */

/** A subscription holds at most one session per day with a consultee. */
export const MAX_SUBSCRIPTION_SESSIONS_PER_DAY = 1;

/** A class may run at most two sessions in one day. */
export const MAX_CLASS_SESSIONS_PER_DAY = 2;

/** The per-day cap that applies to an event type. Consultations and webinars
 * are single-session events and never reach a per-day-cap check. */
export function maxSessionsPerDayFor(eventType: "subscription" | "class"): number {
  return eventType === "class"
    ? MAX_CLASS_SESSIONS_PER_DAY
    : MAX_SUBSCRIPTION_SESSIONS_PER_DAY;
}
