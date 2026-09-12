import * as Sentry from "@sentry/nextjs";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import prisma, { type PrismaLike, type Tx } from "@/lib/prisma";
import { Prisma, type CollaboratorRole } from "@prisma/client";
import type { Collaborator, CollaboratorStatus } from "@prisma/client";
import { removeUserFromEventChannel } from "@/actions/stream/chat/event-channel.action";
import { getStreamChatClient } from "@/lib/stream-client";
import type { RevenueSplit } from "@/types/collaborators";
import {
  WEBINAR_COLLABORATOR_ROLES,
  CLASS_COLLABORATOR_ROLES,
} from "@/schemas/collaborators";
import {
  notifyCollaboratorInvited,
  notifyCollaboratorAccepted,
  notifyCollaboratorRemoved,
} from "@/lib/novu/service";
import { getAppUrl } from "@/lib/url";
import { scopeToWhereOrgId, type Scope } from "@/lib/api/scope/parse";
import { reportSentryError } from "@/lib/observability/report";

// The flip a ban and an erasure share lives in its own module so the
// moderation transaction does not load this module's Stream and Novu graph.
export {
  removeCollaboratorStanding,
  type CollaborationRef,
} from "@/lib/collaborators/standing";

type PlanType = "webinar" | "class";

const MIN_HOST_SHARE = 10; // Host must keep at least 10%

// #1580 §6 — at most three collaborators in PENDING + ACCEPTED per plan, and
// only one of them a co-presenter; the host stays the accountable party.
export const MAX_COLLABORATORS_PER_PLAN = 3;
export const PRESENTER_ROLES: readonly CollaboratorRole[] = [
  "CO_HOST",
  "CO_INSTRUCTOR",
];

// #772 B5 — collaborator shares are stored as basis points (bps) for integer
// money math. The public API/param surface stays in percent (0–90); convert at
// the DB boundary. 30% -> 3000 bps; the 90% cap -> 9000 bps.
const pctToBps = (pct: number) => Math.round(pct * 100);
const MAX_COLLAB_BPS = (100 - MIN_HOST_SHARE) * 100; // 9000

// #784 — a Collaborator must reference exactly one plan; Postgres CHECKs
// aren't Prisma-expressible, so the XOR is enforced here.
export function assertCollaboratorPlanXor(target: {
  webinarPlanId?: string | null;
  classPlanId?: string | null;
}): void {
  if (!target.webinarPlanId === !target.classPlanId) {
    throw new Error(
      "Collaborator must reference exactly one of webinarPlanId or classPlanId (#784)",
    );
  }
}

// Maps the public planType surface to the merged model's discriminator + FK.
function planScope(planType: PlanType, planId: string) {
  const scope =
    planType === "webinar"
      ? { collaboratorType: "WEBINAR" as const, webinarPlanId: planId }
      : { collaboratorType: "CLASS" as const, classPlanId: planId };
  assertCollaboratorPlanXor(scope);
  return scope;
}

function planWhere(planType: PlanType, planId: string) {
  return planType === "webinar"
    ? { webinarPlanId: planId }
    : { classPlanId: planId };
}

// #784 — the merged DB enum can't reject a class role on a webinar collab
// (the old per-type enums did), so the subset check lives here.
const ROLES_BY_PLAN_TYPE: Record<PlanType, readonly CollaboratorRole[]> = {
  webinar: WEBINAR_COLLABORATOR_ROLES,
  class: CLASS_COLLABORATOR_ROLES,
};

function asPlanRole(planType: PlanType, role: string): CollaboratorRole | null {
  return ROLES_BY_PLAN_TYPE[planType].find((r) => r === role) ?? null;
}

/**
 * Invite a collaborator to a webinar or class plan.
 */
// #768 lockdown #12 — capability booleans, set from invite input. Default
// false so an unspecified permission is never silently granted.
// Enforced: canSeeAttendees (participant-roster GET).
// TODO #1319 — enforce canApprovePayment / canViewAnalytics / canEditEvent
// once collaborator-facing payment-approval, analytics, and event-edit
// surfaces exist; today they have no endpoint to gate, so only the SET lands.
export interface CollaboratorPermissions {
  canApprovePayment?: boolean;
  canViewAnalytics?: boolean;
  canEditEvent?: boolean;
  canSeeAttendees?: boolean;
}

