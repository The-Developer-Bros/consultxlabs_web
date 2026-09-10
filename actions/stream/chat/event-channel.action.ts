"use server";

import * as Sentry from "@sentry/nextjs";
import type { StreamChat } from "stream-chat";
import { z } from "zod";
import prisma from "@/lib/prisma";
import {
  getStreamChatClient,
  withStreamCircuitBreaker,
  StreamUnavailableError,
} from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import {
  isChannelCached,
  markChannelExists,
  getMembershipCached,
  markMembership,
  initialSyncCompletedUsers,
  clearSyncCacheForUser,
} from "@/lib/stream-cache";
import { upsertUserToStream, upsertUsersToStream } from "./user.action";
import { MANAGED_CHANNEL_PREFIXES } from "@/lib/stream-channel-ids";
import {
  bookingOrgId,
  getDmChannelId,
  isChannelAlreadyExistsError,
} from "@/lib/stream-utils";
import { dmEligibleStatusFilter } from "@/lib/stream/dm-eligibility-statuses";
import {
  addRemainingMembers,
  createMemberChunk,
  queryChannelsPaged,
} from "@/lib/stream/batch";
import { ConsentRequiredError } from "@/lib/compliance/dpdp";
import {
  DEFAULT_RETENTION_DAYS,
  isPastRetention,
} from "@/lib/stream/channel-lifecycle";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";

// Validation schemas
const eventTypeSchema = z.enum([
  "webinar",
  "class",
  "consultation",
  "subscription",
]);
const eventIdSchema = z.string().min(1, "Event ID is required");
const userIdSchema = z.string().min(1, "User ID is required");

type EventType = z.infer<typeof eventTypeSchema>;

/**
 * Get the channel ID for an event
 */
function getChannelId(eventType: EventType, eventId: string): string {
  return `${eventType}-${eventId}`;
}

/**
 * Get the channel type for an event type
 */
function getChannelType(eventType: EventType): "messaging" | "team" {
  return eventType === "consultation" || eventType === "subscription"
    ? "messaging"
    : "team";
}

/**
 * Check if an event channel exists (with caching)
 */
export async function checkEventChannelExists(
  eventType: EventType,
  eventId: string,
): Promise<boolean> {
  eventTypeSchema.parse(eventType);
  eventIdSchema.parse(eventId);

  const channelId = getChannelId(eventType, eventId);
  const channelType = getChannelType(eventType);

  // Check cache first
  const cached = isChannelCached(channelType, channelId);
  if (cached !== undefined) {
    streamLogger.debug("Channel existence from cache", {
      channelId,
      exists: cached,
    });
    return cached;
  }

  const client = getStreamChatClient();

  try {
    const channel = client.channel(channelType, channelId);
    // #473 — fast-fail under a Stream outage instead of blocking the dashboard
    // for the full 30s timeout. Breaker-open degrades to "false" (same as a
    // query failure), so the caller treats the channel as not-yet-existing.
    await withStreamCircuitBreaker(
      () => channel.query({ state: false, messages: { limit: 0 } }),
      () => {
        throw new StreamUnavailableError();
      },
    );

    // Cache the result
    markChannelExists(channelType, channelId);
    streamLogger.debug("Channel exists", { channelId });
    return true;
  } catch (error) {
    // Channel doesn't exist if query fails (or Stream is unavailable)
    streamLogger.debug("Channel does not exist", { channelId });
    return false;
  }
}

/**
 * Upserts the user to Stream, treating a DPDP consent refusal as a skip.
 *
 * #1270 — a withdrawn or absent STREAM_DATA_PROCESSING consent is a deliberate
 * refusal, not a failure, but `addUserToEventChannel` let it bubble unhandled
 * out of a server action and took the WHOLE appointment page down rather than
 * just chat. `syncUserChannels` has degraded gracefully since #701; this path
 * never did. Extracted rather than inlined so the caller stays under the
 * cognitive-complexity budget.
 *
 * @returns false when consent is missing and the caller should skip.
 */
async function syncUserOrSkipOnConsent(
  userId: string,
  channelId: string,
): Promise<boolean> {
  try {
    await upsertUserToStream(userId);
    return true;
  } catch (err) {
    if (err instanceof ConsentRequiredError) {
      streamLogger.info(
        "Skipping event channel join — Stream consent not granted",
        { userId, channelId, purposeCode: err.purposeCode },
      );
      return false;
    }
    throw err;
  }
}

/**
 * Adds the user to a channel that is assumed to already exist.
 *
 * @returns false when the add failed in a way that suggests the channel is not
 * there yet, so the caller should create it. A Stream outage is rethrown rather
 * than reported as "missing", so we don't follow it with a pointless create
 * that fast-fails too (#473).
 */
