import * as Sentry from "@sentry/nextjs";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import prisma, { type Tx } from "@/lib/prisma";
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

type PlanType = "webinar" | "class";

const MIN_HOST_SHARE = 10; // Host must keep at least 10%

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

  // Verify the invited consultant profile exists before creating a collaborator record.
  // Without this check, a stale or fabricated consultantProfileId creates an orphaned row.
  const inviteeProfile = await prisma.consultantProfile.findUnique({
    where: { id: consultantProfileId },
    select: { id: true },
  });
  if (!inviteeProfile) {
    return null;
  }

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

        if (existing) {
          if (existing.status === "REMOVED" || existing.status === "DECLINED") {
            // Re-activate with new parameters
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
          // PENDING or ACCEPTED — already active
          return null;
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
export async function removeCollaborator(
  planType: PlanType,
  collaborationId: string,
  planId: string,
): Promise<Collaborator | null> {
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

  if (profile?.userId) {
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
      await notifyCollaboratorRemoved(profile.userId, {
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
          removeUserFromEventChannel(planType, event.id, profile.userId),
        ),
      );
      const failedEventIds = events
        .filter((_, i) => !revocations[i]?.success)
        .map((event) => event.id);
      if (failedEventIds.length > 0) {
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
        .removeMembers([profile.userId])
        .catch((error) => {
          // Separate from the event channels above: this is the collaborator
          // coordination channel, and losing it is not the same access grant.
          reportSentryError(error, {
            subsystem: "stream",
            op: "removeCollaborator.revokeCollabChannel",
            extra: { planId, planType },
          });
        });
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "stream" }, level: "warning" },
      );
      console.error("[collaborators] Failed to revoke Stream access:", error);
    }
  }

  return result;
}

/**
 * Update a collaborator's revenue share or role.
 * Requires planId to prevent IDOR — ensures the collaborator belongs to the specified plan.
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
        if (!collab) return null;

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
 * Get all collaborators for a plan.
 */
export async function getCollaborators(planType: PlanType, planId: string) {
  const activeStatuses: CollaboratorStatus[] = ["PENDING", "ACCEPTED"];

  return prisma.collaborator.findMany({
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
): Promise<RevenueSplit[]> {
  const collabs = await getCollaborators(planType, planId);
  const acceptedCollabs = collabs.filter((c) => c.status === "ACCEPTED");

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
    const plan = await prisma.webinarPlan.findUnique({
      where: { id: planId },
      select: { consultantProfileId: true },
    });
    ownerConsultantProfileId = plan?.consultantProfileId ?? null;
  } else {
    const plan = await prisma.classPlan.findUnique({
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
