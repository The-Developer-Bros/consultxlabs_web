import { Prisma } from "@prisma/client";
import type { PrismaLike } from "@/lib/prisma";
/**
 * SCIM 2.0 User operations — `createUser`, `patchUser`, `deprovisionUser`,
 * `listUsers`. Pure functions that read + write through Prisma; the
 * route handlers wrap them with SCIM auth + error envelopes.
 *
 * Why the operations are split out from the route handlers
 * --------------------------------------------------------
 * The same logic powers (1) the standard SCIM endpoints under
 * `/scim/v2/Users`, (2) the per-org dashboard's "manually trigger sync"
 * action (a future addition), and (3) unit tests. Keeping the work
 * here means each call site stays thin.
 *
 * Erasure short-circuit
 * ---------------------
 * Every operation that creates or revives a User refuses to act when
 * `User.erasedAt IS NOT NULL` — once a user has exercised DPDP §12
 * right-to-erasure, SCIM cannot re-create or re-activate them. The
 * SCIM response is `410 Gone` per RFC 7644 §3.6, surfacing as a
 * permanent error in the IdP's provisioning report so the operator
 * can purge the user from their IdP roster.
 */

import {
  applyMembershipRoleEffects,
  bumpUserSessionGeneration,
} from "@/lib/api/organizations/membership-transitions";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  DomainVerificationRequiredError,
  UNVERIFIED_ORG_SEAT_CAP,
  hasVerifiedDomain,
} from "@/lib/enterprise/governance";
import { releaseSeatsForTerminatedAssignments } from "@/lib/api/organizations/seat-count";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { resolveRoleFromGroupNames } from "./resource-user";

export type ScimOperationError =
  | { kind: "USER_ERASED"; userId: string }
  | { kind: "NOT_FOUND" }
  | { kind: "CONFLICT"; detail: string };

export interface CreateScimUserInput {
  organizationId: string;
  userName: string;
  givenName?: string;
  familyName?: string;
  active?: boolean;
  /// SCIM group names from the resource payload; mapped to roles via
  /// `ScimGroupMapping`. Empty array → LEARNER (least-privilege).
  groupNames?: string[];
  /// IdP-assigned external resource id. Stable across SCIM calls;
  /// stored on Membership.externalScimId.
  externalId?: string;
}

export interface ScimUserOpResult {
  membershipId: string;
  userId: string;
  externalScimId: string | null;
  role: string;
  status: string;
}

/**
 * Idempotent upsert by `(organizationId, userName)`.
 *
 * - If no User exists for `userName`, creates one (BetterAuth `User`
 *   row + lazy profile creation handled by `applyMembershipRoleEffects`).
 * - If the User exists but has no Membership in the org, creates one.
 * - If the Membership exists, treats this as a re-provisioning PATCH:
 *   updates active/role/externalScimId in place.
 */