async function tryAddToExistingChannel(
  channel: ReturnType<StreamChat["channel"]>,
  channelId: string,
  userId: string,
): Promise<boolean> {
  try {
    await withStreamCircuitBreaker(
      () => channel.addMembers([userId]),
      () => {
        throw new StreamUnavailableError();
      },
    );
    markMembership(channelId, userId, true);
    streamLogger.debug("Added user to existing channel", { channelId, userId });
    return true;
  } catch (addError) {
    if (addError instanceof StreamUnavailableError) throw addError;
    streamLogger.debug("Channel may not exist, attempting creation", {
      channelId,
    });
    return false;
  }
}

/**
 * Add a user to an event channel, creating the channel if it doesn't exist
 * Uses caching to avoid redundant operations
 */
export async function addUserToEventChannel(
  eventType: EventType,
  eventId: string,
  userId: string,
): Promise<{ success: boolean; channelId: string; created?: boolean }> {
  eventTypeSchema.parse(eventType);
  eventIdSchema.parse(eventId);
  userIdSchema.parse(userId);

  const channelId = getChannelId(eventType, eventId);
  const channelType = getChannelType(eventType);

  // Check membership cache first
  const membershipCached = getMembershipCached(channelId, userId);
  if (membershipCached === true) {
    streamLogger.debug("User already member (cached)", { channelId, userId });
    return { success: true, channelId };
  }

  const client = getStreamChatClient();

  // #1270 — a consent refusal must not take the page down with it.
  if (!(await syncUserOrSkipOnConsent(userId, channelId))) {
    return { success: false, channelId };
  }

  try {
    const channel = client.channel(channelType, channelId);

    // Try to add member directly (works for existing channels)
    if (await tryAddToExistingChannel(channel, channelId, userId)) {
      return { success: true, channelId };
    }

    // Channel doesn't exist, create it based on event type
    let created = false;
    const eventData = await getEventData(eventType, eventId);

    if (!eventData) {
      throw new Error(`${eventType} not found: ${eventId}`);
    }

    // Create channel with all data and members in a single atomic call
    // This fixes the "created_by_id must be provided" error and reduces 3 API calls to 1
    const { consultantId, members, name, organizationId } = eventData;
    // #1270 — host and joiner FIRST. `Webinar.maxParticipants` is unbounded and
    // only the first 100 members fit in the create() body, so ordering decides
    // who is guaranteed a seat in the atomic call and who arrives in a
    // follow-up request that can fail on its own. The person whose click
    // triggered this create is the one who must not be the casualty.
    const allMembers = Array.from(new Set([consultantId, userId, ...members]));

    // Ensure all members exist in Stream Chat before creating the channel
    // Without this, channel creation fails with "users don't exist" error
    await upsertUsersToStream(allMembers);

    // Re-initialize channel with all required data for atomic creation
    // Note: Explicitly typing channel data for stream-chat v9
    // #1280 PR 7 — tag the funding org AT SOURCE.
    //
    // Measured live on 2026-08-30: ZERO of 886 channels carried
    // `organization_id`, in any form. The org Messages tab and the
    // `/api/organizations/[orgId]/stream/channels` compliance route both filter
    // on it, so both returned empty for every organization — a compliance
    // export that silently reported "no channels" rather than failing.
    //
    // #746 §1 records per-org channel tagging as done. It is not, and this is
    // the path that made that false: `createChannel` tags on the eager path,
    // but this lazy create-on-miss is what actually mints most channels, and it
    // never carried the field.
    //
    // Spread rather than a null assignment: a literal `organization_id: null`
    // is a SET on Stream's side, and the reconciler's `$exists` filters treat a
    // present-but-null field differently from an absent one.
    const eventChannelData = {
      name,
      created_by_id: consultantId,
      [`${eventType}_id`]: eventId,
      ...(organizationId ? { organization_id: organizationId } : {}),
      members: createMemberChunk(allMembers),
    };
    const channelWithData = client.channel(
      channelType,
      channelId,
      eventChannelData as Record<string, unknown>,
    );

    // #473 — fast-fail channel creation under a Stream outage.
    // F-HIGH-3: a concurrent creator may win the race between our failed
    // addMembers above and this create(); on their duplicate-create rejection
    // we ADOPT the winner's channel instead of failing this user's join.
    let adoptRetryFailed = false;
    try {
      await withStreamCircuitBreaker(
        () => channelWithData.create(),
        () => {
          throw new StreamUnavailableError();
        },
      );
    } catch (createError) {
      if (!isChannelAlreadyExistsError(createError)) throw createError;

      streamLogger.info("Lost channel-create race; adopting existing channel", {
        channelId,
        userId,
      });

      // The winner's roster snapshot may predate us — retry our own membership
      // once. Best-effort: a failed retry is logged, never thrown, so the
      // join still resolves and the next sync reconciles if it truly missed.
      try {
        await channel.addMembers([userId]);
      } catch (adoptError) {
        adoptRetryFailed = true;
        streamLogger.warn("Post-adoption addMembers retry failed (non-fatal)", {
          channelId,
          userId,
          error: adoptError,
        });
      }
    }

    // #1270 — everyone past the create() chunk, 100 at a time. Runs after an
    // adopted race too: the winner created the same channel from the same
    // roster, so the same remainder is owed either way and `addMembers` is
    // idempotent for anyone already in.
    await addRemainingMembers(channelWithData, allMembers);

    // Lazy-create bypasses createChannel, so the #899 channel-scoped host
    // grant is repeated here. Non-fatal: chat still works without it.
    try {
      await channelWithData.assignRoles([
        { user_id: consultantId, channel_role: "channel_moderator" },
      ]);
    } catch (grantError) {
      streamLogger.warn("Failed to grant channel_moderator to event host", {
        channelId,
        consultantId,
        error: grantError,
      });
    }

    markChannelExists(channelType, channelId);
    // Cache membership only when it is actually ensured: after an adopted race
    // whose addMembers retry failed we leave it UNCACHED so the next sync (or
    // navigation) retries, instead of a cached "true" suppressing every future
    // attempt until the TTL lapses.
    if (!adoptRetryFailed) {
      markMembership(channelId, userId, true);
    }
    created = true;

    streamLogger.info("Created channel and added user", {
      channelId,
      userId,
      memberCount: allMembers.length,
    });

    return { success: true, channelId, created };
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Failed to add user to event channel", error, {
      eventType,
      eventId,
      userId,
    });
    throw error;
  }
}

