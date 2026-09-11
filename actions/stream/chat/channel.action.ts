/**
 * Channel-creation primitives for Stream Chat (webinar/class/consultation/
 * subscription/collaborator channels).
 *
 * DELIBERATELY NOT a "use server" module (architecture review 2026-08-23,
 * F-HIGH-1). Marking this file "use server" turned every export into a
 * remotely invocable RPC endpoint with no session check, and Stream's
 * server-side API bypasses all permission checks ("server-side allows
 * everything so long as a valid API key and secret is provided") — so that
 * surface let any browser mint arbitrary channels/memberships or trigger a
 * full-database upsert+create storm billed to our MAU.
 *
 * All callers are server-side: API routes under app/api/stream and
 * app/api/bookings, lib/payments/webhooks/handlers.ts,
 * lib/collaborators/service.ts, and tests. This file must NEVER be re-marked
 * "use server". If a client ever needs one of these operations directly, put
 * an authenticated, session-checked API route (or a gated action in its own
 * "use server" file) in front of it.
 */

import { z } from "zod";
import prisma from "@/lib/prisma";
import { getStreamChatClient } from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";
import { markChannelExists } from "@/lib/stream-cache";
import { upsertUsersToStream } from "./user.action";
import {
  bookingOrgId,
  getDmChannelId,
  isChannelAlreadyExistsError,
} from "@/lib/stream-utils";
import { assertCanDirectMessage } from "@/lib/stream/dm-eligibility";
import { addRemainingMembers, createMemberChunk } from "@/lib/stream/batch";

// Input validation schemas
const channelTypeSchema = z.enum(["messaging", "team"]);
const channelIdSchema = z.string().min(1, "Channel ID is required");
const memberIdSchema = z.string().min(1, "Member ID is required");
const membersSchema = z
  .array(memberIdSchema)
  .min(1, "At least one member required");

const createChannelSchema = z.object({
  channelType: channelTypeSchema,
  channelId: channelIdSchema,
  channelName: z.string().optional(),
  members: membersSchema,
  createdById: memberIdSchema,
  additionalData: z.record(z.unknown()).optional(),
  // #B2 Stream.io org tagging — pre-launch enterprise tag so admins can later
  // query Stream API by `custom.organization_id`. Optional so personal
  // (non-org) channels keep their existing shape (no stray null field).
  organizationId: z.string().min(1).nullable().optional(),
});

/**
 * Best-effort channel-scoped `channel_moderator` grant (#899). Non-fatal: chat
 * still works without it. Shared by createChannel and the collaborator-channel
 * path so the grant contract lives in one place.
 */
async function grantChannelModerator(
  channel: ReturnType<ReturnType<typeof getStreamChatClient>["channel"]>,
  userId: string,
  channelId: string,
): Promise<void> {
  try {
    await channel.assignRoles([
      { user_id: userId, channel_role: "channel_moderator" },
    ]);
  } catch (error) {
    streamLogger.warn("Failed to grant channel_moderator to channel host", {
      channelId,
      userId,
      error,
    });
  }
}

/**
 * Generic function to create a channel
 * Validates inputs and handles member deduplication
 */
