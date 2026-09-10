/**
 * Canonical comparison of two reads of the same Stream configuration document.
 *
 * Three scripts write config to Stream and each has to answer the same
 * question afterwards: did this write change something it was not given?
 * `updateCallType` and `updateApp` both take partials, neither documents
 * whether the omitted fields survive, and the chat twin `channel.update()` is a
 * full replace — so each one snapshots, writes, re-reads and compares.
 *
 * That comparison lived in three places. `ensure-call-type-grants.ts` and
 * `ensure-call-type-settings.ts` had two implementations of the same idea, and
 * `ensure-app-settings.ts` made a third. They must agree: this is the check that
 * decides whether an operator is told their webhook subscription was just
 * destroyed, and three copies of it is three chances for one to drift into a
 * false negative on the run where it matters.
 */

/**
 * Code-unit ordering, never `localeCompare`.
 *
 * The same rule as the channel ids, for the same reason: ICU collation is
 * locale- and environment-dependent, so a comparison built on it can answer
 * differently in CI and on a laptop. Here that would mean an identical config
 * reporting as drift — telling an operator, mid-incident, that Stream had
 * discarded settings it never touched.
 */
export function byCodeUnit(
  [a]: [string, unknown],
  [b]: [string, unknown],
): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Server-managed metadata that Stream re-stamps on any write to the document
 * that contains it, whether or not the field itself was touched.
 *
 * `updateApp` bumps `event_hooks[].updated_at` even for a write that names only
 * `moderation_enabled`, so fingerprinting it reports the webhook subscription as
 * destroyed on every single run. `created_at` is stable and stays in — a change
 * there really would mean the object was replaced.
 */
const SERVER_STAMPED_KEYS = new Set(["updated_at"]);

/**
 * Order-insensitive, metadata-free view of a config document.
 *
 * Arrays are sorted by their own serialised form because Stream returns
 * `geofences` in a different order on consecutive reads of an unchanged app.
 * Nothing in these documents is positional — grants, event types and geofences
 * are all sets — so ordering carries no meaning to lose. If a positional array
 * is ever fingerprinted, this masks a reordering and needs revisiting.
 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(normalize)
      .toSorted((a, b) =>
        byCodeUnit([JSON.stringify(a), null], [JSON.stringify(b), null]),
      );
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SERVER_STAMPED_KEYS.has(key))
      .map(([key, val]) => [key, normalize(val)] as [string, unknown])
      .toSorted(byCodeUnit),
  );
}

/**
 * Stable stringify, so two independent reads of an UNCHANGED document compare
 * equal.
 *
 * Plain `JSON.stringify` preserves key insertion order, and the two snapshots
 * come from two separate HTTP responses. Nothing guarantees those arrive in the
 * same order, so without this a false positive is a matter of luck.
 *
 * The false positive is not hypothetical: it fired on the 2026-09-01 rollout and
 * told the operator the webhook pipeline was down when the hook was untouched.
 * A drift check that cries wolf every run is a drift check nobody reads.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(normalize(value));
}

/**
 * Which of `fields` differ between two reads.
 *
 * Returns names rather than a boolean because the names are the actionable
 * part: "event_hooks changed" tells an operator the webhook pipeline is down,
 * where "something changed" tells them to go looking.
 */
export function diffFingerprints(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  return Object.keys(before).filter((key) => before[key] !== after[key]);
}