/**
 * Remove a user from an event channel.
 * Used when a collaborator is removed from a webinar/class plan.
 */
export async function removeUserFromEventChannel(
  eventType: EventType,
  eventId: string,
  userId: string,
): Promise<{ success: boolean }> {
  eventTypeSchema.parse(eventType);
  eventIdSchema.parse(eventId);
  userIdSchema.parse(userId);

  const channelId = getChannelId(eventType, eventId);
  const channelType = getChannelType(eventType);

  const client = getStreamChatClient();

  try {
    const channel = client.channel(channelType, channelId);
    await channel.removeMembers([userId]);
    markMembership(channelId, userId, false);
    streamLogger.info("Removed user from event channel", {
      channelId,
      userId,
    });
    return { success: true };
  } catch (error) {
    // Clear membership cache regardless — if removal failed, we don't want
    // stale "is member" cache entries preventing future add/remove operations.
    markMembership(channelId, userId, false);
    // Channel may not exist — that's fine, user has no access anyway
    streamLogger.warn("Failed to remove user from event channel", {
      eventType,
      eventId,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { success: false };
  }
}

/**
 * Get event data for channel creation
 */
async function getEventData(eventType: EventType, eventId: string) {
  switch (eventType) {
    case "webinar": {
      const webinar = await prisma.webinar.findUnique({
        where: { id: eventId },
        include: {
          webinarPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { id: true } } },
              },
            },
          },
          appointment: {
            include: {
              slotsOfAppointment: {
                include: { user: { select: { id: true } } },
              },
            },
          },
        },
      });
      if (!webinar) return null;

      const consultantId = webinar.webinarPlan.consultantProfile?.user?.id;
      if (!consultantId) return null;

      const members =
        webinar.appointment?.slotsOfAppointment?.flatMap((s) =>
          s.user.map((u) => u.id),
        ) || [];

      // #1280 PR 7 — the funding org, resolved by the SAME `bookingOrgId`
      // precedence the DM path and the eligibility gate use: plan first, then
      // appointment. Carried out of here so the create() below can tag it.
      const organizationId = bookingOrgId({
        webinarPlan: webinar.webinarPlan,
        appointment: webinar.appointment,
      });

      return {
        consultantId,
        members,
        name: webinar.webinarPlan.title,
        organizationId,
      };
    }

    case "class": {
      const classData = await prisma.class.findUnique({
        where: { id: eventId },
        include: {
          classPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { id: true } } },
              },
            },
          },
          appointments: {
            include: {
              slotsOfAppointment: {
                include: { user: { select: { id: true } } },
              },
            },
          },
        },
      });
      if (!classData) return null;

      const consultantId = classData.classPlan.consultantProfile?.user?.id;
      if (!consultantId) return null;

      const members =
        classData.appointments?.flatMap(
          (a) =>
            a.slotsOfAppointment?.flatMap((s) => s.user.map((u) => u.id)) || [],
        ) || [];

      const organizationId = bookingOrgId({
        // A class is funded once but holds many appointments, so `bookingOrgId`
        // takes the first org-tagged one — the same `find`, not `[0]`, that the
        // DM path relies on for a subscription.
        classPlan: classData.classPlan,
        appointments: classData.appointments,
      });

      return {
        consultantId,
        members,
        name: classData.classPlan.title,
        organizationId,
      };
    }

    case "consultation": {
      const consultation = await prisma.consultation.findUnique({
        where: { id: eventId },
        include: {
          consultationPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { id: true } } },
              },
            },
          },
          requestedBy: { include: { user: { select: { id: true } } } },
          // #1280 PR 7 — the appointment is the second arm of `bookingOrgId`'s
          // precedence. Without it this branch could only ever see the plan's
          // org, so a personal plan booked under an organization would produce
          // an untagged channel while the DM-eligibility path, which does read
          // it, considered the pair org-scoped. These two arms are reachable
          // only from tests today (the open route restricts `eventType` to
          // webinar/class), but a resolver that disagrees with itself depending
          // on the caller is exactly what this change exists to remove.
          appointment: { select: { organizationId: true } },
        },
      });
      if (!consultation) return null;

      const consultantId =
        consultation.consultationPlan.consultantProfile?.user?.id;
      const consulteeId = consultation.requestedBy?.user?.id;
      if (!consultantId || !consulteeId) return null;

      return {
        consultantId,
        members: [consulteeId],
        name: consultation.consultationPlan.title,
        organizationId: bookingOrgId({
          consultationPlan: consultation.consultationPlan,
          appointment: consultation.appointment,
        }),
      };
    }

    case "subscription": {
      const subscription = await prisma.subscription.findUnique({
        where: { id: eventId },
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { id: true } } },
              },
            },
          },
          requestedBy: { include: { user: { select: { id: true } } } },
          // Plural here — a subscription holds many appointments and is funded
          // once, so `bookingOrgId` takes the first org-tagged one.
          appointments: { select: { organizationId: true } },
        },
      });
      if (!subscription) return null;

      const consultantId =
        subscription.subscriptionPlan.consultantProfile?.user?.id;
      const consulteeId = subscription.requestedBy?.user?.id;
      if (!consultantId || !consulteeId) return null;

      return {
        consultantId,
        members: [consulteeId],
        name: subscription.subscriptionPlan.title,
        organizationId: bookingOrgId({
          subscriptionPlan: subscription.subscriptionPlan,
          appointments: subscription.appointments,
        }),
      };
    }

    default:
      return null;
  }
}

