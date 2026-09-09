/**
 * Shared Stream channel ID conventions and utilities.
 * All channel ID pattern detection should go through these helpers
 * to avoid scattered .startsWith()/.includes() checks.
 */

// Channel ID prefixes
export const DM_PREFIX = "dm-";
/**
 * Org-scoped and overflow DM forms, both minted by `getDmChannelId`.
 *
 * These are NOT covered by `DM_PREFIX`: `"dmo-".startsWith("dm-")` is false, so
 * before they were declared here `getChannelTypeFromId` resolved every
 * org-context DM as `team` — a channel created as `messaging` — and
 * `MANAGED_CHANNEL_PREFIXES` skipped them entirely, so the reconciler never
 * touched them. Any new DM shape must be added here as well as in
 * `lib/stream-utils.ts`, or it silently falls into the `team` arm below.
 */
export const DM_ORG_PREFIX = "dmo-";
export const DM_HASHED_PREFIX = "dmh-";
export const WEBINAR_PREFIX = "webinar-";
export const CLASS_PREFIX = "class-";
export const COLLAB_PREFIX = "collab-";
/**
 * Legacy only. #1134 P0-7 — nothing creates these any more.
 *
 * They were minted at payment and on approval, but `syncUserEventChannels` built
 * its expected set from webinars, classes and DMs alone while treating both
 * prefixes as MANAGED — so every one of them was classified stale and the buyer
 * was removed from it on their very next dashboard load. The concept never even
 * cohered internally: `createConsultationChannel` minted a DM, not a
 * `consultation-` channel. A pair now has exactly one thread per org context.
 *
 * The constants stay so `getChannelTypeFromId` can still resolve rows created
 * before the change; they are deliberately NOT in MANAGED_CHANNEL_PREFIXES, so
 * surviving channels are left alone rather than swept.
 */
export const CONSULTATION_PREFIX = "consultation-";
export const SUBSCRIPTION_PREFIX = "subscription-";

/**
 * Legacy UNDERSCORE event ids — `webinar_…` / `class_…`, 351 of them live.
 *
 * Found 2026-08-30 and in no prior audit. Nothing has minted these for months;
 * everything now uses the hyphen forms above. They matter because they are
 * invisible to every mechanism that manages a channel: `isEventChannel` misses
 * them, so nothing freezes or expires them, and `getChannelTypeFromId` only
 * resolved them by falling through to its `team` fallback — the right answer
 * reached by accident, which is the same accident that had `dmo-` addressing
 * the wrong channel type for months.
 *
 * ## Deliberately NOT in MANAGED_CHANNEL_PREFIXES
 *
 * Adding them there is the obvious move and it would be a serious bug. That
 * list makes the reconciler REMOVE a user from any channel carrying the prefix
 * that is absent from the expected set — and the expected set is built by
 * `getWebinarIdsForUser` / `getClassIdsForUser`, which emit `webinar-<id>`,
 * never `webinar_<id>`. Every one of the 351 would be classified stale on the
 * owner's next dashboard load and its members removed. That is #1134 P0-7
 * exactly, which is the bug the comment on that list exists to prevent.
 *
 * They are swept by `scripts/stream/sweep-legacy-underscore-channels.ts`
 * instead: a one-off, dry-run by default, with a human reading the list.
 */
export const LEGACY_WEBINAR_PREFIX = "webinar_";
export const LEGACY_CLASS_PREFIX = "class_";
export const LEGACY_EVENT_PREFIXES = [
  LEGACY_WEBINAR_PREFIX,
  LEGACY_CLASS_PREFIX,
] as const;

/** True for the legacy underscore event ids described above. */
export function isLegacyEventChannel(channelId: string | undefined): boolean {
  if (!channelId) return false;
  return LEGACY_EVENT_PREFIXES.some((prefix) => channelId.startsWith(prefix));
}

/**
 * Prefixes managed by syncUserEventChannels for reconciliation.
 *
 * Adding a prefix here makes the reconciler REMOVE the user from any channel
 * carrying it that is absent from `expectedChannelIds`. So a prefix only
 * belongs here once `getDmPairsForUser` / `getWebinarIdsForUser` /
 * `getClassIdsForUser` are guaranteed to produce every legitimate id under it —
 * otherwise the sweep deletes live conversations, which is #1134 P0-7 all over
 * again. `dmo-`/`dmh-` are safe here because `getDmPairsForUser` derives its
 * ids through the same `getDmChannelId` helper that mints them, over the same
 * `DM_ELIGIBLE_STATUSES` set the eligibility gate uses.
 */
export const MANAGED_CHANNEL_PREFIXES = [
  WEBINAR_PREFIX,
  CLASS_PREFIX,
  DM_PREFIX,
  DM_ORG_PREFIX,
  DM_HASHED_PREFIX,
] as const;

/** Check if channel is a webinar or class event channel (group/team) */
export function isEventChannel(channelId: string | undefined): boolean {
  if (!channelId) return false;
  return (
    channelId.startsWith(WEBINAR_PREFIX) || channelId.startsWith(CLASS_PREFIX)
  );
}

/** Check if channel is a direct message, in any of its three id forms */
export function isDMChannel(channelId: string | undefined): boolean {
  if (!channelId) return false;
  return (
    channelId.startsWith(DM_PREFIX) ||
    channelId.startsWith(DM_ORG_PREFIX) ||
    channelId.startsWith(DM_HASHED_PREFIX)
  );
}

/** Check if channel is a collaborator channel */
export function isCollaboratorChannel(channelId: string | undefined): boolean {
  if (!channelId) return false;
  return channelId.startsWith(COLLAB_PREFIX);
}

/**
 * Infer Stream channel type from channel ID prefix.
 * DM (all three forms), collaborator, consultation, and subscription channels
 * use "messaging". Event channels (webinar, class) use "team".
 *
 * The `team` return is a FALLBACK, not a match — an unrecognised prefix lands
 * there. That is why `dmo-` resolved as `team` for as long as it went
 * undeclared: nothing errors, the wrong type is simply handed to
 * `client.channel(type, id)`, which then addresses a channel that does not
 * exist and 404s or creates a second one.
 */
export function getChannelTypeFromId(channelId: string): "messaging" | "team" {
  if (
    isDMChannel(channelId) ||
    channelId.startsWith(COLLAB_PREFIX) ||
    channelId.startsWith(CONSULTATION_PREFIX) ||
    channelId.startsWith(SUBSCRIPTION_PREFIX)
  ) {
    return "messaging";
  }
  // Everything else is `team`, INCLUDING the legacy underscore event ids —
  // which is the right answer for them, reached by the fallback rather than by
  // a match. That is worth knowing rather than relying on: the same fallback
  // returning a plausible answer is how `dmo-` addressed the wrong channel type
  // for months. `isLegacyEventChannel` is what to reach for when the
  // distinction matters.
  return "team";
}