function normalizePermissions(permissions?: CollaboratorPermissions) {
  return {
    canApprovePayment: permissions?.canApprovePayment ?? false,
    canViewAnalytics: permissions?.canViewAnalytics ?? false,
    canEditEvent: permissions?.canEditEvent ?? false,
    canSeeAttendees: permissions?.canSeeAttendees ?? false,
  };
}

/** #1580 §6 — the invite transaction refuses a fourth seat or a second presenter. */
export class CollaboratorCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollaboratorCapError";
  }
}

/**
 * #1580 C-P1-9 — the invitee or the plan cannot take the seat. `httpStatus`
 * is 400 for a standing problem (deleted, unverified, banned, erased) and
 * 409 for a state clash (already an attendee, plan archived).
 */
export class CollaboratorIneligibleError extends Error {
  readonly httpStatus: 400 | 409;
  constructor(message: string, httpStatus: 400 | 409 = 400) {
    super(message);
    this.name = "CollaboratorIneligibleError";
    this.httpStatus = httpStatus;
  }
}

/**
 * The invitee must be a live, VERIFIED consultant on an account that is
 * neither banned (an expired ban does not count) nor erased. Returns the
 * user id so the caller can run the seat check without a second lookup, or
 * null when the profile does not exist at all (the pre-#1580 behaviour).
 */
async function assertInviteeEligible(
  consultantProfileId: string,
  db: PrismaLike = prisma,
): Promise<{ userId: string } | null> {
  const invitee = await db.consultantProfile.findUnique({
    where: { id: consultantProfileId },
    select: {
      deletedAt: true,
      verificationStatus: true,
      user: {
        select: { id: true, banned: true, banExpires: true, erasedAt: true },
      },
    },
  });
  if (!invitee) return null;
  if (invitee.deletedAt || invitee.user.erasedAt) {
    throw new CollaboratorIneligibleError(
      "This consultant's account is no longer active and cannot collaborate",
    );
  }
  if (invitee.verificationStatus !== "VERIFIED") {
    throw new CollaboratorIneligibleError(
      "Only verified consultants can collaborate on a plan",
    );
  }
  const banActive =
    invitee.user.banned === true &&
    (!invitee.user.banExpires || invitee.user.banExpires > new Date());
  if (banActive) {
    throw new CollaboratorIneligibleError(
      "This consultant's account is suspended and cannot collaborate",
    );
  }
  return { userId: invitee.user.id };
}

/**
 * A collaborator cannot also be an attendee of the plan they share in (the
 * checkout guard refuses the other direction, #1580 C-P0-2). The slot↔user
 * join is the seat truth; a cancelled or soft-deleted event does not count.
 */
async function assertNotAttendee(
  planType: PlanType,
  planId: string,
  userId: string,
  db: PrismaLike = prisma,
): Promise<void> {
  const seat = await db.slotOfAppointment.findFirst({
    where: {
      deletedAt: null,
      user: { some: { id: userId } },
      appointment: {
        deletedAt: null,
        status: { notIn: ["CANCELLED", "REJECTED", "EXPIRED"] },
        ...(planType === "webinar"
          ? { webinar: { webinarPlanId: planId } }
          : { class: { classPlanId: planId } }),
      },
    },
    select: { id: true },
  });
  if (seat) {
    throw new CollaboratorIneligibleError(
      "This consultant already holds a seat on one of this plan's events",
      409,
    );
  }
}

/** An archived (or missing) plan takes no new collaborator and accepts none. */
async function assertPlanOpen(
  planType: PlanType,
  planId: string,
  db: PrismaLike = prisma,
): Promise<void> {
  const plan =
    planType === "webinar"
      ? await db.webinarPlan.findUnique({
          where: { id: planId },
          select: { archivedAt: true },
        })
      : await db.classPlan.findUnique({
          where: { id: planId },
          select: { archivedAt: true },
        });
  if (!plan || plan.archivedAt) {
    throw new CollaboratorIneligibleError(
      "This plan is archived; collaborators cannot be invited or accepted",
      409,
    );
  }
}