export async function createChannel(input: {
  channelType: "messaging" | "team";
  channelId: string;
  channelName?: string;
  members: string[];
  createdById: string;
  additionalData?: Record<string, unknown>;
  /**
   * Optional enterprise organization stamp. When non-null, written to the
   * channel's custom data as `organization_id` (snake_case per Stream's
   * convention) so org admins can list / query channels via Stream's
   * `queryChannels({filter: {organization_id: {$eq: orgId}}})`.
   * `null` / `undefined` → key omitted entirely so existing personal
   * channels created before this rollout don't gain a `null` field.
   */
  organizationId?: string | null;
}) {
  // Validate input
  const validated = createChannelSchema.parse(input);

  const client = getStreamChatClient();

  // Ensure creator is always included in members list
  const allMembers = Array.from(
    new Set([validated.createdById, ...validated.members]),
  );

  streamLogger.debug("Creating channel", {
    channelId: validated.channelId,
    type: validated.channelType,
    memberCount: allMembers.length,
    organizationId: validated.organizationId ?? undefined,
  });

  // Ensure all members exist in Stream before channel creation
  await upsertUsersToStream(allMembers);

  // Merge the optional org stamp into additionalData. Use snake_case
  // (`organization_id`) to match Stream's chat field convention and the
  // other event tags in this file (webinar_id, class_id).
  const mergedAdditionalData: Record<string, unknown> = {
    ...(validated.additionalData ?? {}),
    ...(validated.organizationId
      ? { organization_id: validated.organizationId }
      : {}),
  };

  // Create the channel with members atomically
  // Note: Explicitly typing channel data for stream-chat v9
  // #1270 — `create()` carries its roster in the request body and Stream caps
  // that at 100 members, the same ceiling `upsertUsersToStream` above already
  // respects. A 150-seat webinar therefore built a valid roster and then threw
  // it at Stream in one oversized call, which was rejected outright. The
  // creator is first in `allMembers` by construction, so they are always inside
  // this chunk; the rest are added below.
  const createChannelData = {
    name: validated.channelName,
    created_by_id: validated.createdById,
    members: createMemberChunk(allMembers),
    ...mergedAdditionalData,
  };
  const channel = client.channel(
    validated.channelType,
    validated.channelId,
    createChannelData as Record<string, unknown>,
  );

  // F-HIGH-3: two simultaneous first joins can both miss `addMembers` and
  // both reach this create(); the loser rejects with Stream's duplicate-create
  // error. ADOPT the winner's channel instead of failing the caller — from
  // the awaited payment-webhook path that used to fail a real attendee's
  // booking join outright.
  let channelData;
  try {
    channelData = await channel.create();
  } catch (error) {
    if (!isChannelAlreadyExistsError(error)) throw error;

    // Lost the race. The winner created the same channelId from the same
    // roster, so continue down the normal post-create path (moderator grant,
    // existence cache). The raw create response is dropped (`null`) — callers
    // consume channelId/members, never the payload.
    channelData = null;
    streamLogger.info("Lost channel-create race; adopting existing channel", {
      channelId: validated.channelId,
      type: validated.channelType,
    });
  }

  // #1270 — everyone the create() chunk could not carry, 100 at a time. Runs
  // on the adopted path too: the winner created the same channel from the same
  // roster, so the same remainder is owed either way and `addMembers` is
  // idempotent for anyone already in.
  await addRemainingMembers(channel, allMembers);

  // Channel-scoped moderation replaces the old global-admin Stream role
  // (#899). Only the channel HOST may moderate — never an arbitrary creator:
  //  - team channels (webinar/class): the creator IS the consultant host.
  //  - messaging channels: only consultation/subscription DMs carry a
  //    `dm_consultant_user_id`; grant moderation to that consultant. Peer DMs
  //    (createDirectMessageChannel) have no host, so `moderatorId` is
  //    undefined and no grant is issued — this prevents a consultee who
  //    opens a 1:1 DM from being able to mute/remove the consultant (#981).
  const moderatorId =
    validated.channelType === "team"
      ? validated.createdById
      : (mergedAdditionalData.dm_consultant_user_id as string | undefined);

  if (moderatorId) {
    await grantChannelModerator(channel, moderatorId, validated.channelId);
  }

  // Cache the channel existence
  markChannelExists(validated.channelType, validated.channelId);

  streamLogger.debug("Channel created successfully", {
    channelId: validated.channelId,
    memberCount: allMembers.length,
  });

  return {
    channelId: validated.channelId,
    members: allMembers,
    channelData,
  };
}

/**
 * Create a direct message channel between two users.
 *
 * The eligibility check is the point of this function now. It used to validate
 * two non-empty strings and nothing else — no session, no relationship query,
 * not even `a !== b` — and was safe only by accident, because every caller
 * happened to be a booking-approval or payment-success path where the link was
 * already established. That is an invariant held by convention across five call
 * sites in three files, which is not an invariant. It is enforced here so that
 * adding a sixth caller cannot quietly reopen the hole.
 *
 * Note this deliberately gates on the RELATIONSHIP, not on the caller's
 * session. Every legitimate caller is server-side and acts on behalf of the
 * system (a Razorpay webhook has no session at all), so a session check here
 * would break the create path while adding nothing — the user-initiated
 * surface is `POST /api/stream/channels/dm`, which does both.
 */
export async function createDirectMessageChannel(
  currentUserId: string,
  targetUserId: string,
  /**
   * Context this conversation belongs to. Omitted (or null) means personal —
   * the channel then lives in the B2C dashboards and carries no org tag. Pass
   * an org id to open the thread inside that organization instead; the two are
   * separate channels by design (see getDmChannelId).
   */
  organizationId?: string | null,
) {
  // Validate inputs
  memberIdSchema.parse(currentUserId);
  memberIdSchema.parse(targetUserId);

  await assertCanDirectMessage(currentUserId, targetUserId);

  const channelId = getDmChannelId(currentUserId, targetUserId, organizationId);

  return createChannel({
    channelType: "messaging",
    channelId,
    members: [currentUserId, targetUserId],
    createdById: currentUserId,
    organizationId,
  });
}