/**
 * Sync user to all their event channels.
 * OPTIMIZED: Uses batch queries and parallel processing.
 * Runs once per user per server session, unless force=true.
 *
 * @param force - When true, bypass the session-level dedup guard and also
 *                remove the user from any Stream channels that are no longer
 *                backed by an active DB record (reconciliation cleanup).
 */
export async function syncUserEventChannels(
  userId: string,
  force = false,
): Promise<{
  success: boolean;
  skipped?: boolean;
  error?: string;
  channelsSynced?: number;
  failed?: number;
  staleChannelsRemoved?: number;
  durationMs?: number;
}> {
  userIdSchema.parse(userId);

  // F-HIGH-1 sibling: this module is "use server", so every export is
  // remotely invocable, and this sync drives unbounded metered Stream writes
  // keyed off an arbitrary userId. Mirror assertCanMintToken
  // (stream.action.ts): read the session with the cookie cache disabled so a
  // just-demoted staff/admin or a just-banned user cannot ride a stale
  // session, then allow self or privileged only. Legit callers always act as
  // themselves (the provider's fire-and-forget sync and
  // InitializeUserChannelsButton both pass the signed-in user's own id).
  const session = await getSession(true);
  if (!session?.user?.id) {
    throw new Error("Unauthorized: sign in to sync channels");
  }
  if (session.user.banned) {
    throw new Error("Forbidden: account suspended");
  }
  if (session.user.id !== userId && !isPrivileged(session.user.role)) {
    throw new Error("Forbidden: cannot sync channels for another user");
  }

  // Allow forced re-sync by clearing the session guard first
  if (force) {
    clearSyncCacheForUser(userId);
  }

  // Check if sync already completed for this user in this session
  if (initialSyncCompletedUsers.has(userId)) {
    streamLogger.debug("Sync already completed for user this session", {
      userId,
    });
    return { success: true, skipped: true };
  }

  streamLogger.info("Starting channel sync for user", { userId, force });
  const startTime = Date.now();

  try {
    // Upsert the user to Stream first. A DPDP consent gate (no/withdrawn
    // STREAM_DATA_PROCESSING consent) is a deliberate refusal, NOT a failure:
    // degrade gracefully by skipping the whole Stream sync rather than letting
    // it bubble as an unhandled error through the dashboard-load path. The gate
    // is unchanged — we simply don't crash the page for a non-consenting user.
    try {
      await upsertUserToStream(userId);
    } catch (err) {
      if (err instanceof ConsentRequiredError) {
        streamLogger.info(
          "Skipping channel sync — Stream consent not granted",
          {
            userId,
            purposeCode: err.purposeCode,
          },
        );
        // Mark sync "completed" for this session so we don't retry the gated
        // upsert on every navigation; a re-grant clears caches via the consent
        // flow and a forced re-sync re-attempts it.
        initialSyncCompletedUsers.add(userId);
        return { success: true, skipped: true };
      }
      throw err;
    }

    // Grab the Stream server client (needed for reconciliation query)
    const client = getStreamChatClient();

    // Get user's profile IDs
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        consultantProfileId: true,
        consulteeProfileId: true,
      },
    });

    if (!user) {
      streamLogger.warn("User not found for sync", { userId });
      return { success: false, error: "User not found" };
    }

    // Collect all event IDs the user should have access to (webinars + classes only)
    const eventIds: { type: EventType; id: string }[] = [];

    // Batch query all events in parallel
    const [webinars, classes, dmPairs] = await Promise.all([
      getWebinarIdsForUser(userId, user),
      getClassIdsForUser(userId, user),
      getDmPairsForUser(userId, user),
    ]);

    webinars.forEach((id) => eventIds.push({ type: "webinar", id }));
    classes.forEach((id) => eventIds.push({ type: "class", id }));

    streamLogger.debug("Events found for user", {
      userId,
      webinars: webinars.length,
      classes: classes.length,
      dmPairs: dmPairs.length,
      total: eventIds.length,
    });

    // Build the set of channel IDs this user is expected to be in
    const expectedChannelIds = new Set([
      ...eventIds.map(({ type, id }) => getChannelId(type, id)),
      ...dmPairs.map(({ consultantUserId, consulteeUserId, organizationId }) =>
        getDmChannelId(consultantUserId, consulteeUserId, organizationId),
      ),
    ]);

    // --- There is no longer an add pass. ---
    //
    // This used to walk `eventIds` and `dmPairs` five at a time, calling
    // `addUserToEventChannel` / `addUserToDmChannel` for every one, creating
    // any channel that did not exist yet. It ran on every cold dashboard load.
    //
    // Two things made that untenable. It is unbounded: neither
    // `getDmPairsForUser` nor the event helpers carry a `take`, and since
    // `DM_ELIGIBLE_STATUSES` includes `COMPLETED` — an absorbing state — the
    // pair list is every consultation the consultant has EVER finished, so it
    // only grows. A consultant with 500 completed bookings paid 100 serial
    // waves of Stream calls in the background of every load. And it is now
    // redundant: `POST /api/stream/channels/open` creates the channel on
    // demand, with both members, at the moment someone actually opens the
    // conversation. Provisioning 500 channels on the chance one gets opened is
    // work done for nothing.
    //
    // `expectedChannelIds` above is still computed — the reconcile pass below
    // needs it to decide what is stale, and that half is not replaceable by an
    // on-demand path: nothing else notices that a membership OUGHT to be
    // revoked.
    //
    // The trade, stated plainly: a user who has lost membership to a channel
    // that still exists is no longer silently re-added here. They recover by
    // opening the conversation from search, which routes through
    // `/api/stream/channels/open` and re-adds them. Booking approval and
    // payment success still provision channels eagerly, so this only affects
    // repair, not creation.
    const BATCH_SIZE = 5;

    // --- Reconciliation pass: remove user from stale channels ---
    //
    // #1270 — this walk used to ask for pages of 100 and stop as soon as a page
    // came back smaller than that. Stream never returns more than 30 rows from
    // `queryChannels`, so the very first page was "short", the loop ended, and
    // reconciliation only ever examined a user's first 30 memberships. Anything
    // past that — a DM revoked when a booking was cancelled, say, sitting at
    // position 41 — was never seen, never classified stale, and never removed.
    // That is the DM revocation leak. `queryChannelsPaged` pages at the real
    // cap and advances by the rows actually returned.
    //
    // Sorted by `created_at` ascending, not left unsorted. Offset paging is
    // only coherent over a stable order, and Stream's default sort is
    // `last_message_at` — which moves while we walk, so an active channel can
    // jump from page three to page one and push an unread one off the end.
    // A channel's creation time never changes.
    const { channels: streamChannels, truncated } = await queryChannelsPaged(
      (opts) =>
        // #473 — breaker-open returns [] so reconciliation simply skips the
        // stale-cleanup pass this run rather than blocking the sync on a dead
        // Stream backend.
        withStreamCircuitBreaker(
          () =>
            client.queryChannels(
              { members: { $in: [userId] } },
              { created_at: 1 },
              opts,
            ),
          () => [],
        ),
    );

    // Stream stops serving past offset 1000, so a user with more memberships
    // than that gets a partial reconcile. Under-revoking is the safe direction
    // — a channel we never looked at keeps its member, it does not lose one —
    // but it is a silent partial result, so say so rather than let the run
    // report a clean sweep it did not perform.
    if (truncated) {
      streamLogger.warn(
        "Reconciliation truncated at Stream's offset cap; some memberships were not examined",
        { userId, examined: streamChannels.length },
      );
    }

    // Only clean up channels with managed prefixes — preserve collab, support,
    // and manually-created channels that aren't part of the event/dm lifecycle.
    const staleChannels = streamChannels.filter(
      (ch) =>
        ch.id &&
        !expectedChannelIds.has(ch.id) &&
        MANAGED_CHANNEL_PREFIXES.some((prefix) => ch.id!.startsWith(prefix)),
    );

    let staleRemovedCount = 0;
    let staleFailCount = 0;

    if (staleChannels.length > 0) {
      streamLogger.info("Found stale channel memberships, cleaning up", {
        userId,
        staleCount: staleChannels.length,
        staleIds: staleChannels.map((ch) => ch.id),
      });

      for (let i = 0; i < staleChannels.length; i += BATCH_SIZE) {
        const batch = staleChannels.slice(i, i + BATCH_SIZE);

        const results = await Promise.allSettled(
          // Only remove this user's own membership — the channel is preserved for others
          batch.map((ch) => ch.removeMembers([userId])),
        );

        results.forEach((result) => {
          if (result.status === "fulfilled") staleRemovedCount++;
          else staleFailCount++;
        });
      }

      streamLogger.info("Stale channel cleanup completed", {
        userId,
        staleChannelsRemoved: staleRemovedCount,
        staleFailed: staleFailCount,
      });
    }

    const duration = Date.now() - startTime;
    streamLogger.info("Channel sync completed", {
      userId,
      expectedChannels: expectedChannelIds.size,
      staleChannelsRemoved: staleRemovedCount,
      staleFailed: staleFailCount,
      durationMs: duration,
    });

    // Mark sync as completed for this user (suppress future automatic re-runs)
    initialSyncCompletedUsers.add(userId);

    return {
      success: true,
      // Kept for the existing callers' shape. Nothing is "synced" in the
      // create sense any more; this is how many channels the user is expected
      // to be in, which is the useful number for the same debugging.
      channelsSynced: expectedChannelIds.size,
      failed: staleFailCount,
      staleChannelsRemoved: staleRemovedCount,
      durationMs: duration,
    };
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    streamLogger.error("Channel sync failed", error, { userId });
    throw error;
  }
}