export async function inviteCollaborator(
  planType: PlanType,
  planId: string,
  consultantProfileId: string,
  role: string,
  revenueSharePercentage: number,
  invitedById: string,
  permissions?: CollaboratorPermissions,
): Promise<Collaborator | null> {
  // Validate percentage range
  if (revenueSharePercentage <= 0 || revenueSharePercentage > 90) {
    return null;
  }

  const planRole = asPlanRole(planType, role);
  if (!planRole) return null;

  const perms = normalizePermissions(permissions);

  // #1580 C-P1-9 — the plan must be open and the invitee in good standing,
  // and they must not already sit in the audience of this plan's events.
  await assertPlanOpen(planType, planId);
  const invitee = await assertInviteeEligible(consultantProfileId);
  if (!invitee) return null;
  await assertNotAttendee(planType, planId, invitee.userId);

  // FIX B1: Wrap validation + creation in a serializable transaction
  // to prevent concurrent invites from exceeding the 90% cap.
  const txResult = await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        // Validate revenue share total <= 90% INSIDE transaction
        const valid = await validateRevenueSharesTx(
          tx,
          planType,
          planId,
          revenueSharePercentage,
        );
        if (!valid) return null;

        // FIX #6: Check for ANY existing collaboration (including REMOVED/DECLINED).
        // If REMOVED/DECLINED, re-activate instead of creating to respect unique constraint.
        const existing = await tx.collaborator.findFirst({
          where: { ...planWhere(planType, planId), consultantProfileId },
        });
        if (
          existing &&
          existing.status !== "REMOVED" &&
          existing.status !== "DECLINED"
        ) {
          // PENDING or ACCEPTED — already active
          return null;
        }

        // #1580 §6 — the cap, inside the Serializable tx so two concurrent
        // invites cannot jointly break it. A re-activation counts as a new invite.
        await assertCollaboratorCapTx(tx, planType, planId, planRole);

        if (existing) {
          // REMOVED or DECLINED — re-activate with new parameters
          return tx.collaborator.update({
            where: { id: existing.id },
            data: {
              role: planRole,
              revenueShareBps: pctToBps(revenueSharePercentage),
              status: "PENDING",
              invitedById,
              respondedAt: null,
              ...perms,
            },
          });
        }

        return tx.collaborator.create({
          data: {
            consultantProfileId,
            ...planScope(planType, planId),
            role: planRole,
            revenueShareBps: pctToBps(revenueSharePercentage),
            status: "PENDING",
            invitedById,
            ...perms,
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10000,
      },
    ),
  );

  // Fire-and-forget: notify invited collaborator
  if (txResult) {
    try {
      const invitedProfile = await prisma.consultantProfile.findUnique({
        where: { id: consultantProfileId },
        select: { userId: true },
      });
      const planTitle =
        planType === "webinar"
          ? (
              await prisma.webinarPlan.findUnique({
                where: { id: planId },
                select: { title: true },
              })
            )?.title
          : (
              await prisma.classPlan.findUnique({
                where: { id: planId },
                select: { title: true },
              })
            )?.title;

      const inviterProfile = await prisma.consultantProfile.findUnique({
        where: { id: invitedById },
        select: { user: { select: { name: true } } },
      });

      if (invitedProfile) {
        await notifyCollaboratorInvited(invitedProfile.userId, {
          planTitle: planTitle ?? "Unknown Plan",
          planType,
          role,
          revenueSharePercentage,
          ownerName: inviterProfile?.user?.name ?? "Plan Owner",
          dashboardUrl: `${getAppUrl()}/dashboard`,
        });
      }
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "stream" }, level: "warning" },
      );
      console.error(
        "[collaborators] Failed to send invitation notification:",
        error,
      );
    }
  }

  return txResult;
}

/**
 * Respond to a collaboration invitation (accept or decline).
 * When accepted, auto-creates a collaborator Stream chat channel.
 */
