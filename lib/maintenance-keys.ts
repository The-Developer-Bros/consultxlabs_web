// Single source of truth for the maintenance Redis keys, shared by the edge
// reader (lib/maintenance-edge.ts) and the Node writer (lib/maintenance.ts) so
// the schema can't drift between them. Platform-scoped; no per-org keys (#776).
// Plain constants only — kept edge-safe (no Node/Prisma imports).
export const REDIS_KEYS = {
  PHASE: "maintenance:phase",
  CONFIG: "maintenance:config",
  /**
   * #1146 — the exact set of chat channels THIS maintenance window froze.
   *
   * The unfreeze used to re-derive the set by querying `MeetingSession` rows
   * stamped `endedReason: "maintenance"` inside a six-hour window. That was
   * approximate in three ways, and Stream grants `use-frozen-channel` to no
   * role, so a channel that stays frozen is unwritable by every user AND every
   * admin with no visible cause:
   *
   *   - a maintenance window longer than six hours matched nothing;
   *   - the query took 200 rows with no `orderBy`, so two transitions in one
   *     afternoon left an arbitrary remainder frozen;
   *   - a session whose `call.end()` failed was frozen but never stamped, so it
   *     could not be found at all — and `call.end()` failing means a Stream
   *     outage or an open breaker, which is exactly when maintenance runs.
   *
   * Recording what was actually frozen makes the reversal exact. Redis rather
   * than a column because the maintenance state already lives here and this is
   * window-scoped, not per-session; the heuristic is kept as a fallback for the
   * case where Redis lost the key, since never unfreezing is far worse than
   * unfreezing approximately.
   */
  FROZEN_CHANNELS: "maintenance:frozen-channels",
  /**
   * Set when a freeze recorded some channels and then failed to record others.
   *
   * The ledger is written incrementally, so non-empty does not mean complete.
   * Without this marker the unfreeze would reverse the recorded batch, skip the
   * derived fallback because the ledger "looked fine", and leave the unrecorded
   * batch frozen permanently.
   */
  FROZEN_LEDGER_INCOMPLETE: "maintenance:frozen-ledger-incomplete",
} as const;