/**
 * Get unique consultant-consultee DM pairs for a user, across consultations and subscriptions.
 */
/** A DM the user should be a member of, in one specific funding context. */
interface DmPair {
  consultantUserId: string;
  consulteeUserId: string;
  /** null = personal (B2C). Part of the channel key — see getDmChannelId. */
  organizationId: string | null;
}

async function getDmPairsForUser(
  userId: string,
  user: {
    consultantProfileId: string | null;
    consulteeProfileId: string | null;
  },
): Promise<DmPair[]> {
  // Keyed by channel id, so a pair working in two contexts yields two entries
  // rather than one overwriting the other.
  const pairMap = new Map<string, DmPair>();

  if (user.consultantProfileId) {
    const [consultations, subscriptions] = await Promise.all([
      prisma.consultation.findMany({
        where: {
          consultationPlan: { consultantProfileId: user.consultantProfileId },
          status: dmEligibleStatusFilter(),
        },
        include: {
          requestedBy: { include: { user: { select: { id: true } } } },
          // The DM channel key includes the funding context, so the reconcile
          // set has to know it too — otherwise it looks for a personal channel
          // that an org booking never created. Plan org FIRST, matching
          // createConsultationChannel's precedence exactly.
          consultationPlan: { select: { organizationId: true } },
          appointment: { select: { organizationId: true } },
        },
      }),
      prisma.subscription.findMany({
        where: {
          subscriptionPlan: { consultantProfileId: user.consultantProfileId },
          status: dmEligibleStatusFilter(),
        },
        include: {
          requestedBy: { include: { user: { select: { id: true } } } },
          subscriptionPlan: { select: { organizationId: true } },
          appointments: {
            where: { organizationId: { not: null } },
            select: { organizationId: true },
            // Deterministic, not just filtered: `take: 1` over an
            // unordered result can hand different callers different
            // rows if a subscription ever carries two org-tagged
            // appointments, which is the same divergence one layer down.
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: 1,
          },
        },
      }),
    ]);
    for (const c of [...consultations, ...subscriptions]) {
      const consulteeUserId = c.requestedBy?.user?.id;
      // Skip, do not throw. `getDmChannelId` rejects a self-pair, and this loop
      // runs un-isolated inside syncUserEventChannels — one dual-profile user
      // who self-booked would otherwise abort the entire reconcile for
      // themselves and leave every other channel unsynced. Checkout blocks
      // self-booking, so this only fires on legacy or seeded rows.
      if (!consulteeUserId || consulteeUserId === userId) continue;
      const organizationId = bookingOrgId(c);
      const channelId = getDmChannelId(userId, consulteeUserId, organizationId);
      pairMap.set(channelId, {
        consultantUserId: userId,
        consulteeUserId,
        organizationId,
      });
    }
  }

  if (user.consulteeProfileId) {
    const [consultations, subscriptions] = await Promise.all([
      prisma.consultation.findMany({
        where: {
          requestedById: user.consulteeProfileId,
          status: dmEligibleStatusFilter(),
        },
        include: {
          consultationPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { id: true } } },
              },
            },
          },
          appointment: { select: { organizationId: true } },
        },
      }),
      prisma.subscription.findMany({
        where: {
          requestedById: user.consulteeProfileId,
          status: dmEligibleStatusFilter(),
        },
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: { user: { select: { id: true } } },
              },
            },
          },
          appointments: {
            where: { organizationId: { not: null } },
            select: { organizationId: true },
            // Deterministic, not just filtered: `take: 1` over an
            // unordered result can hand different callers different
            // rows if a subscription ever carries two org-tagged
            // appointments, which is the same divergence one layer down.
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: 1,
          },
        },
      }),
    ]);
    for (const c of consultations) {
      const consultantUserId = c.consultationPlan?.consultantProfile?.user?.id;
      if (!consultantUserId || consultantUserId === userId) continue;
      const organizationId = bookingOrgId(c);
      const channelId = getDmChannelId(
        consultantUserId,
        userId,
        organizationId,
      );
      pairMap.set(channelId, {
        consultantUserId,
        consulteeUserId: userId,
        organizationId,
      });
    }
    for (const sub of subscriptions) {
      const consultantUserId =
        sub.subscriptionPlan?.consultantProfile?.user?.id;
      if (!consultantUserId || consultantUserId === userId) continue;
      const organizationId = bookingOrgId(sub);
      const channelId = getDmChannelId(
        consultantUserId,
        userId,
        organizationId,
      );
      pairMap.set(channelId, {
        consultantUserId,
        consulteeUserId: userId,
        organizationId,
      });
    }
  }

  return Array.from(pairMap.values());
}

