/**
 * POST /api/organizations/invitations/accept
 *
 * Accepts a pending BetterAuth `Invitation` by id and creates the typed
 * `Membership` row in the same transaction. Also creates the BetterAuth
 * `Member` sibling so BetterAuth's org-scoped session flows keep working
 * — the two tables are linked via `Membership.betterAuthMemberId`.
 *
 * Token race: two concurrent accepts from the same email could both pass
 * the pre-check. `updateMany WHERE status = pending` gives us an atomic
 * claim — only the first caller transitions the invitation to accepted,
 * the second sees count=0 and reports 409.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { checkConsent } from "@/lib/compliance/dpdp";
import { PURPOSE_CODES } from "@/lib/compliance/purpose-codes";
import { MemberRoleSchema } from "@/lib/labels/org-labels";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { isOnboardingBlocked } from "@/lib/enterprise/org-status";
import {
  applyMembershipRoleEffects,
  bumpUserSessionGeneration,
} from "@/lib/api/organizations/membership-transitions";
import { notifyOrgInviteAccepted } from "@/lib/novu/org-workflows";

const AcceptBodySchema = z.object({
  invitationId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;

  const raw = await req.json().catch(() => null);
  const parsed = AcceptBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { invitationId } = parsed.data;

  // Verify the invitation against the authenticated user's email before
  // doing anything mutative. Preventing accept-by-id-guessing means a
  // stolen URL from a user's inbox still can't be redeemed by someone
  // else's account.
  const invitation = await prisma.invitation.findUnique({
    where: { id: invitationId },
    select: {
      id: true,
      organizationId: true,
      email: true,
      role: true,
      status: true,
      expiresAt: true,
    },
  });
  if (!invitation) {
    return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  }
  // Closure-friendly non-null alias. TS doesn't carry the
  // null-narrowed flow type into the inner `runAcceptTx` function
  // declaration below; binding to a fresh const preserves the
  // narrowed type for closure reads.
  const inv = invitation;
  if (inv.email.toLowerCase() !== auth.session.user.email.toLowerCase()) {
    return NextResponse.json(
      { error: "This invitation is not addressed to you" },
      { status: 403 },
    );
  }
  if (inv.expiresAt.getTime() < Date.now()) {
    return NextResponse.json(
      { error: "Invitation has expired" },
      { status: 410 },
    );
  }

  // Narrow the stored string to a MemberRole. BetterAuth's Invitation
  // table stores role as a free-form string, so validate before using.
  const roleResult = MemberRoleSchema.safeParse(inv.role);
  if (!roleResult.success) {
    return NextResponse.json(
      { error: `Unknown invitation role: ${inv.role}` },
      { status: 400 },
    );
  }
  const normalizedRole = roleResult.data;

  const userId = auth.session.user.id;

  // #701 — DPDP: the invitee must hold live core-processing consent before we
  // provision membership (which processes their PII on the org's behalf).
  // Everyone gets PRIMARY_PROCESSING at signup; a withdrawal blocks acceptance
  // until re-granted. TODO(#701): offer an inline grant step in the accept UI.
  if (
    !(await checkConsent({
      userId,
      purposeCode: PURPOSE_CODES.PRIMARY_PROCESSING,
    }))
  ) {
    return NextResponse.json(
      {
        error:
          "Consent required to join an organization. Restore data-processing consent in your privacy settings, then accept again.",
        code: "CONSENT_REQUIRED",
      },
      { status: 403 },
    );
  }

  // ENT-5: A second concurrent accept for the same (user, org) pair can
  // race past the in-tx existence check and hit P2002 on Membership's
  // (userId, organizationId) unique. Retry once: the second attempt will
  // see the row created by the winner and fall into the alreadyMember
  // idempotent branch. Bound the retry to keep this from masking real
  // bugs.
  const MAX_ATTEMPTS = 2;
  let lastErr: unknown;
  let result:
    | Awaited<ReturnType<typeof runAcceptTx>>
    | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      result = await runAcceptTx();
      lastErr = undefined;
      break;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002" &&
        attempt < MAX_ATTEMPTS
      ) {
        lastErr = err;
        continue;
      }
      lastErr = err;
      break;
    }
  }
  if (!result) {
    if (lastErr instanceof Error && "httpStatus" in lastErr) {
      const status =
        typeof lastErr.httpStatus === "number" ? lastErr.httpStatus : 500;
      return NextResponse.json({ error: lastErr.message }, { status });
    }
    throw lastErr ?? new Error("Invitation accept failed for unknown reason");
  }

  // Side-effect: notify the org's operator roster that someone new
  // joined. Skip when the caller was already a member — the "accept"
  // button was just idempotent, nothing newsworthy happened.
  if (!result.alreadyMember) {
    const origin = new URL(req.url).origin;
    notifyOrgInviteAccepted(result.organization.id, {
      accepteeName: auth.session.user.name ?? auth.session.user.email,
      accepteeEmail: auth.session.user.email,
      orgName: result.organization.name,
      role: result.membership.role,
      dashboardUrl: `${origin}/dashboard/organization/${result.organization.id}/members`,
    }).catch((err) =>
      console.error("[notifyOrgInviteAccepted] failed:", err),
    );
  }

  // Client contract (app/organizations/invite/[token]/page.tsx): expects
  //   { organization: { id, name }, role?: string, alreadyMember?: boolean }
  // so it can redirect to /dashboard/organization/:id/home after accept.
  // Returning a bare `{ membership }` silently broke the redirect.
  return NextResponse.json(
    {
      organization: result.organization,
      role: result.membership.role,
      alreadyMember: result.alreadyMember,
      membership: result.membership,
    },
    { status: result.alreadyMember ? 200 : 201 },
  );

  async function runAcceptTx() {
    return prisma.$transaction(async (tx) => {
      // Atomic claim — only the first concurrent accept wins. Follow-up
      // retries get count=0 and fall into the 409 branch below.
      const claim = await tx.invitation.updateMany({
        where: { id: invitationId, status: "pending" },
        data: { status: "accepted", userId },
      });
      if (claim.count === 0) {
        throw Object.assign(
          new Error("Invitation is no longer pending"),
          { httpStatus: 409 },
        );
      }

      // Re-fetch org status inside the tx so a SUSPENDED/DEACTIVATED org
      // can't be onboarded into via a stale invite link. The pre-check
      // outside the tx is not enough — an admin could suspend the org
      // mid-flight between the email click and the POST.
      const org = await tx.organization.findUnique({
        where: { id: inv.organizationId },
        select: { id: true, name: true, status: true },
      });
      if (!org) {
        throw Object.assign(
          new Error("Organization no longer exists"),
          { httpStatus: 404 },
        );
      }
      if (isOnboardingBlocked(org.status)) {
        throw Object.assign(
          new Error(
            `Organization is ${org.status.toLowerCase()}; cannot accept new members`,
          ),
          { httpStatus: 403 },
        );
      }

      // User may already have a Membership in this org from a direct
      // admin add or an SSO auto-join. Idempotent upsert keeps the
      // UI's "accept" button safe to click twice.
      const existing = await tx.membership.findUnique({
        where: {
          userId_organizationId: {
            userId,
            organizationId: inv.organizationId,
          },
        },
      });
      if (existing) {
        return { membership: existing, organization: org, alreadyMember: true };
      }

      // #729 §AC4/AC5 + #819 — who-is-acting identity rule. Accepting an
      // invitation is the USER'S OWN consenting action, so the lightweight
      // ConsulteeProfile may be lazy-created here (lib/auth.ts names
      // "invite-accept as LEARNER" as a sanctioned creation point — gating
      // it broke sponsored-employee onboarding). EXPERT stays strict: a
      // consultant identity carries domain/rates/verification/payout
      // prerequisites that no invite click can substitute for. Admin
      // direct-add (POST /members) stays strict for BOTH roles, and SSO
      // JIT keeps its own lazy path.
      if (normalizedRole === "EXPERT") {
        const existingConsultant = await tx.consultantProfile.findUnique({
          where: { userId },
          select: { id: true },
        });
        if (!existingConsultant) {
          throw Object.assign(
            new Error("NOT_A_CONSULTANT"),
            { httpStatus: 400 },
          );
        }
      }

      // Profile FK + payoutRecipient defaults are computed by the
      // shared helper (see lib/api/organizations/membership-transitions.ts).
      // LEARNER lazy-creates ConsulteeProfile (first consumer action).
      // Operator roles (OWNER/MAINTAINER/MANAGER/SUPPORT) leave both FKs
      // null. The EXPERT pre-check above means the helper never reaches
      // its EXPERT lazy-create branch from this surface. Multi-org experts
      // and learners stay first-class; see
      // docs/enterprise/60-scenarios-and-verdicts/01-scenarios-and-examples.md.
      const roleEffects = await applyMembershipRoleEffects(tx, {
        userId,
        role: normalizedRole,
      });

      // BetterAuth Member row is kept for org-scoped session flows.
      // Membership.betterAuthMemberId preserves the linkage even after
      // BetterAuth's own adapter writes are done.
      const betterAuthMember = await tx.member.create({
        data: {
          organizationId: inv.organizationId,
          userId,
          // BetterAuth's Member.role is a free-form string; we write the
          // typed MemberRole value here so third-party tools that read
          // the BetterAuth table see the correct role.
          role: normalizedRole,
        },
      });

      const created = await tx.membership.create({
        data: {
          userId,
          organizationId: inv.organizationId,
          role: normalizedRole,
          status: "ACTIVE",
          consulteeProfileId: roleEffects.consulteeProfileId,
          consultantProfileId: roleEffects.consultantProfileId,
          payoutRecipient: roleEffects.payoutRecipient,
          betterAuthMemberId: betterAuthMember.id,
        },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: inv.organizationId,
          actorMembershipId: created.id,
          targetMembershipId: created.id,
          category: "MEMBER",
          action: AUDIT_ACTIONS.MEMBER.INVITE_ACCEPTED,
          description: `User ${userId} accepted invitation to join as ${normalizedRole}`,
          details: { invitationId: inv.id, role: normalizedRole },
        },
      });

      // Bump the user's session-generation marker so the next request
      // through customSession picks up the new org membership without
      // waiting for BetterAuth's 24h session-rotation window. The
      // accepter sees the org in their sidebar / org-switcher on the
      // next page load instead of after a manual logout. Audit B.5.
      await bumpUserSessionGeneration(tx, userId);

      return { membership: created, organization: org, alreadyMember: false };
    });
  }
}
