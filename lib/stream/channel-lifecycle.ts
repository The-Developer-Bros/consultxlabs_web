/**
 * Chat-channel lifecycle constants shared by the writers that decide when a
 * channel's life stage changes.
 *
 * Lived in jobs/stream/expire-event-channels.ts until the 2026-08-23
 * architecture review (F-HIGH-2): the dashboard sync builds its membership
 * expected-set from the same age thresholds the expiry cron acts on, and
 * importing a constant from a job module into a server action would drag
 * dotenv/job wiring into the request path. The cron now imports from here and
 * re-exports under its original names so existing callers/tests are unchanged.
 */

/** Grace period between a session ending and its chat going read-only. */
export const FREEZE_AFTER_DAYS = 7;

/** Fallback when an appointment has no org (B2C), matching the schema default. */
export const DEFAULT_RETENTION_DAYS = 90;

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A channel whose latest slot ended at least `retentionDays` ago is PAST
 * RETENTION: the expire cron hard-deletes it (or already has). Such events
 * must never appear in the sync expected-set — Postgres rows outlive Stream
 * channels, so including them resurrects deleted channels with their full
 * historic roster (review F-HIGH-2), and because the freeze ledger was stamped
 * before deletion, the resurrected channel would never be re-frozen.
 */
export function isPastRetention(latestEndsAt: Date | null, retentionDays: number, now = Date.now()): boolean {
  if (!latestEndsAt) return false;
  return now - latestEndsAt.getTime() >= retentionDays * DAY_MS;
}