/**
 * Create a webinar channel with all participants
 * Members are everyone connected to the webinar's session slots
 *
 * @param webinarId — Webinar entity id
 * @param organizationId — Optional explicit org override. When omitted, the
 *   helper falls back to `webinarPlan.organizationId` so callers don't have
 *   to plumb it through. Pass `null` to force-omit the org tag.
 */
export async function createWebinarChannel(
  webinarId: string,
  organizationId?: string | null,
) {
  channelIdSchema.parse(webinarId);

  const webinar = await prisma.webinar.findUnique({
    where: { id: webinarId },
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

  if (!webinar) {
    throw new Error(`Webinar not found: ${webinarId}`);
  }

  const consultantUserId = webinar.webinarPlan.consultantProfile?.user?.id;
  if (!consultantUserId) {
    throw new Error(`Consultant not found for webinar: ${webinarId}`);
  }

  // Registrants are the users connected to the webinar's session slots.
  const appointmentIds =
    webinar.appointment?.slotsOfAppointment?.flatMap((slot) =>
      slot.user.map((u) => u.id),
    ) || [];

  const allParticipantIds = Array.from(new Set(appointmentIds));

  const allMembers = Array.from(
    new Set([consultantUserId, ...allParticipantIds]),
  );

  streamLogger.debug("Creating webinar channel", {
    webinarId,
    appointmentCount: appointmentIds.length,
    totalUnique: allMembers.length,
  });

  // Ensure all members exist in Stream before channel creation
  await upsertUsersToStream(allMembers);

  // Fall back to the plan's org if the caller didn't pass one explicitly.
  // `null` is treated as "explicitly no org"; `undefined` triggers fallback.
  const resolvedOrgId =
    organizationId === undefined
      ? (webinar.webinarPlan.organizationId ?? null)
      : organizationId;

  return createChannel({
    channelType: "team",
    channelId: `webinar-${webinarId}`,
    channelName: webinar.webinarPlan.title,
    members: allMembers,
    createdById: consultantUserId,
    additionalData: { webinar_id: webinarId },
    organizationId: resolvedOrgId,
  });
}

/**
 * Create a class channel with all participants
 *
 * @param classId — Class entity id
 * @param organizationId — Optional explicit org override. Falls back to
 *   `classPlan.organizationId` when omitted; `null` force-omits the tag.
 */
export async function createClassChannel(
  classId: string,
  organizationId?: string | null,
) {
  channelIdSchema.parse(classId);

  const classData = await prisma.class.findUnique({
    where: { id: classId },
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

  if (!classData) {
    throw new Error(`Class not found: ${classId}`);
  }

  const consultantUserId = classData.classPlan.consultantProfile?.user?.id;
  if (!consultantUserId) {
    throw new Error(`Consultant not found for class: ${classId}`);
  }

  const appointmentIds =
    classData.appointments?.flatMap((apt) =>
      apt.slotsOfAppointment?.flatMap((slot) => slot.user.map((u) => u.id)),
    ) || [];

  const allMembers = Array.from(new Set([consultantUserId, ...appointmentIds]));

  streamLogger.debug("Creating class channel", {
    classId,
    appointmentCount: appointmentIds.length,
    totalUnique: allMembers.length,
  });

  // Ensure all members exist in Stream before channel creation
  await upsertUsersToStream(allMembers);

  const resolvedOrgId =
    organizationId === undefined
      ? (classData.classPlan.organizationId ?? null)
      : organizationId;

  return createChannel({
    channelType: "team",
    channelId: `class-${classId}`,
    channelName: classData.classPlan.title,
    members: allMembers,
    createdById: consultantUserId,
    additionalData: { class_id: classId },
    organizationId: resolvedOrgId,
  });
}

/**
 * Create a consultation channel
 *
 * @param consultationId — Consultation entity id
 * @param organizationId — Optional explicit org override. When omitted, the
 *   resolved org tag falls back through this chain:
 *     1. `consultationPlan.organizationId` (plan is hosted by an org)
 *     2. `consultation.appointment.organizationId` (booking is funded by
 *        an org member, even when the plan itself is platform-owned)
 *     3. `null` — personal channel, no org tag
 *   Pass `null` explicitly to force-omit the org tag regardless of fallback.
 *
 *   Note: the underlying DM channel is per consultant-consultee pair, so an
 *   org tag here reflects the *first booking* — if the same pair later books
 *   a personal-plan consultation, the existing channel keeps the org tag.
 */
export async function createConsultationChannel(
  consultationId: string,
  organizationId?: string | null,
) {
  channelIdSchema.parse(consultationId);

  const consultation = await prisma.consultation.findUnique({
    where: { id: consultationId },
    include: {
      consultationPlan: {
        include: {
          consultantProfile: {
            include: { user: { select: { id: true } } },
          },
        },
      },
      requestedBy: {
        include: { user: { select: { id: true } } },
      },
      // Pull the appointment row so we can fall back to its org tag
      // when the plan itself isn't org-hosted but the booker is paying
      // through an org-funded membership (C.3 / #674).
      appointment: { select: { organizationId: true } },
    },
  });

  if (!consultation) {
    throw new Error(`Consultation not found: ${consultationId}`);
  }

  const consultantId = consultation.consultationPlan.consultantProfile.user.id;
  const consulteeId = consultation.requestedBy.user.id;

  // Legacy self-booked row (checkout blocks these now): getDmChannelId throws
  // on a self-pair, so skip rather than take the whole approval path down.
  // Same guard the search routes apply per row.
  if (consultantId === consulteeId) {
    streamLogger.warn("Skipping consultation channel — consultant and consultee are the same user", {
      consultationId,
    });
    return null;
  }

  if (!consultantId || !consulteeId) {
    throw new Error(
      `Participants not found for consultation: ${consultationId}`,
    );
  }

  // Ensure both users exist in Stream before channel creation
  await upsertUsersToStream([consultantId, consulteeId]);

  // `null` from the caller force-omits the org; `undefined` means "resolve it".
  const resolvedOrgId =
    organizationId === undefined ? bookingOrgId(consultation) : organizationId;

  // One DM per pair PER CONTEXT. Still not per event — multiple
  // consultations/subscriptions between the same pair in the same context share
  // one thread — but a personal booking and an org-funded one no longer collide
  // into a single channel that can only live in one dashboard (ADR 19).
  return createChannel({
    channelType: "messaging",
    channelId: getDmChannelId(consultantId, consulteeId, resolvedOrgId),
    members: [consultantId, consulteeId],
    createdById: consultantId,
    additionalData: {
      dm_consultant_user_id: consultantId,
      dm_consultee_user_id: consulteeId,
    },
    organizationId: resolvedOrgId,
  });
}

/**
 * Create a subscription channel
 *
 * @param subscriptionId — Subscription entity id
 * @param organizationId — Optional explicit org override. When omitted, the
 *   resolved org tag falls back through this chain:
 *     1. `subscriptionPlan.organizationId` (plan is hosted by an org)
 *     2. `subscription.appointment.organizationId` (booking is funded by
 *        an org member, even when the plan itself is platform-owned)
 *     3. `null` — personal channel, no org tag
 *   Pass `null` explicitly to force-omit. See `createConsultationChannel`
 *   for the DM-channel sharing caveat.
 */
export async function createSubscriptionChannel(
  subscriptionId: string,
  organizationId?: string | null,
) {
  channelIdSchema.parse(subscriptionId);

  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: {
      subscriptionPlan: {
        include: {
          consultantProfile: {
            include: { user: { select: { id: true } } },
          },
        },
      },
      requestedBy: {
        include: { user: { select: { id: true } } },
      },
      // Pull a single org-tagged appointment so we can fall back to
      // its org id when the plan itself isn't org-hosted but the
      // subscription is funded through an org-funded membership.
      // Subscription has a 1:N appointments relation; all appointments
      // in one subscription share the same org context (the org pays
      // for the whole subscription upfront) so taking the first is
      // sufficient. (C.3 / #674)
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
  });

  if (!subscription) {
    throw new Error(`Subscription not found: ${subscriptionId}`);
  }

  const consultantId = subscription.subscriptionPlan.consultantProfile.user.id;
  const consulteeId = subscription.requestedBy.user.id;

  // Same self-pair guard as the consultation path above.
  if (consultantId === consulteeId) {
    streamLogger.warn("Skipping subscription channel — consultant and consultee are the same user", {
      subscriptionId,
    });
    return null;
  }

  if (!consultantId || !consulteeId) {
    throw new Error(
      `Participants not found for subscription: ${subscriptionId}`,
    );
  }

  // Ensure both users exist in Stream before channel creation
  await upsertUsersToStream([consultantId, consulteeId]);

  // `null` from the caller force-omits the org; `undefined` means "resolve it".
  const resolvedOrgId =
    organizationId === undefined ? bookingOrgId(subscription) : organizationId;

  // One DM per pair PER CONTEXT. Still not per event — multiple
  // consultations/subscriptions between the same pair in the same context share
  // one thread — but a personal booking and an org-funded one no longer collide
  // into a single channel that can only live in one dashboard (ADR 19).
  return createChannel({
    channelType: "messaging",
    channelId: getDmChannelId(consultantId, consulteeId, resolvedOrgId),
    members: [consultantId, consulteeId],
    createdById: consultantId,
    additionalData: {
      dm_consultant_user_id: consultantId,
      dm_consultee_user_id: consulteeId,
    },
    organizationId: resolvedOrgId,
  });
}

/**
 * Create or reconcile a collaborator channel for a webinar or class plan.
 * Called when a collaborator accepts an invitation (idempotent).
 * Performs full member diffing: adds any DB collaborators missing from the channel
 * and removes any channel members no longer in the DB set (except host).
 * Members: host + all accepted collaborators.
 */
export async function createCollaboratorChannel(
  planType: "webinar" | "class",
  planId: string,
) {
  channelIdSchema.parse(planId);

  const collaboratorWhere = {
    status: "ACCEPTED" as const,
  };

  const collaboratorInclude = {
    consultantProfile: {
      include: { user: { select: { id: true } } },
    },
  };

  let title: string;
  let hostUserId: string | undefined;
  let collaboratorUserIds: string[];

  if (planType === "webinar") {
    const plan = await prisma.webinarPlan.findUnique({
      where: { id: planId },
      include: {
        consultantProfile: {
          include: { user: { select: { id: true } } },
        },
        collaborators: {
          where: collaboratorWhere,
          include: collaboratorInclude,
        },
      },
    });

    if (!plan) throw new Error(`Webinar plan not found: ${planId}`);
    title = plan.title;
    hostUserId = plan.consultantProfile?.user?.id;
    collaboratorUserIds = plan.collaborators
      .map((c) => c.consultantProfile.user.id)
      .filter(Boolean);
  } else {
    const plan = await prisma.classPlan.findUnique({
      where: { id: planId },
      include: {
        consultantProfile: {
          include: { user: { select: { id: true } } },
        },
        collaborators: {
          where: collaboratorWhere,
          include: collaboratorInclude,
        },
      },
    });

    if (!plan) throw new Error(`Class plan not found: ${planId}`);
    title = plan.title;
    hostUserId = plan.consultantProfile?.user?.id;
    collaboratorUserIds = plan.collaborators
      .map((c) => c.consultantProfile.user.id)
      .filter(Boolean);
  }

  if (!hostUserId) {
    throw new Error(`Host not found for ${planType} plan: ${planId}`);
  }

  // Deduplicated expected member set: host + all accepted collaborators
  const expectedMemberIds = Array.from(
    new Set([hostUserId, ...collaboratorUserIds]),
  );

  if (expectedMemberIds.length < 2) {
    streamLogger.debug("Skipping collaborator channel - not enough members", {
      planType,
      planId,
    });
    return null;
  }

  const channelId = `collab-${planType}-${planId}`;
  const client = getStreamChatClient();

  const channel = client.channel("messaging", channelId, {
    name: `${title} - Collaborators`,
    created_by_id: hostUserId,
    members: expectedMemberIds,
    [`${planType}_plan_id`]: planId,
    is_collaborator_channel: true,
  } as Record<string, unknown>);

  // Idempotent create — no-op if channel already exists
  await channel.create();
  markChannelExists("messaging", channelId);

  // Host moderates their own collab channel — this path bypasses
  // createChannel, so the #899 channel-scoped grant is repeated here.
  await grantChannelModerator(channel, hostUserId, channelId);

  // Query current channel membership for diffing
  const channelData = await channel.query();
  const currentMemberIds = (channelData.members ?? [])
    .map((m) => m.user_id)
    .filter((id): id is string => !!id);

  // Add members present in DB but missing from channel
  const toAdd = expectedMemberIds.filter(
    (id) => !currentMemberIds.includes(id),
  );
  if (toAdd.length > 0) {
    await channel.addMembers(toAdd);
    streamLogger.debug("Collaborator channel: added missing members", {
      channelId,
      added: toAdd,
    });
  }

  // Remove channel members no longer in the DB set
  const toRemove = currentMemberIds.filter(
    (id) => !expectedMemberIds.includes(id),
  );
  if (toRemove.length > 0) {
    await channel.removeMembers(toRemove);
    streamLogger.debug("Collaborator channel: removed departed members", {
      channelId,
      removed: toRemove,
    });
  }

  streamLogger.debug("Collaborator channel reconciled", {
    channelId,
    planType,
    planId,
    memberCount: expectedMemberIds.length,
    added: toAdd.length,
    removed: toRemove.length,
  });

  return {
    channelId,
    members: expectedMemberIds,
    channelData,
  };
}