/**
 * `addUserToDmChannel` used to live here — a private create-or-join for a
 * consultant/consultee pair, called only by the sync's DM add pass.
 *
 * Removed with that pass. It duplicated `createDirectMessageChannel` in
 * `channel.action.ts`, which is what `POST /api/stream/channels/open` and the
 * booking paths use, and which unlike this one runs the eligibility gate.
 * Leaving an ungated, unused channel-provisioning helper in the module is an
 * invitation to wire it back in without the check.
 */

/**
 * F-HIGH-2 — Postgres rows outlive Stream channels. The retention cron
 * hard-deletes a channel once `retentionDays` have passed since its last slot,
 * but the underlying Webinar/Class rows survive forever. Before this filter,
 * those dead rows kept appearing in the sync expected-set, so the next
 * dashboard sync re-created deleted channels with their full historic roster —
 * and because the freeze ledger was stamped BEFORE deletion, the resurrected
 * channel was classified as already-frozen and never frozen again: writable
 * forever, membership regrowing unbounded. Events past retention are excluded
 * here using the same window math as the cron, with the thresholds shared via
 * lib/stream/channel-lifecycle so the two sides cannot drift.
 */

/** The two inputs of one event's retention decision. */
interface RetentionWindow {
  /** Latest slot end across the event's sessions; null = no session yet. */
  endsAt: Date | null;
  /** Org dial when known (B2C bookings fall back to the schema default). */
  retentionDays: number;
}