export async function createOrReprovisionScimUser(
  prisma: PrismaLike,
  input: CreateScimUserInput,
): Promise<ScimUserOpResult | ScimOperationError> {
  const {
    organizationId,
    userName,
    givenName,
    familyName,
    active = true,
    groupNames = [],
    externalId,
  } = input;

  const emailLower = userName.trim().toLowerCase();
  if (!emailLower) {
    return { kind: "CONFLICT", detail: "userName is required" };
  }

  // Resolve target role from group mapping BEFORE the transaction so
  // we don't hold the row-level lock open longer than necessary.
  const mappings = await prisma.scimGroupMapping.findMany({
    where: { organizationId },
    select: { scimGroupName: true, role: true },
  });
  const targetRole = resolveRoleFromGroupNames(groupNames, mappings);

  const displayName =
    givenName || familyName
      ? `${givenName ?? ""} ${familyName ?? ""}`.trim()
      : emailLower.split("@")[0];

  // Lookup-then-upsert. Two Prisma calls in a transaction are cheaper
  // than the single `upsert` because we want different audit actions
  // depending on create-vs-reprovision.
  const existingUser = await prisma.user.findUnique({
    where: { email: emailLower },
    select: { id: true, erasedAt: true },
  });
  if (existingUser?.erasedAt) {
    return { kind: "USER_ERASED", userId: existingUser.id };
  }

  // Serializable, matching the invite path (organizations/[orgId]/
  // invitations): the seat-cap gate below is a count-then-create TOCTOU
  // that a parallel IdP provisioning burst could slip past at READ
  // COMMITTED. Serializable makes concurrent transactions that both read
  // the seat counts and insert fail one side at commit (P2034) instead of
  // both overshooting UNVERIFIED_ORG_SEAT_CAP.
  // #1132 follow-up — P2034 is transient and now retried instead of
  // surfacing as a SCIM 500 to the IdP.
  return withSerializableRetry(() =>
    prisma.$transaction(async (tx) => {
    const user = existingUser
      ? await tx.user.update({
          where: { id: existingUser.id },
          data: {
            // Only refresh the display name when the IdP shipped one —
            // avoid clobbering a user-chosen name with the email prefix.
            ...(givenName || familyName ? { name: displayName } : {}),
          },
        })
      : await tx.user.create({
          data: {
            email: emailLower,
            name: displayName,
            emailVerified: true,
            // SCIM users authenticate via the IdP, not via password.
            // No password column to populate — BetterAuth handles SSO
            // session minting elsewhere.
          },
        });

    const existingMembership = await tx.membership.findFirst({
      where: { organizationId, userId: user.id },
      select: { id: true, role: true, status: true, externalScimId: true },
    });

    const roleEffects = await applyMembershipRoleEffects(tx, {
      userId: user.id,
      role: targetRole,
    });

    if (existingMembership) {
      // Terminal tombstones are admin/compliance-owned — an IdP reprovision
      // heartbeat must not resurrect a REMOVED/ERASED membership. Surfacing
      // the conflict (instead of silently flipping back to ACTIVE) makes the
      // IdP-side error visible to the org's IT admin.
      if (
        existingMembership.status === "REMOVED" ||
        existingMembership.status === "ERASED"
      ) {
        return {
          kind: "CONFLICT",
          detail: `membership is ${existingMembership.status.toLowerCase()} — re-invite via the dashboard instead of re-provisioning`,
        };
      }
      const nextStatus = active ? "ACTIVE" : "SUSPENDED";
      // #789 review — only invalidate the session when the role or status
      // actually moves, so an idempotent reprovision (the common IdP heartbeat)
      // doesn't pay a sessionGeneration write + forced client refetch each time.
      const membershipChanged =
        existingMembership.role !== targetRole ||
        existingMembership.status !== nextStatus;
      const updated = await tx.membership.update({
        where: { id: existingMembership.id },
        data: {
          role: targetRole,
          status: nextStatus,
          externalScimId:
            externalId ?? existingMembership.externalScimId ?? null,
          consulteeProfileId: roleEffects.consulteeProfileId,
          consultantProfileId: roleEffects.consultantProfileId,
          payoutRecipient: roleEffects.payoutRecipient,
        },
      });
      // An IdP-driven role change or deactivation must invalidate the user's
      // cached session memberships, same as the in-app member routes; otherwise
      // a SCIM-suspended user keeps a stale active membership in their session
      // payload until the cookie cache lapses.
      if (membershipChanged) {
        await bumpUserSessionGeneration(tx, user.id);
      }
      await tx.orgAuditLog.create({
        data: {
          organizationId,
          targetMembershipId: updated.id,
          category: "SYSTEM",
          action: AUDIT_ACTIONS.SYSTEM.SCIM_USER_UPDATED,
          description: `SCIM: updated ${emailLower} (role=${targetRole}, active=${active})`,
          details: {
            userName: emailLower,
            role: targetRole,
            active,
            groupNames,
          },
        },
      });
      return {
        membershipId: updated.id,
        userId: user.id,
        externalScimId: updated.externalScimId,
        role: updated.role,
        status: updated.status,
      } satisfies ScimUserOpResult;
    }

    // #675 parity with the invite path — an unverified org is hard-capped at
    // UNVERIFIED_ORG_SEAT_CAP seats; SCIM auto-provisioning must honor the same
    // gate or an IdP could bulk-provision straight past it. Only brand-new
    // seats count (reprovisions returned above). Throw (not a CONFLICT return)
    // so the User/profile writes above roll back instead of orphaning.
    if (!(await hasVerifiedDomain(tx, organizationId))) {
      const [activeMembers, pendingInvites] = await Promise.all([
        tx.membership.count({
          where: { organizationId, status: "ACTIVE" },
        }),
        tx.invitation.count({
          where: { organizationId, status: "pending" },
        }),
      ]);
      if (activeMembers + pendingInvites >= UNVERIFIED_ORG_SEAT_CAP) {
        throw new DomainVerificationRequiredError("BULK_SEATS");
      }
    }

    const created = await tx.membership.create({
      data: {
        organizationId,
        userId: user.id,
        role: targetRole,
        status: active ? "ACTIVE" : "SUSPENDED",
        externalScimId: externalId ?? null,
        consulteeProfileId: roleEffects.consulteeProfileId,
        consultantProfileId: roleEffects.consultantProfileId,
        payoutRecipient: roleEffects.payoutRecipient,
      },
    });
    // #789 review — a newly provisioned membership must show up in the user's
    // session immediately if they already have a live session in another org.
    await bumpUserSessionGeneration(tx, user.id);

    await tx.orgAuditLog.create({
      data: {
        organizationId,
        targetMembershipId: created.id,
        category: "SYSTEM",
        action: AUDIT_ACTIONS.SYSTEM.SCIM_USER_CREATED,
        description: `SCIM: created ${emailLower} as ${targetRole}`,
        details: { userName: emailLower, role: targetRole, active, groupNames },
      },
    });

    // Fan out the standard member.added event — integrators that
    // already subscribe to the in-app invite path get the SCIM path
    // for free, no second subscription.
    await dispatchWebhookEvent({
      prisma: tx,
      organizationId,
      eventType: "member.added",
      payload: {
        membershipId: created.id,
        userId: user.id,
        role: targetRole,
        source: "scim",
      },
    });

    return {
      membershipId: created.id,
      userId: user.id,
      externalScimId: created.externalScimId,
      role: created.role,
      status: created.status,
    } satisfies ScimUserOpResult;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/**
 * SCIM DELETE on a User resource → SUSPEND the membership.
 *
 * Why never erase: DELETE in SCIM means "stop provisioning this
 * resource", not "purge their data". Erasure is the user's own DPDP
 * §12 right, exercised through `/api/users/me/erasure-requests`.
 */
export async function deprovisionScimUser(
  prisma: PrismaLike,
  params: { organizationId: string; resourceId: string },
): Promise<ScimUserOpResult | ScimOperationError> {
  const { organizationId, resourceId } = params;
  const membership = await prisma.membership.findFirst({
    where: {
      organizationId,
      OR: [{ externalScimId: resourceId }, { id: resourceId }],
    },
    select: { id: true, userId: true, status: true, role: true },
  });
  if (!membership) return { kind: "NOT_FOUND" };

  // #1132 follow-up — retried on transient aborts like createUser above.
  // Deliberately left at the default isolation level: this path is a single
  // guarded CAS update, so no multi-row invariant needs Serializable.
  return withSerializableRetry(() =>
    prisma.$transaction(async (tx) => {
    // Guarded + idempotent: a deprovision retry on an already-SUSPENDED row is
    // a no-op, and a REMOVED/ERASED tombstone is never resurrected — the IdP
    // reads those as inactive either way.
    await tx.membership.updateMany({
      where: { id: membership.id, status: { in: ["PENDING", "ACTIVE"] } },
      data: { status: "SUSPENDED" },
    });
    // E2E-audit P1 fix — a deprovisioned member's live ProgramAssignments
    // used to keep counting against program caps AND against the contract's
    // billed activeSeatCount. Terminate the live assignments (same cascade
    // as member removal) and release the seats.
    const now = new Date();
    await tx.programAssignment.updateMany({
      where: {
        membershipId: membership.id,
        periodEnd: { gte: now },
        status: { in: ["ACTIVE", "PAUSED"] },
      },
      data: { periodEnd: now, status: "CANCELLED" },
    });
    await releaseSeatsForTerminatedAssignments(tx, [membership.id]);
    const updated = await tx.membership.findUniqueOrThrow({
      where: { id: membership.id },
    });
    // #789 — invalidate the deprovisioned user's cached session memberships so
    // the suspension takes effect immediately instead of lingering for the
    // cookie-cache window.
    await bumpUserSessionGeneration(tx, membership.userId);
    await tx.orgAuditLog.create({
      data: {
        organizationId,
        targetMembershipId: updated.id,
        category: "SYSTEM",
        action: AUDIT_ACTIONS.SYSTEM.SCIM_USER_DEPROVISIONED,
        description: `SCIM: deprovisioned membership ${membership.id}`,
        details: { previousStatus: membership.status },
      },
    });
    await dispatchWebhookEvent({
      prisma: tx,
      organizationId,
      eventType: "member.removed",
      payload: {
        membershipId: updated.id,
        userId: membership.userId,
        role: membership.role,
        previousStatus: membership.status,
        source: "scim",
      },
    });
    return {
      membershipId: updated.id,
      userId: membership.userId,
      externalScimId: null,
      role: updated.role,
      status: updated.status,
    };
  }));
}
