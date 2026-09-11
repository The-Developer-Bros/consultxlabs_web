/**
 * Decide whether an inbound URL query change should skip filter rehydration
 * because it is the echo of our own `history.replaceState`.
 *
 * A boolean flag is unsafe: an external navigation can arrive while the flag
 * is set and consume it, leaving filters stale. Matching the exact query we
 * wrote avoids that race.
 */
export function shouldSkipUrlHydrate(
  pendingWrittenQs: string | null,
  incomingQs: string,
): { skip: boolean; nextPending: string | null } {
  if (pendingWrittenQs === null) {
    return { skip: false, nextPending: null };
  }
  if (pendingWrittenQs === incomingQs) {
    return { skip: true, nextPending: null };
  }
  // External URL while a self-write was pending — hydrate, drop stale pending.
  return { skip: false, nextPending: null };
}