/** Structural shape of one event's retention-relevant appointment data. */
interface AppointmentWindow {
  organization: { streamRecordingRetentionDays: number | null } | null;
  slotsOfAppointment: { endsAt: Date }[];
}

function isPastRetentionWindow(window: RetentionWindow): boolean {
  // Callers always resolve the org dial against the schema default already.
  return isPastRetention(window.endsAt, window.retentionDays);
}

/** Webinar has AT MOST one appointment (singular relation). */
function webinarRetentionWindow(
  appointment: AppointmentWindow | null,
): RetentionWindow {
  if (!appointment) {
    // No session yet — the cron can't have expired something that never ran.
    return { endsAt: null, retentionDays: DEFAULT_RETENTION_DAYS };
  }
  const endsAt = appointment.slotsOfAppointment.reduce<Date | null>(
    (max, s) => (!max || s.endsAt > max ? s.endsAt : max),
    null,
  );
  return {
    endsAt,
    retentionDays:
      appointment.organization?.streamRecordingRetentionDays ??
      DEFAULT_RETENTION_DAYS,
  };
}

/**
 * A class spans many appointments (one per attendee cohort) but ONE channel;
 * collapse to the latest end across all of them, carrying THAT cohort's org
 * dial — the same collapse rule the expire cron applies per channel.
 */