export async function respondToInvitation(
  planType: PlanType,
  collaborationId: string,
  consultantProfileId: string,
  response: "ACCEPTED" | "DECLINED",
): Promise<Collaborator | null> {
  const collab = await prisma.collaborator.findUnique({
    where: { id: collaborationId },
  });
  if (!collab || collab.consultantProfileId !== consultantProfileId)
    return null;
  // #784 — merged table: a planType that doesn't match the record is the old
  // wrong-table lookup, which returned null.
  const planId =
    planType === "webinar" ? collab.webinarPlanId : collab.classPlanId;
  if (!planId) return null;
  if (collab.status !== "PENDING") return null;

  // #1580 C-P1-9 — standing can change between invite and accept (a ban, an
  // erasure, an archive, a seat bought meanwhile), so the gates run again.
  if (response === "ACCEPTED") {
    await assertPlanOpen(planType, planId);
    const invitee = await assertInviteeEligible(consultantProfileId);
    if (!invitee) return null;
    await assertNotAttendee(planType, planId, invitee.userId);
  }

  const updated = await prisma.collaborator.update({
    where: { id: collaborationId },
    data: { status: response, respondedAt: new Date() },
  });

  if (response === "ACCEPTED") {
    try {
      const { createCollaboratorChannel } =
        await import("@/actions/stream/chat/channel.action");
      await createCollaboratorChannel(planType, planId);
    } catch (err) {
      Sentry.captureException(
        err instanceof Error ? err : new Error(String(err)),
        { tags: { subsystem: "stream" }, level: "warning" },
      );
      console.error("Failed to create collaborator channel:", err);
    }

    // Notify plan owner that collaborator accepted
    try {
      const plan =
        planType === "webinar"
          ? await prisma.webinarPlan.findUnique({
              where: { id: planId },
              select: {
                title: true,
                consultantProfile: { select: { userId: true } },
              },
            })
          : await prisma.classPlan.findUnique({
              where: { id: planId },
              select: {
                title: true,
                consultantProfile: { select: { userId: true } },
              },
            });
      const collabProfile = await prisma.consultantProfile.findUnique({
        where: { id: consultantProfileId },
        select: { user: { select: { name: true } } },
      });
      if (plan?.consultantProfile?.userId) {
        await notifyCollaboratorAccepted(plan.consultantProfile.userId, {
          planTitle: plan.title,
          planType,
          collaboratorName: collabProfile?.user?.name ?? "Collaborator",
          role: updated.role,
          dashboardUrl: `${getAppUrl()}/dashboard`,
        });
      }
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "stream" }, level: "warning" },
      );
      console.error(
        "[collaborators] Failed to send acceptance notification:",
        error,
      );
    }
  }

  return updated;
}

/**
 * Remove a collaborator (soft-delete: set status to REMOVED).
 * Requires planId to prevent IDOR — ensures the collaborator belongs to the specified plan.
 */
/** The removed row plus whether every Stream membership went with it. */
export type RemovedCollaborator = Collaborator & { accessRevoked: boolean };

export async function removeCollaborator(
  planType: PlanType,
  collaborationId: string,
  planId: string,
): Promise<RemovedCollaborator | null> {
  const collab = await prisma.collaborator.findFirst({
    where: { id: collaborationId, ...planWhere(planType, planId) },
  });
  if (!collab) return null;

  const result = await prisma.collaborator.update({
    where: { id: collaborationId },
    data: { status: "REMOVED" },
  });

  // Fire-and-forget: notification and Stream removal are independent.
  // Separate try/catch so a Novu outage doesn't block Stream revocation.
  const profile = await prisma.consultantProfile
    .findUnique({
      where: { id: collab.consultantProfileId },
      select: { userId: true },
    })
    .catch((error) => {
      // A null here skips BOTH the removal notification and the Stream
      // chat-access revocation below, leaving a removed collaborator with
      // chat access. The update already succeeded and must not be undone (#1125).
      reportSentryError(error, {
        subsystem: "collaborators",
        op: "removeCollaborator.profileLookup",
        expected: false,
      });
      return null;
    });

  // The row is REMOVED either way; whether Stream access actually went with it
  // is reported to the caller rather than swallowed (#1580).
  let accessRevoked = false;
  if (profile?.userId) {
    accessRevoked = (
      await revokeCollaboratorAccess(planType, planId, profile.userId)
    ).success;
  }

  return { ...result, accessRevoked };
}

/**
 * Everything a collaborator loses after their row leaves PENDING/ACCEPTED:
 * the removal notification, membership of every event channel on the plan
 * and of the `collab-<planType>-<planId>` coordination channel. Shared by
 * `removeCollaborator` and the moderation ban side-effect (#1580 C-P0-4).
 * Never throws; `success` is false when any Stream revocation did not land.
 */
