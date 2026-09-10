"use server";

/**
 * Client-callable channel membership mutation.
 *
 * Lives in its own `"use server"` file, deliberately separate from
 * `channel.action.ts`: that module lost its directive (architecture review
 * F-HIGH-1) so its exports can never be invoked from a browser, but THIS
 * operation is genuinely client-facing — `ChannelInfoAndManageDialog` calls it
 * to add members through the server-side authorization gate (#899) instead of
 * `channel.addMembers()` straight from the browser. A gated action in a
 * dedicated file is the sanctioned shape for that (see the header comment in
 * `channel.action.ts`).
 *
 * Stream's server-side API bypasses its permission system entirely, so the
 * authz gate lives here: ADMIN/STAFF may add to any channel; anyone else only
 * to a channel they created — mirroring the create-route checks.
 */
import { z } from "zod";
import { getStreamChatClient } from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import { getChannelTypeFromId, isDMChannel } from "@/lib/stream-channel-ids";
import * as Sentry from "@sentry/nextjs";

const channelIdSchema = z.string().min(1, "Channel ID is required");
const memberIdSchema = z.string().min(1, "Member ID is required");

export async function addMemberToChannel(
  channelId: string,
  userId: string,
  channelType?: "messaging" | "team",
) {
  channelIdSchema.parse(channelId);
  memberIdSchema.parse(userId);

  const session = await getSession(true);
  if (!session?.user?.id) {
    throw new Error("Unauthorized: sign in to manage channel members");
  }

  // DM membership is pair-derived (`getDmChannelId` + `canDirectMessage`).
  // Allowing a DM creator to name a third member here would bypass that
  // eligibility gate with server credentials — so direct-message channels are
  // out of scope for this action entirely.
  if (isDMChannel(channelId)) {
    throw new Error(
      "Forbidden: members cannot be added to direct messages",
    );
  }

  const client = getStreamChatClient();

  const resolvedChannelType = channelType ?? getChannelTypeFromId(channelId);

  streamLogger.debug("Adding member to channel", {
    channelId,
    userId,
    channelType: resolvedChannelType,
  });

  try {
    const channel = client.channel(resolvedChannelType, channelId);
    const privileged = isPrivileged(session.user.role);
    if (privileged) {
      await channel.create(); // Creates if doesn't exist, no-op if exists
    } else {
      const state = await channel.query({});
      const createdById = state.channel?.created_by?.id;
      if (createdById !== session.user.id) {
        throw new Error(
          "Forbidden: only the channel creator or staff may add members",
        );
      }
    }

    const response = await channel.addMembers([userId]);

    streamLogger.debug("Member added successfully", { channelId, userId });
    return { success: true, response };
  } catch (error) {
    streamLogger.error("Failed to add member to channel", error, {
      channelId,
      userId,
    });
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    throw error;
  }
}