function latestClassRetentionWindow(
  appointments: AppointmentWindow[] | undefined,
): RetentionWindow {
  // Undefined/empty = no session info — treat as live; the retention cron
  // can never have expired an event it has no slot evidence for.
  if (!appointments || appointments.length === 0) {
    return { endsAt: null, retentionDays: DEFAULT_RETENTION_DAYS };
  }
  return appointments.reduce<RetentionWindow>(
    (latest, apt) => {
      const aptLatest = apt.slotsOfAppointment.reduce<Date | null>(
        (max, s) => (!max || s.endsAt > max ? s.endsAt : max),
        null,
      );
      if (!aptLatest) return latest;
      if (!latest.endsAt || aptLatest > latest.endsAt) {
        return {
          endsAt: aptLatest,
          retentionDays:
            apt.organization?.streamRecordingRetentionDays ??
            DEFAULT_RETENTION_DAYS,
        };
      }
      return latest;
    },
    { endsAt: null, retentionDays: DEFAULT_RETENTION_DAYS },
  );
}

/** Dedupe ids and drop any whose channel is past retention (F-HIGH-2). */
function dedupeLive<T extends { id: string }>(
  rowGroups: T[][],
  windowOf: (row: T) => RetentionWindow,
): string[] {
  const seen = new Set<string>();
  const liveIds: string[] = [];
  for (const row of rowGroups.flat()) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (!isPastRetentionWindow(windowOf(row))) liveIds.push(row.id);
  }
  return liveIds;
}

/**
 * Get webinar IDs for a user (both hosted and enrolled).
 * Handles dual-role users who are both consultant and consultee.
 */
async function getWebinarIdsForUser(
  userId: string,
  user: {
    consultantProfileId: string | null;
    consulteeProfileId: string | null;
  },
): Promise<string[]> {
  const queries: Promise<
    { id: string; appointment: AppointmentWindow | null }[]
  >[] = [];

  // Consultant: get webinars they host
  if (user.consultantProfileId) {
    queries.push(
      prisma.webinar.findMany({
        where: {
          webinarPlan: { consultantProfileId: user.consultantProfileId },
        },
        select: {
          id: true,
          appointment: {
            select: {
              organization: {
                select: { streamRecordingRetentionDays: true },
              },
              slotsOfAppointment: {
                orderBy: { endsAt: "desc" },
                take: 1,
                select: { endsAt: true },
              },
            },
          },
        },
      }),
    );
  }

  // Consultee: get webinars they registered for
  queries.push(
    prisma.webinar.findMany({
      where: {
        appointment: {
          slotsOfAppointment: { some: { user: { some: { id: userId } } } },
        },
      },
      select: {
        id: true,
        appointment: {
          select: {
            organization: { select: { streamRecordingRetentionDays: true } },
            slotsOfAppointment: {
              orderBy: { endsAt: "desc" },
              take: 1,
              select: { endsAt: true },
            },
          },
        },
      },
    }),
  );

  const results = await Promise.all(queries);
  return dedupeLive(results, (row) => webinarRetentionWindow(row.appointment));
}

/**
 * Get class IDs for a user (both hosted and enrolled).
 * Handles dual-role users who are both consultant and consultee.
 */
async function getClassIdsForUser(
  userId: string,
  user: {
    consultantProfileId: string | null;
    consulteeProfileId: string | null;
  },
): Promise<string[]> {
  const queries: Promise<
    { id: string; appointments: AppointmentWindow[] }[]
  >[] = [];

  // Consultant: get classes they host
  if (user.consultantProfileId) {
    queries.push(
      prisma.class.findMany({
        where: {
          classPlan: { consultantProfileId: user.consultantProfileId },
        },
        select: {
          id: true,
          appointments: {
            select: {
              organization: {
                select: { streamRecordingRetentionDays: true },
              },
              slotsOfAppointment: {
                orderBy: { endsAt: "desc" },
                take: 1,
                select: { endsAt: true },
              },
            },
          },
        },
      }),
    );
  }

  // Consultee: get classes they enrolled in
  queries.push(
    prisma.class.findMany({
      where: {
        appointments: {
          some: {
            slotsOfAppointment: { some: { user: { some: { id: userId } } } },
          },
        },
      },
      select: {
        id: true,
        appointments: {
          select: {
            organization: { select: { streamRecordingRetentionDays: true } },
            slotsOfAppointment: {
              orderBy: { endsAt: "desc" },
              take: 1,
              select: { endsAt: true },
            },
          },
        },
      },
    }),
  );

  const results = await Promise.all(queries);
  return dedupeLive(results, (row) =>
    latestClassRetentionWindow(row.appointments),
  );
}