export async function revokeCollaboratorAccess(
  planType: PlanType,
  planId: string,
  userId: string,
  opts: { notify?: boolean } = {},
): Promise<{ success: boolean }> {
  let success = true;

  if (opts.notify ?? true) {
    // Notification — independent failure
    try {
      const plan =
        planType === "webinar"
          ? await prisma.webinarPlan.findUnique({
              where: { id: planId },
              select: { title: true },
            })
          : await prisma.classPlan.findUnique({
              where: { id: planId },
              select: { title: true },
            });
      await notifyCollaboratorRemoved(userId, {
        planTitle: plan?.title ?? "Unknown Plan",
        planType,
        dashboardUrl: `${getAppUrl()}/dashboard`,
      });
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "stream" }, level: "warning" },
      );
      console.error(
        "[collaborators] Failed to send removal notification:",
        error,
      );
    }
  }

  // Stream channel revocation — independent failure
  try {
    const events =
      planType === "webinar"
        ? await prisma.webinar.findMany({
            where: { webinarPlanId: planId },
            select: { id: true },
          })
        : await prisma.class.findMany({
            where: { classPlanId: planId },
            select: { id: true },
          });
    // `removeUserFromEventChannel` REPORTS its own failures by returning
    // { success: false } — it does not throw — so awaiting it without reading
    // the result meant a failed revocation looked identical to a successful
    // one, and the outer catch never fired. A collaborator removed from the
    // plan kept chat access on every event, silently. (#1125)
    const revocations = await Promise.all(
      events.map((event) =>
        removeUserFromEventChannel(planType, event.id, userId),
      ),
    );
    const failedEventIds = events
      .filter((_, i) => !revocations[i]?.success)
      .map((event) => event.id);
    if (failedEventIds.length > 0) {
      success = false;
      reportSentryError(
        new Error(
          `Chat access not revoked for ${failedEventIds.length} of ${events.length} ${planType} events`,
        ),
        {
          subsystem: "stream",
          op: "removeCollaborator.revokeEventChannels",
          extra: { planId, planType, failedEventIds },
        },
      );
    }
    await getStreamChatClient()
      .channel("messaging", `collab-${planType}-${planId}`)
      .removeMembers([userId])
      .catch((error) => {
        success = false;
        // Separate from the event channels above: this is the collaborator
        // coordination channel, and losing it is not the same access grant.
        reportSentryError(error, {
          subsystem: "stream",
          op: "removeCollaborator.revokeCollabChannel",
          extra: { planId, planType },
        });
      });
  } catch (error) {
    success = false;
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" }, level: "warning" },
    );
    console.error("[collaborators] Failed to revoke Stream access:", error);
  }

  return { success };
}

/**
 * #1580 C-P0-3 — an ACCEPTED row's terms are the deal the collaborator agreed
 * to. Flipping it back to PENDING for re-consent would drop them from every
 * ACCEPTED-only reader and pay their share to the host in that window, so a
 * change is refused; the host removes and re-invites with the new terms.
 */
export class CollaboratorTermsLockedError extends Error {
  constructor() {
    super(
      "Accepted terms cannot be changed; remove the collaborator and re-invite with the new terms",
    );
    this.name = "CollaboratorTermsLockedError";
  }
}

/** The row is missing from the plan, or already REMOVED / DECLINED (→ 404). */
export class CollaboratorNotFoundError extends Error {
  constructor() {
    super("Collaborator not found or no longer active on this plan");
    this.name = "CollaboratorNotFoundError";
  }
}

/**
 * Update a PENDING collaborator's revenue share or role.
 * Requires planId to prevent IDOR — ensures the collaborator belongs to the specified plan.
 * Returns null when the new terms fail validation (as before); throws
 * CollaboratorNotFoundError for a missing / REMOVED / DECLINED row and
 * CollaboratorTermsLockedError for an ACCEPTED one (#1580 C-P0-3).
 */
export async function updateCollaborator(
  planType: PlanType,
  collaborationId: string,
  planId: string,
  updates: { revenueSharePercentage?: number; role?: string },
): Promise<Collaborator | null> {
  // Validate percentage range if updating
  if (updates.revenueSharePercentage !== undefined) {
    if (
      updates.revenueSharePercentage <= 0 ||
      updates.revenueSharePercentage > 90
    ) {
      return null;
    }
  }

  // #784 — reject cross-type roles up front (the per-type DB enums used to).
  let planRole: CollaboratorRole | undefined;
  if (updates.role) {
    const matched = asPlanRole(planType, updates.role);
    if (!matched) return null;
    planRole = matched;
  }

  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        // Verify collaborator belongs to this plan (IDOR prevention)
        const collab = await tx.collaborator.findFirst({
          where: { id: collaborationId, ...planWhere(planType, planId) },
        });
        if (!collab) throw new CollaboratorNotFoundError();
        // A share change during re-consent would drop the collaborator from
        // every ACCEPTED-only reader and pay their share to the host (#1580).
        if (collab.status === "ACCEPTED")
          throw new CollaboratorTermsLockedError();
        if (collab.status !== "PENDING") throw new CollaboratorNotFoundError();

        // A re-role to a presenter is the same guarantee as inviting one.
        if (planRole && PRESENTER_ROLES.includes(planRole)) {
          await assertCollaboratorCapTx(
            tx,
            planType,
            planId,
            planRole,
            collaborationId,
          );
        }

        if (updates.revenueSharePercentage !== undefined) {
          const valid = await validateRevenueSharesTx(
            tx,
            planType,
            planId,
            updates.revenueSharePercentage,
            collaborationId,
          );
          if (!valid) return null;
        }

        return tx.collaborator.update({
          where: { id: collaborationId },
          data: {
            ...(updates.revenueSharePercentage !== undefined && {
              revenueShareBps: pctToBps(updates.revenueSharePercentage),
            }),
            ...(planRole && { role: planRole }),
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10000,
      },
    ),
  );
}

