/**
 * GET    /api/organizations/[orgId]/members/[memberId]
 * PATCH  /api/organizations/[orgId]/members/[memberId]
 * DELETE /api/organizations/[orgId]/members/[memberId]
 *
 * `memberId` is a `Membership.id` (not a User id). Operations produce an
 * audit log row in the same transaction as the mutation.
 *
 * Last-OWNER safety: the API refuses to demote or remove the only active
 * OWNER so an org can never end up ownerless. The check runs inside the
 * transaction so a concurrent second request can't race past it.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { isAtLeastRole } from "@/lib/auth/role-ranks";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";
import { isBlockedRoleTransition } from "@/lib/enterprise/role-transitions";
import { transitionMembership } from "@/lib/enterprise/transitions";
import { releaseSeatsForTerminatedAssignments } from "@/lib/api/organizations/seat-count";
import {
  applyMembershipRoleEffects,
  bumpUserSessionGeneration,
  recomputeConsultantIsIndependent,
} from "@/lib/api/organizations/membership-transitions";
import { notifyOrgExpertRemoved } from "@/lib/novu/service";

// Mirror the full Prisma MemberRole enum. The earlier hand-rolled list
// omitted BILLING_ADMIN — invitable via POST /members but un-PATCH-able
// here, so OWNERs couldn't promote a MAINTAINER to BILLING_ADMIN via
// the dashboard ("Invalid body" 400). Caught during the 2026-06 role
// audit. We could import lib/labels/org-labels.ts:MemberRoleSchema to
// share the source — kept local for now to avoid cross-cutting churn,
// but the values MUST stay in sync with the Prisma enum + the shared
// schema or we re-introduce the same drift bug.
const MemberRoleSchema = z.enum([
  "OWNER",
  "MAINTAINER",
  "BILLING_ADMIN",
  "MANAGER",
  "EXPERT",
  "LEARNER",
  "SUPPORT",
]);

const MemberStatusSchema = z.enum(["PENDING", "ACTIVE", "SUSPENDED", "REMOVED"]);

const PatchBodySchema = z
  .object({
    role: MemberRoleSchema.optional(),
    status: MemberStatusSchema.optional(),
    departmentLabel: z.string().max(100).nullable().optional(),
    // #729 — explicit EXPERT payout routing. Only applied when the effective
    // role is EXPERT (otherwise ignored); overrides the role-change default.
    payoutRecipient: z.enum(["SELF", "ORGANIZATION"]).optional(),
  })
  .refine(
    (v) =>
      v.role !== undefined ||
      v.status !== undefined ||
      v.departmentLabel !== undefined ||
      v.payoutRecipient !== undefined,
    {
      message:
        "PATCH body must contain at least one of role/status/departmentLabel/payoutRecipient",
    },
  );

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; memberId: string }>;
  },
) {
  const { orgId, memberId } = await params;
  // MANAGER+ can read other members' details. LEARNER+SUPPORT can only
  // fetch THEIR OWN membership — otherwise any member of the org could
  // enumerate peers' emails/names/profile ids. Member-list (index) view
  // remains separately gated; this is the detail endpoint.
  const access = await requireOrgAccess(orgId);
  if (access.error) return access.error;

  const membership = await prisma.membership.findFirst({
    where: { id: memberId, organizationId: orgId },
    include: {
      user: {
        select: { id: true, name: true, email: true, image: true },
      },
      consulteeProfile: { select: { id: true } },
      consultantProfile: { select: { id: true } },
    },
  });
  if (!membership) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  const isSelf = membership.id === access.member.id;
  const isManagerPlus = isAtLeastRole(access.member.role, "MANAGER");
  if (!isSelf && !isManagerPlus) {
    return NextResponse.json(
      { error: "Insufficient role to view other members" },
      { status: 403 },
    );
  }

  return NextResponse.json({ membership });
}

export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; memberId: string }>;
  },
) {
  const { orgId, memberId } = await params;
  const access = await requireOrgAccess(orgId, "MAINTAINER");
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = PatchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const patch = parsed.data;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.membership.findFirst({
        where: { id: memberId, organizationId: orgId },
      });
      if (!current) {
        throw Object.assign(new Error("Member not found"), { httpStatus: 404 });
      }

      // Disjoint LEARNER/EXPERT boundary. These two roles imply
      // different platform profiles (ConsulteeProfile vs ConsultantProfile)
      // and different billing postures (consumer vs provider), so the
      // product rule is to force a remove + re-invite instead of
      // mutating in place. Returning the machine-readable code lets the
      // dashboard surface the humanized copy via humanizeOrgError.
      if (
        patch.role !== undefined &&
        patch.role !== current.role &&
        isBlockedRoleTransition(current.role, patch.role)
      ) {
        throw Object.assign(
          new Error("ROLE_TRANSITION_BLOCKED"),
          { httpStatus: 409 },
        );
      }

      // OWNER role gate: only OWNERs can assign or revoke the OWNER role.
      // A MAINTAINER renaming someone to OWNER would effectively grant
      // themselves extra privileges by proxy.
      const touchesOwnerRole =
        patch.role === "OWNER" || current.role === "OWNER";
      if (touchesOwnerRole && !isAtLeastRole(access.member.role, "OWNER")) {
        throw Object.assign(
          new Error("Only an OWNER can assign or revoke the OWNER role"),
          { httpStatus: 403 },
        );
      }

      // Self-role-change guard. Caught during the 2026-06 MAINTAINER role
      // audit — a MAINTAINER could PATCH their own membership to LEARNER
      // (or any non-OWNER role), losing admin access and bypassing the
      // #729 strict identity gate (PATCH lazy-creates the profile, POST
      // refuses). The footgun: a MAINTAINER self-demotes accidentally and
      // needs an OWNER to restore them. Role changes belong to a
      // peer-or-superior review path; the actor cannot grade their own
      // membership. OWNERs are likewise blocked from changing their own
      // role — OWNER handoff goes through a dedicated promote-then-demote
      // path that the last-OWNER guard at L172-187 already protects.
      const isSelfRoleChange =
        memberId === access.member.id &&
        patch.role !== undefined &&
        patch.role !== current.role;
      if (isSelfRoleChange) {
        throw Object.assign(
          new Error(
            "You cannot change your own role. Ask another operator to do it for you.",
          ),
          { httpStatus: 403 },
        );
      }

      // Last-OWNER guard. Runs inside the TX so two concurrent demotes
      // can't both believe there's a second owner.
      const isDemotingOwner =
        current.role === "OWNER" &&
        patch.role !== undefined &&
        patch.role !== "OWNER";
      const isRemovingOwner =
        current.role === "OWNER" && patch.status === "REMOVED";
      if (isDemotingOwner || isRemovingOwner) {
        const activeOwnerCount = await tx.membership.count({
          where: {
            organizationId: orgId,
            role: "OWNER",
            status: "ACTIVE",
            id: { not: memberId },
          },
        });
        if (activeOwnerCount === 0) {
          throw Object.assign(
            new Error(
              "Cannot demote or remove the only active OWNER. Promote another member to OWNER first.",
            ),
            { httpStatus: 409 },
          );
        }
      }

      // Role-driven profile reconciliation. When the role changes we
      // hydrate / clear the consultee / consultant FKs through the
      // shared helper so PATCH stays in sync with POST and invite-accept.
      // payoutRecipient is reset to the role default (SELF) on role
      // change; pre-existing overrides are not preserved across a role
      // move.
      const roleEffects =
        patch.role !== undefined && patch.role !== current.role
          ? await applyMembershipRoleEffects(tx, {
              userId: current.userId,
              role: patch.role,
            })
          : null;

      // #729 — explicit payout-recipient choice, honoured only when the
      // resulting role is EXPERT. Applied AFTER the role-effect default so an
      // operator's choice wins over the reset on a role change.
      const effectiveRole = patch.role ?? current.role;
      const explicitPayoutRecipient =
        patch.payoutRecipient !== undefined && effectiveRole === "EXPERT"
          ? patch.payoutRecipient
          : undefined;

      // Status moves are CAS-guarded (a concurrent REMOVE/ERASE landing first
      // matches zero rows and 409s instead of being resurrected); the
      // remaining fields ride a plain update in the same tx.
      if (patch.status !== undefined && patch.status !== current.status) {
        await transitionMembership(tx, {
          where: { id: memberId, organizationId: orgId },
          to: patch.status,
        });

        // PATCH → REMOVED is the same operation as DELETE — run the same
        // assignment cascade so the member's slot frees up (see the DELETE
        // handler's rationale).
        if (patch.status === "REMOVED") {
          const now = new Date();
          await tx.programAssignment.updateMany({
            where: {
              membershipId: memberId,
              periodEnd: { gte: now },
              status: { in: ["ACTIVE", "PAUSED"] },
            },
            data: { periodEnd: now, status: "CANCELLED" },
          });
          // E2E-audit P1 fix — release the billed seats the cancelled
          // assignments held (parity with the assignment-route cancels).
          await releaseSeatsForTerminatedAssignments(tx, [memberId]);
        }
      }

      const otherData = {
        ...(patch.role !== undefined && { role: patch.role }),
        ...(patch.departmentLabel !== undefined && {
          departmentLabel: patch.departmentLabel,
        }),
        ...(roleEffects && {
          consulteeProfileId: roleEffects.consulteeProfileId,
          consultantProfileId: roleEffects.consultantProfileId,
          payoutRecipient: roleEffects.payoutRecipient,
        }),
        ...(explicitPayoutRecipient !== undefined && {
          payoutRecipient: explicitPayoutRecipient,
        }),
      };
      const updated =
        Object.keys(otherData).length > 0
          ? await tx.membership.update({
              where: { id: memberId },
              data: otherData,
            })
          : await tx.membership.findUniqueOrThrow({ where: { id: memberId } });

      // Bump the user's session-generation marker so the customSession
      // hook picks up the role / status change on their next request
      // instead of waiting up to 24h for BetterAuth's session rotation
      // (Phase B.5). Triggers for any field change that affects the
      // effective permission set: role, status, or departmentLabel.
      // departmentLabel is included because it shows up in the session
      // payload (`organizationMemberships[].departmentLabel`).
      if (
        patch.role !== undefined ||
        patch.status !== undefined ||
        patch.departmentLabel !== undefined
      ) {
        await bumpUserSessionGeneration(tx, current.userId);
      }

      // A4: recompute ConsultantProfile.isIndependent if this PATCH touches
      // an EXPERT membership. PATCH cannot promote *into* EXPERT (Zod schema
      // blocks LEARNER↔EXPERT and the patch.role union excludes EXPERT in
      // practice), but PATCH can move a current EXPERT into an operator
      // role or flip an EXPERT membership's status away from / back to
      // ACTIVE — both shift the consultant's HOST-membership count.
      if (
        current.role === "EXPERT" &&
        current.consultantProfileId &&
        (patch.role !== undefined || patch.status !== undefined)
      ) {
        await recomputeConsultantIsIndependent(
          tx,
          current.consultantProfileId,
        );
      }

      const auditActions: string[] = [];
      if (patch.role !== undefined && patch.role !== current.role) {
        auditActions.push(AUDIT_ACTIONS.MEMBER.ROLE_CHANGE);
      }
      if (patch.status !== undefined && patch.status !== current.status) {
        auditActions.push(AUDIT_ACTIONS.MEMBER.STATUS_CHANGE);
      }
      for (const action of auditActions) {
        await tx.orgAuditLog.create({
          data: {
            organizationId: orgId,
            actorMembershipId: access.member.id,
            targetMembershipId: memberId,
            category: "MEMBER",
            action,
            description:
              action === AUDIT_ACTIONS.MEMBER.ROLE_CHANGE
                ? `Role: ${current.role} → ${patch.role}`
                : `Status: ${current.status} → ${patch.status}`,
            details: {
              from: {
                role: current.role,
                status: current.status,
              },
              to: {
                role: patch.role ?? current.role,
                status: patch.status ?? current.status,
              },
            },
          },
        });
      }

      return updated;
    });

    return NextResponse.json({ membership: result });
  } catch (err) {
    // Structured error handling keeps the switch between 404/403/409
    // explicit — never leak a 500 for user-facing validation issues.
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "organizations" } });
    throw err;
  }
}

export async function DELETE(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; memberId: string }>;
  },
) {
  const { orgId, memberId } = await params;
  const access = await requireOrgAccess(orgId, "MAINTAINER");
  if (access.error) return access.error;

  // #779 §C — in-flight-money override. Only an OWNER may force past the
  // pre-check; MAINTAINERs must clear the money first.
  const force = req.nextUrl.searchParams.get("force") === "true";
  const isOwner = access.member.role === "OWNER";

  // A7: capture context for the post-commit Novu fire. Resolved BEFORE
  // the transaction so the notification payload is ready to dispatch the
  // moment the soft-delete commits. Set inside the tx; fired after commit.
  let notifyContext: {
    consultantUserId: string;
    payload: import("@/lib/novu/workflows").OrgExpertRemovedPayload;
  } | null = null;

  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.membership.findFirst({
        where: { id: memberId, organizationId: orgId },
        include: { user: { select: { id: true } } },
      });
      if (!current) {
        throw Object.assign(new Error("Member not found"), { httpStatus: 404 });
      }

      // Self-DELETE guard. The trash icon on your own row would
      // otherwise let a MAINTAINER (or any operator) self-fire in
      // one click — they'd lose org access immediately and need
      // another OWNER to restore. "Leave organization" is a real
      // use case but belongs to a dedicated confirmation flow with
      // explicit copy ("you will lose access immediately"), not the
      // same trash button used to evict others. Until that flow
      // exists, refuse self-DELETE here. Caught during the 2026-06
      // MAINTAINER role audit alongside the self-role-change guard
      // in PATCH.
      if (memberId === access.member.id) {
        throw Object.assign(
          new Error(
            "You cannot remove yourself. Ask another operator, or use the Leave organization flow when it ships.",
          ),
          { httpStatus: 403 },
        );
      }

      if (current.role === "OWNER") {
        // OWNER-only gate — mirrors PATCH at L154-161. Without this, a
        // MAINTAINER (rank 80) who passed `requireOrgAccess(..., "MAINTAINER")`
        // could DELETE an OWNER row as long as it wasn't the last OWNER,
        // because the last-OWNER guard below only protects org continuity,
        // not privilege escalation. Caught during the 2026-06 MAINTAINER
        // role audit.
        if (!isAtLeastRole(access.member.role, "OWNER")) {
          throw Object.assign(
            new Error("Only an OWNER can remove an OWNER"),
            { httpStatus: 403 },
          );
        }
        // Last-OWNER guard — unchanged semantically. Now applied to
        // soft-delete (status → REMOVED) so a sole OWNER can't orphan
        // the org by removing themselves.
        const activeOwnerCount = await tx.membership.count({
          where: {
            organizationId: orgId,
            role: "OWNER",
            status: "ACTIVE",
            id: { not: memberId },
          },
        });
        if (activeOwnerCount === 0) {
          throw Object.assign(
            new Error(
              "Cannot remove the only active OWNER. Promote another member first.",
            ),
            { httpStatus: 409 },
          );
        }
      }

      if (current.status === "REMOVED") {
        // Idempotent: a repeat DELETE is a no-op that still returns 204.
        return;
      }

      // #779 §C — in-flight-money pre-check. Removing a member while real
      // money tied to THEM is still moving would strand it: a pending/accrued
      // overage charge, unpaid consultant earnings, an in-progress refund, or
      // an open dispute all need a settled owner. Scoped via the member's
      // payments (payment.userId = member.userId); earnings via their
      // ConsultantProfile. An OWNER may override with ?force=true once they've
      // accepted the consequences.
      const [overageInflight, unpaidEarnings, pendingRefunds, openDisputes] =
        await Promise.all([
          tx.overageEvent.count({
            where: {
              chargeStatus: { in: ["PENDING", "ACCRUED"] },
              payment: { userId: current.userId },
            },
          }),
          current.consultantProfileId
            ? tx.consultantEarnings.count({
                where: {
                  consultantProfileId: current.consultantProfileId,
                  status: { not: "PAID" },
                },
              })
            : Promise.resolve(0),
          tx.refund.count({
            where: {
              status: "PENDING",
              payment: { userId: current.userId },
            },
          }),
          tx.dispute.count({
            where: {
              // Open = anything not yet terminal (WON/LOST/CHARGE_REFUNDED/
              // WARNING_CLOSED). Money may still move until then.
              status: {
                in: [
                  "WARNING_NEEDS_RESPONSE",
                  "WARNING_UNDER_REVIEW",
                  "NEEDS_RESPONSE",
                  "UNDER_REVIEW",
                ],
              },
              payment: { userId: current.userId },
            },
          }),
        ]);
      const inflightTotal =
        overageInflight + unpaidEarnings + pendingRefunds + openDisputes;
      if (inflightTotal > 0 && !(force && isOwner)) {
        throw Object.assign(new Error("MEMBER_HAS_INFLIGHT_MONEY"), {
          httpStatus: 409,
          code: "MEMBER_HAS_INFLIGHT_MONEY",
          counts: {
            overageInflight,
            unpaidEarnings,
            pendingRefunds,
            openDisputes,
          },
        });
      }
      const forced = inflightTotal > 0;

      // Soft-delete (status=REMOVED) instead of hard-delete: audit rows
      // reference Membership via `actorMembershipId`/`targetMembershipId`,
      // payouts, earnings, and wallet entries do too. A hard delete
      // would cascade across half the compliance tables. REMOVED is a
      // tombstone — it hides the row from all listing endpoints, blocks
      // login attempts, but keeps the history queryable. The CAS makes a
      // concurrent double-DELETE 409 instead of re-running the cascade.
      await transitionMembership(tx, {
        where: { id: memberId, organizationId: orgId },
        to: "REMOVED",
      });

      // Bump the user's session-generation marker so their next
      // request hits the customSession refetch path and observes the
      // missing org membership (Phase B.5). Without this, a removed
      // member can keep acting on org-scoped routes for up to 24h
      // because the cached memberships array still lists the org.
      await bumpUserSessionGeneration(tx, current.userId);

      // A4: if this was an EXPERT membership, recompute the consultant's
      // isIndependent flag now that one HOST tie is gone. If it was the
      // last active EXPERT membership at any HOST org the flag flips back
      // to true and the consultant re-appears as "independent" on
      // /explore/experts.
      if (current.role === "EXPERT" && current.consultantProfileId) {
        await recomputeConsultantIsIndependent(
          tx,
          current.consultantProfileId,
        );
      }

      // A7 note: past `OrganizationEarnings` are NOT touched on member
      // removal. Sessions the consultant already delivered are settled
      // commitments — the org earned its share at booking time, and the
      // consultant's `ConsultantEarnings` row will pay out independently.
      // Cancelling already-accrued earnings here would create
      // reconciliation drift (LED-3 / LED-4 invariants would break).
      // Forward-looking: once the consultant is REMOVED, no NEW
      // `OrganizationEarnings` rows are created (resolveOrgSplit returns
      // null when no active EXPERT membership at a canHost org exists).

      // Cascade: terminate any active ProgramAssignments. Without this,
      // a removed member's assignments still match the
      // `periodStart <= now AND periodEnd >= now` filter, so their slot
      // continues to count against the program cap and a replacement
      // member can't be added. We close the period at `now` rather than
      // deleting so engagementsUsed history + UsageLedgerEntry rows
      // remain queryable for reconciliation.
      // #779 §A — close the period AND stamp status=CANCELLED (member
      // removed mid-cycle) so the assignment lifecycle is explicit, not
      // inferred from periodEnd alone.
      // Status guard: only live allocations cascade — a ROLLED/CLOSED row
      // must never be re-stamped CANCELLED by a (forced) re-removal.
      const now = new Date();
      const terminated = await tx.programAssignment.updateMany({
        where: {
          membershipId: memberId,
          periodEnd: { gte: now },
          status: { in: ["ACTIVE", "PAUSED"] },
        },
        data: { periodEnd: now, status: "CANCELLED" },
      });
      // E2E-audit P1 fix — release billed seats (see PATCH → REMOVED arm).
      await releaseSeatsForTerminatedAssignments(tx, [memberId]);

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          targetMembershipId: memberId,
          category: "MEMBER",
          action: AUDIT_ACTIONS.MEMBER.MEMBER_REMOVED,
          description: `Removed member ${memberId} (soft delete)`,
          details: {
            role: current.role,
            previousStatus: current.status,
            assignmentsTerminated: terminated.count,
            // #779 §C — record an OWNER force-override past the in-flight money
            // pre-check so the audit trail shows the money was knowingly left.
            ...(forced && { forced: true }),
          },
        },
      });

      // Outbound webhook: notify integrations that the membership is
      // gone (HRIS deprovisioning, SaaS-license reclaim). Dispatched
      // inside the transaction so a rollback (e.g. anti-lockout veto)
      // also rolls back the webhook delivery row.
      await dispatchWebhookEvent({
        prisma: tx,
        organizationId: orgId,
        eventType: "member.removed",
        payload: {
          membershipId: memberId,
          userId: current.userId,
          role: current.role,
          previousStatus: current.status,
        },
      });

      // A7: stage the Novu fire (executed AFTER the tx commits so a
      // rollback never pages a notification for a delete that didn't
      // happen). Only EXPERT removals trigger the personal notification —
      // operator role removals don't need this.
      if (current.role === "EXPERT" && current.user) {
        const org = await tx.organization.findUnique({
          where: { id: orgId },
          select: { name: true, slug: true },
        });
        const actor = await tx.user.findUnique({
          where: { id: access.session.user.id },
          select: { name: true, email: true },
        });
        if (org) {
          notifyContext = {
            consultantUserId: current.user.id,
            payload: {
              orgName: org.name,
              orgSlug: org.slug,
              removedByName: actor?.name ?? actor?.email ?? "An operator",
              reason: null,
              dashboardUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/dashboard/consultant`,
            },
          };
        }
      }
    });

    // A7: fire-and-forget Novu trigger after commit. A failure here MUST
    // NOT roll back the soft-delete (the membership is already gone in
    // the DB); log the error and continue.
    if (notifyContext !== null) {
      const ctx = notifyContext as {
        consultantUserId: string;
        payload: import("@/lib/novu/workflows").OrgExpertRemovedPayload;
      };
      try {
        await notifyOrgExpertRemoved(ctx.consultantUserId, ctx.payload);
      } catch (notifyErr) {
        Sentry.captureException(notifyErr instanceof Error ? notifyErr : new Error(String(notifyErr)), { tags: { subsystem: "organizations" } });
        console.error(
          "[member-delete] Novu notify failed (non-fatal):",
          notifyErr,
        );
      }
    }

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      // #779 §C — forward the structured code + breakdown counts so the UI
      // renders the in-flight-money wind-down message.
      const code =
        "code" in err && typeof err.code === "string" ? err.code : undefined;
      const counts =
        "counts" in err && err.counts && typeof err.counts === "object"
          ? err.counts
          : undefined;
      return NextResponse.json(
        { error: err.message, ...(code && { code }), ...(counts && { counts }) },
        { status },
      );
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "organizations" } });
    throw err;
  }
}
