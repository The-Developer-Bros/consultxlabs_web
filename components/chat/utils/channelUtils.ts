import type { Channel } from "stream-chat";
import type { Scope } from "@/lib/api/scope/parse";
import { scopeOrgId } from "@/lib/api/scope/parse";

export interface ChannelDisplayInfo {
  displayName: string;
  displayImage?: string;
  isGroupDM: boolean;
  memberCount: number;
  statusText: string;
  fullGroupName?: string; // For tooltips
}

/**
 * Is this a direct message that actually has someone on the other end?
 *
 * A `messaging` channel with fewer than two members is a phantom. They exist
 * because `channel.watch()` posts to the same endpoint `channel.create()` does,
 * so watching a channel id that does not exist yet CREATES it — with the caller
 * as `created_by` and no members at all. Every client-side path that could do
 * that is now gone, and `ensure-chat-type-grants.ts` revokes `create-channel`
 * from the `user` role so Stream itself refuses, but neither of those helps with
 * the ones already sitting on the app: dev, preview and production share one
 * Stream app, and a phantom is a real channel that a real message can be posted
 * into. `scripts/stream/purge-memberless-dms.ts` deletes them; this keeps them
 * off the screen in the meantime, and keeps any future one unreachable rather
 * than merely mislabelled.
 *
 * Deliberately scoped to `messaging`. A `team` channel legitimately sits at one
 * member — a webinar channel is created with its host before anyone registers —
 * so applying this to events would hide real, working channels.
 */
/**
 * Does the viewer own this channel?
 *
 * Both sides must exist. `ownerId === viewerId` is `true` when BOTH are
 * `undefined`, and both are reachable: `created_by` is absent on a channel
 * whose creator metadata did not come back from the query, and `client.userID`
 * is absent for the moment before the client connects. Together they granted
 * ownership to whoever happened to be looking — which in
 * `ChannelInfoAndManageDialog` gated the remove-member control, and that one
 * mutates.
 *
 * Lives here rather than inline because the same comparison had already been
 * written twice in that file and got this wrong both times.
 */
export const viewerOwnsChannel = (
  ownerId: string | undefined | null,
  viewerId: string | undefined | null,
): boolean => Boolean(ownerId) && Boolean(viewerId) && ownerId === viewerId;

export const isUsableDmChannel = (channel: Channel): boolean => {
  if (channel.type !== "messaging") return true;
  return Object.keys(channel.state?.members ?? {}).length >= 2;
};

/**
 * Get consistent display information for any channel across all chat components
 */
export const getChannelDisplayInfo = (
  channel: Channel,
  currentUserId?: string,
): ChannelDisplayInfo => {
  const isTeamChannel = channel.type === "team";
  const isDirectMessage = channel.type === "messaging";

  if (isTeamChannel) {
    // Team channel logic
    const displayName = channel.data?.name || channel.id || "";
    const memberCount = Object.keys(channel.state.members || {}).length;

    return {
      displayName,
      displayImage: channel.data?.image as string,
      isGroupDM: false,
      memberCount,
      statusText: `${memberCount} ${memberCount === 1 ? "member" : "members"}`,
    };
  }

  if (isDirectMessage && currentUserId) {
    // Get all members except current user
    const otherMembers = Object.values(channel.state.members || {})
      .filter((member) => member.user?.id !== currentUserId)
      .map((member) => member.user)
      .filter(Boolean);

    const isGroupDM = otherMembers.length > 1;
    const memberCount = otherMembers.length;

    if (isGroupDM) {
      // Group DM logic
      const firstTwoNames = otherMembers
        .slice(0, 2)
        .map((user) => user?.name || user?.id || "Unknown")
        .join(", ");

      let displayName: string;
      let fullGroupName: string;

      if (otherMembers.length > 2) {
        displayName = `${firstTwoNames} +${otherMembers.length - 2} more`;
        fullGroupName = otherMembers
          .map((user) => user?.name || user?.id || "Unknown")
          .join(", ");
      } else {
        displayName = firstTwoNames;
        fullGroupName = firstTwoNames;
      }

      return {
        displayName,
        displayImage: (otherMembers[0]?.image as string) || undefined,
        isGroupDM: true,
        memberCount,
        statusText: `${memberCount} members`,
        fullGroupName,
      };
    } else if (otherMembers.length === 1) {
      // 1-on-1 DM logic
      const otherMember = otherMembers[0];

      return {
        displayName: otherMember?.name || otherMember?.id || "Unknown User",
        displayImage: (otherMember?.image as string) || undefined,
        isGroupDM: false,
        memberCount: 1,
        statusText: otherMember?.online ? "Online" : "Offline",
      };
    }
  }

  // Fallback: a messaging channel with no counterparty, or no `currentUserId`
  // yet because the client is still connecting.
  //
  // This branch used to end in `channel.id`, which is why a broken DM rendered
  // its raw `dm-<cuid>-<cuid>` key as the conversation title. A channel id is an
  // internal key — it is never a name, it leaks both participants' user ids into
  // the UI, and showing it made a real defect (a channel created with no
  // members, see lib/stream/dm-eligibility.ts) look like a formatting quirk.
  //
  // A one-member DM should not exist. If one is on screen, say so plainly
  // instead of dressing it up, and keep the id out of the title.
  const isOrphanedDm = isDirectMessage;

  return {
    displayName:
      (channel.data?.name as string | undefined) ||
      (isOrphanedDm ? "Unavailable conversation" : channel.id || "Unknown"),
    displayImage: undefined,
    isGroupDM: false,
    memberCount: 0,
    statusText: isOrphanedDm ? "No other participants" : "No members",
  };
};

/**
 * Get truncated display name for headers with character limit
 */
export const getTruncatedDisplayName = (
  displayInfo: ChannelDisplayInfo,
  maxLength: number = 30,
): string => {
  if (displayInfo.displayName.length <= maxLength) {
    return displayInfo.displayName;
  }

  if (displayInfo.isGroupDM) {
    // For group DMs, try to show at least first name + indicator
    const parts = displayInfo.displayName.split(", ");
    if (parts.length >= 2) {
      const firstName = parts[0];
      const remaining = displayInfo.memberCount - 1;
      const truncated = `${firstName} +${remaining} more`;

      if (truncated.length <= maxLength) {
        return truncated;
      }
    }
  }

  // Generic truncation
  return displayInfo.displayName.substring(0, maxLength - 3) + "...";
};

/**
 * The `?orgScope=` selection as a Stream channel filter. Stream channels
 * created by the enterprise wiring carry a `custom.organization_id`, and
 * without this a consultant in Acme + Zeta sees every chat cross-tenanted in
 * one inbox (#674). Lives here rather than inline in ChatSidebar so the
 * initial fetch and the load-more page share one definition and can never
 * disagree about which tenant is on screen.
 *
 * #674 B2B gap 9 — `orgMember` (what an active member below `operations.read`
 * resolves to) pins an org exactly as `org` does, so the question goes through
 * `scopeOrgId`. Branching on `kind === "org"` alone left that member
 * unfiltered: picking one org showed the whole cross-tenant inbox this filter
 * exists to prevent. Only `all` is genuinely unfiltered.
 */
export function buildOrgChannelFilter(scope: Scope): Record<string, unknown> {
  if (scope.kind === "personal") return { organization_id: { $exists: false } };
  const pinnedOrgId = scopeOrgId(scope);
  return pinnedOrgId ? { organization_id: { $eq: pinnedOrgId } } : {};
}