/**
 * Get all collaborators for a plan. `db` lets a caller inside an open
 * transaction read through it instead of the global client (#1580 C-P0-1).
 */
export async function getCollaborators(
  planType: PlanType,
  planId: string,
  db: PrismaLike = prisma,
) {
  const activeStatuses: CollaboratorStatus[] = ["PENDING", "ACCEPTED"];

  return db.collaborator.findMany({
    where: { ...planWhere(planType, planId), status: { in: activeStatuses } },
    include: {
      consultantProfile: {
        include: { user: { select: { name: true, image: true } } },
      },
    },
    orderBy: { createdAt: "asc" },
  });
}

type CollaboratorItem = Awaited<ReturnType<typeof getCollaborators>>[number];

export type CollaboratorAuthResult =
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "ok"; data: CollaboratorItem[] };

/**
 * Fetch collaborators for a plan and apply visibility scoping based on the
 * requesting user's role (owner / accepted collaborator / pending invitee).
 * Returns a discriminated union so HTTP concerns stay in the route layer.
 */
export async function getCollaboratorsForUser(
  planType: PlanType,
  planId: string,
  userId: string,
): Promise<CollaboratorAuthResult> {
  const planQuery =
    planType === "webinar"
      ? prisma.webinarPlan.findUnique({
          where: { id: planId },
          select: { consultantProfileId: true },
        })
      : prisma.classPlan.findUnique({
          where: { id: planId },
          select: { consultantProfileId: true },
        });

  const [plan, requesterProfile] = await Promise.all([
    planQuery,
    prisma.consultantProfile.findFirst({
      where: { userId },
      select: { id: true },
    }),
  ]);

  if (!plan) return { status: "not_found" };

  const requesterProfileId = requesterProfile?.id;

  // Short-circuit: no consultant profile means cannot be owner or collaborator.
  // Avoids an unnecessary getCollaborators DB call for consultee / unauthenticated requests.
  if (!requesterProfileId) return { status: "forbidden" };

  const isOwner = plan.consultantProfileId === requesterProfileId;

  const collaborators = await getCollaborators(planType, planId);

  if (isOwner) {
    return { status: "ok", data: collaborators };
  }

  const ownRecord = collaborators.find(
    (c) => c.consultantProfileId === requesterProfileId,
  );

  if (ownRecord?.status === "ACCEPTED") {
    return {
      status: "ok",
      data: collaborators.filter((c) => c.status === "ACCEPTED"),
    };
  }

  if (ownRecord?.status === "PENDING") {
    return { status: "ok", data: [ownRecord] };
  }

  return { status: "forbidden" };
}

/**
 * Get all collaborations for a consultant.
 */
export async function getMyCollaborations(consultantProfileId: string) {
  const [webinarCollabs, classCollabs] = await Promise.all([
    prisma.collaborator.findMany({
      where: {
        consultantProfileId,
        collaboratorType: "WEBINAR",
        status: { in: ["PENDING", "ACCEPTED"] },
      },
      include: {
        webinarPlan: {
          select: {
            id: true,
            title: true,
            price: true,
            durationInHours: true,
            maxParticipants: true,
            language: true,
            level: true,
            consultantProfile: {
              select: {
                id: true,
                user: { select: { name: true, image: true } },
              },
            },
            collaborators: {
              where: { status: { in: ["PENDING", "ACCEPTED"] } },
              select: {
                id: true,
                role: true,
                revenueShareBps: true,
                status: true,
                consultantProfile: {
                  select: {
                    id: true,
                    user: { select: { name: true, image: true } },
                  },
                },
              },
              orderBy: { createdAt: "asc" },
            },
            webinars: {
              where: { status: { in: ["SCHEDULED", "IN_PROGRESS"] } },
              include: {
                appointment: {
                  include: {
                    slotsOfAppointment: {
                      select: {
                        startsAt: true,
                        endsAt: true,
                        isTentative: true,
                        _count: { select: { user: true } },
                      },
                    },
                  },
                },
              },
              orderBy: { createdAt: "desc" },
              take: 5,
            },
          },
        },
        invitedBy: {
          include: { user: { select: { name: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.collaborator.findMany({
      where: {
        consultantProfileId,
        collaboratorType: "CLASS",
        status: { in: ["PENDING", "ACCEPTED"] },
      },
      include: {
        classPlan: {
          select: {
            id: true,
            title: true,
            price: true,
            sessionDurationInHours: true,
            maxParticipants: true,
            sessionsPerWeek: true,
            durationInMonths: true,
            totalSessions: true,
            consultantProfile: {
              select: {
                id: true,
                user: { select: { name: true, image: true } },
              },
            },
            collaborators: {
              where: { status: { in: ["PENDING", "ACCEPTED"] } },
              select: {
                id: true,
                role: true,
                revenueShareBps: true,
                status: true,
                consultantProfile: {
                  select: {
                    id: true,
                    user: { select: { name: true, image: true } },
                  },
                },
              },
              orderBy: { createdAt: "asc" },
            },
            classes: {
              where: { status: { in: ["SCHEDULED", "IN_PROGRESS"] } },
              include: {
                appointments: {
                  include: {
                    slotsOfAppointment: {
                      select: {
                        startsAt: true,
                        endsAt: true,
                        isTentative: true,
                        _count: { select: { user: true } },
                      },
                      orderBy: { startsAt: "asc" },
                    },
                  },
                },
              },
              orderBy: { createdAt: "desc" },
              take: 5,
            },
          },
        },
        invitedBy: {
          include: { user: { select: { name: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return {
    webinarCollaborations: webinarCollabs,
    classCollaborations: classCollabs,
  };
}

/**
 * Get all plans owned by this consultant that have collaborators.
 * Returns plans with their collaborator lists and schedule data (host perspective).
 *
 * #org-appts / #1025 — split by the PLAN's org-ness, not the consultant's:
 * `personal` (default) surfaces only B2C plans (organizationId: null), an
 * `org` scope surfaces only that org's plans. Received invitations
 * (getMyCollaborations) are unaffected — those still aggregate personally.
 */
export async function getHostedCollaborations(
  consultantProfileId: string,
  scope: Scope = { kind: "personal" },
) {
  const orgFilter = scopeToWhereOrgId(scope);

  const [webinarPlans, classPlans] = await Promise.all([
    prisma.webinarPlan.findMany({
      where: {
        consultantProfileId,
        ...orgFilter,
        collaborators: {
          some: { status: { in: ["PENDING", "ACCEPTED"] } },
        },
      },
      select: {
        id: true,
        title: true,
        price: true,
        durationInHours: true,
        maxParticipants: true,
        language: true,
        level: true,
        collaborators: {
          where: { status: { in: ["PENDING", "ACCEPTED"] } },
          include: {
            consultantProfile: {
              include: { user: { select: { name: true, image: true } } },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        webinars: {
          where: { status: { in: ["SCHEDULED", "IN_PROGRESS"] } },
          include: {
            appointment: {
              include: {
                slotsOfAppointment: {
                  select: {
                    startsAt: true,
                    endsAt: true,
                    isTentative: true,
                    _count: { select: { user: true } },
                  },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.classPlan.findMany({
      where: {
        consultantProfileId,
        ...orgFilter,
        collaborators: {
          some: { status: { in: ["PENDING", "ACCEPTED"] } },
        },
      },
      select: {
        id: true,
        title: true,
        price: true,
        sessionDurationInHours: true,
        maxParticipants: true,
        sessionsPerWeek: true,
        durationInMonths: true,
        totalSessions: true,
        collaborators: {
          where: { status: { in: ["PENDING", "ACCEPTED"] } },
          include: {
            consultantProfile: {
              include: { user: { select: { name: true, image: true } } },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        classes: {
          where: { status: { in: ["SCHEDULED", "IN_PROGRESS"] } },
          include: {
            appointments: {
              include: {
                slotsOfAppointment: {
                  select: {
                    startsAt: true,
                    endsAt: true,
                    isTentative: true,
                    _count: { select: { user: true } },
                  },
                  orderBy: { startsAt: "asc" },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return { webinarPlans, classPlans };
}

/**
 * #1580 §6 — refuse the fourth PENDING + ACCEPTED row on a plan, and a second
 * presenter (CO_HOST / CO_INSTRUCTOR) while one is already pending or accepted.
 */
async function assertCollaboratorCapTx(
  db: PrismaLike,
  planType: PlanType,
  planId: string,
  role: CollaboratorRole,
  /** The row being re-roled, which already counts and must not block itself. */
  excludeId?: string,
): Promise<void> {
  const active = await db.collaborator.findMany({
    where: {
      ...planWhere(planType, planId),
      status: { in: ["PENDING", "ACCEPTED"] },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { role: true },
  });
  if (!excludeId && active.length >= MAX_COLLABORATORS_PER_PLAN) {
    throw new CollaboratorCapError(
      `A plan can have at most ${MAX_COLLABORATORS_PER_PLAN} pending or accepted collaborators`,
    );
  }
  if (
    PRESENTER_ROLES.includes(role) &&
    active.some((c) => PRESENTER_ROLES.includes(c.role))
  ) {
    throw new CollaboratorCapError(
      "A plan can have only one co-presenter (CO_HOST or CO_INSTRUCTOR); remove the existing one first",
    );
  }
}

/**
 * Validate that total revenue shares don't exceed 90% (host keeps min 10%).
 * Transaction-safe version that accepts a Prisma transaction client.
 */
async function validateRevenueSharesTx(
  db: Tx | typeof prisma,
  planType: PlanType,
  planId: string,
  newShare: number,
  excludeId?: string,
): Promise<boolean> {
  const collabs = await db.collaborator.findMany({
    where: {
      ...planWhere(planType, planId),
      status: { in: ["PENDING", "ACCEPTED"] },
      ...(excludeId && { NOT: { id: excludeId } }),
    },
    select: { revenueShareBps: true },
  });
  const currentTotal = collabs.reduce((sum, c) => sum + c.revenueShareBps, 0);

  return currentTotal + pctToBps(newShare) <= MAX_COLLAB_BPS;
}

/**
 * Calculate revenue split for a payment (owner gets remainder).
 */
export async function calculateRevenueSplit(
  planType: PlanType,
  planId: string,
  totalAmount: number,
  db: PrismaLike = prisma,
  /** The buyer of the seat being settled: a collaborator is never paid a share of their own purchase (#1580 C-P0-2). */
  opts: { excludeBuyerUserId?: string } = {},
): Promise<RevenueSplit[]> {
  const collabs = await getCollaborators(planType, planId, db);
  // Closes the window in which an acceptance lands between the checkout guard
  // and settlement: the exclusion is at the money boundary, not the read.
  const acceptedCollabs = collabs.filter(
    (c) =>
      c.status === "ACCEPTED" &&
      c.consultantProfile.userId !== opts.excludeBuyerUserId,
  );

  if (acceptedCollabs.length === 0) {
    return []; // No collaborators - regular single-owner flow
  }

  const splits: RevenueSplit[] = [];

  // #778 §C-2 — floor each collaborator share (Math.round could overshoot the
  // total and push the owner's remainder NEGATIVE); the owner absorbs every
  // floored paisa as the pool's designated residual party. Σbps > 10000 is a
  // mis-configured plan: refuse rather than mint money.
  const bpsSum = acceptedCollabs.reduce((a, c) => a + c.revenueShareBps, 0);
  if (bpsSum > 10_000) {
    throw new Error(
      `calculateRevenueSplit: collaborator shares sum to ${bpsSum} bps (> 10000) on ${planType} plan ${planId}`,
    );
  }
  let collaboratorTotal = 0;
  for (const collab of acceptedCollabs) {
    const share = Math.floor((totalAmount * collab.revenueShareBps) / 10_000);
    collaboratorTotal += share;
    splits.push({
      consultantProfileId: collab.consultantProfileId,
      share,
      role: collab.role,
    });
  }

  // Owner gets the remainder (≥ 0 by the floors + bps guard above)
  const ownerShare = totalAmount - collaboratorTotal;

  // Get plan's owner consultant profile
  let ownerConsultantProfileId: string | null = null;
  if (planType === "webinar") {
    const plan = await db.webinarPlan.findUnique({
      where: { id: planId },
      select: { consultantProfileId: true },
    });
    ownerConsultantProfileId = plan?.consultantProfileId ?? null;
  } else {
    const plan = await db.classPlan.findUnique({
      where: { id: planId },
      select: { consultantProfileId: true },
    });
    ownerConsultantProfileId = plan?.consultantProfileId ?? null;
  }

  if (ownerConsultantProfileId) {
    splits.unshift({
      consultantProfileId: ownerConsultantProfileId,
      share: ownerShare,
      role: "OWNER",
    });
  }

  return splits;
}
