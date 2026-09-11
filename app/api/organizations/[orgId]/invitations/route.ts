/**
 * GET  /api/organizations/[orgId]/invitations
 * POST /api/organizations/[orgId]/invitations
 *
 * Backed by BetterAuth's `Invitation` table — we keep the invitation
 * token lifecycle inside BetterAuth so the accept flow can verify the
 * token natively. The typed `Membership` row is created separately at
 * accept time (see /api/organizations/invitations/accept/route.ts).
 *
 * Self-service cannot invite into EXPERT or SUPPORT roles. EXPERT
 * requires canHost=true and the apply flow, SUPPORT is assigned from
 * Settings by an OWNER. The guard lives in the Zod schema.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HostInvitableMemberRoleSchema } from "@/lib/labels/org-labels";
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { isAtLeastRole } from "@/lib/auth/role-ranks";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  DomainVerificationRequiredError,
  hasVerifiedDomain,
  UNVERIFIED_ORG_SEAT_CAP,
} from "@/lib/enterprise/governance";
import { notifyOrgInviteSent } from "@/lib/novu/org-workflows";
import { applyRateLimit, orgInviteLimiter } from "@/lib/rate-limit";
import { withSerializableRetry } from "@/lib/db/serializable-retry";

// #817 — the canonical invitable set lives in org-labels; a local duplicate
// here drifted (BILLING_ADMIN went missing) so the route now imports it.
// EXPERT is gated by canHost below; SUPPORT stays owner-only (Settings).

const InviteBodySchema = z.object({
  email: z.string().email(),
  role: HostInvitableMemberRoleSchema,
  // Default expiry: 14 days. Overridable up to 30 to avoid long-lived
  // invite tokens sitting in inboxes indefinitely.
  expiresInDays: z.coerce.number().int().min(1).max(30).default(14),
});

const StatusFilterSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
  "expired",
  "canceled",
]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MAINTAINER");
  if (access.error) return access.error;

  const url = new URL(req.url);
  const rawStatus = url.searchParams.get("status");
  const status = rawStatus
    ? StatusFilterSchema.safeParse(rawStatus)
    : null;

  const invitations = await prisma.invitation.findMany({
    where: {
      organizationId: orgId,
      ...(status?.success ? { status: status.data } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      expiresAt: true,
      createdAt: true,
      inviterId: true,
    },
  });

  return NextResponse.json({ data: invitations });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  // Invitations require an operable org, but NOT a verified one:
  // #1132 follow-up — this route was hard-gated on ACTIVE, which made the
  // UNVERIFIED_ORG_SEAT_CAP grace (enforced in-tx below) unreachable dead
  // code. The creation wizard fires team invites seconds after creating a
  // PENDING_VERIFICATION org and every one of them 409'd ORG_NOT_VERIFIED,
  // poisoning the launch moment for every self-serve org. Pre-verification
  // orgs may now invite up to the seat cap; SUSPENDED / DEACTIVATED orgs
  // stay blocked by the explicit check here.
  const access = await requireOrgAccess(orgId, {
    minimumRole: "MAINTAINER",
    // requireActive deliberately omitted: it is a `true`-literal opt-in flag,
    // and pre-verification invites are exactly what we want here (the seat
    // cap below owns the PENDING_VERIFICATION policy; SUSPENDED/DEACTIVATED
    // are refused explicitly above).
  });
  if (access.error) return access.error;
  // SUSPENDED-only: requireOrgAccess already answers 403 for DEACTIVATED
  // before this handler ever sees `access` (CR #1234 — the deactivated arm
  // here was unreachable dead code).
  if (access.org.status === "SUSPENDED") {
    return NextResponse.json(
      {
        error: "ORG_NOT_ACTIVE",
        message: "Invitations are paused while the organization is suspended.",
        status: access.org.status,
      },
      { status: 409 },
    );
  }

  // Per-org sliding-window cap: 20 invitations per hour. Keyed on orgId
  // (not IP) so a credential-stuffing attacker that rotates IPs still
  // trips the limit. Prevents audit-log and Novu notification spam.
  const rateLimited = await applyRateLimit(orgInviteLimiter, orgId);
  if (rateLimited) return rateLimited;

  const raw = await req.json().catch(() => null);
  const parsed = InviteBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { role, expiresInDays } = parsed.data;
  // Normalize before any read or write: the accept flow compares lowercased
  // emails and the sidecar unique index dedups on lower(email), so a
  // mixed-case duplicate must not slip past the pre-check or the insert.
  const email = parsed.data.email.trim().toLowerCase();

  // OWNER role gate (#789): only an OWNER can invite another OWNER. Without it
  // a MAINTAINER could invite an OWNER and, once accepted, gain the
  // security-sensitive surface by proxy — the same hole the members PATCH route
  // already closes. The accept route trusts the invitation's stored role, so
  // the check has to live here at invite time.
  if (role === "OWNER" && !isAtLeastRole(access.member.role, "OWNER")) {
    return NextResponse.json(
      {
        error: "Only an OWNER can invite a member as OWNER",
        code: "OWNER_ROLE_REQUIRES_OWNER",
      },
      { status: 403 },
    );
  }

  // EXPERT is only valid for orgs that host consultants. Sponsor-only
  // orgs have no payout account / RateCard / settlement path for an
  // EXPERT's earnings, so the role is rejected even if a stale
  // dashboard payload smuggles it through. Returning the typed code
  // lets humanizeOrgError surface a precise message.
  if (role === "EXPERT" && !access.org.canHost) {
    return NextResponse.json(
      {
        error: "EXPERT can only be assigned on host-capable organizations",
        code: "EXPERT_REQUIRES_CANHOST",
      },
      { status: 400 },
    );
  }

  // LEARNER mirrors EXPERT: host-only orgs have no Contract / Program /
  // Wallet to fund the learner's sessions, so the role is rejected at
  // the invite boundary. Same defence-in-depth pattern.
  if (role === "LEARNER" && !access.org.canSponsor) {
    return NextResponse.json(
      {
        error: "LEARNER can only be assigned on sponsor-capable organizations",
        code: "LEARNER_REQUIRES_CANSPONSOR",
      },
      { status: 400 },
    );
  }

  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

  // De-dupe active invitations by (orgId, email). An inviter retrying
  // from the UI shouldn't spawn two tokens that both resolve to the
  // same membership — the second POST extends the expiry instead.
  //
  // The findFirst → create/update sequence is wrapped in a Serializable
  // tx because two concurrent POSTs against the same (orgId, email) would
  // otherwise both observe `existing = null` under the default Read
  // Committed isolation and both INSERT, leaving two pending rows.
  //
  // The invariant is also DB-enforced (#747/#685): a partial unique index
  // on (organizationId, lower(email)) WHERE status='pending' lives in
  // prisma/sql/check-constraints.sql. The Serializable tx stays as the
  // first line so the common case returns the typed 409 instead of a
  // surfaced P2002.
  let wasExisting = false;
  let invitation;
  try {
    // #1132 follow-up — the tx below assumed a retry budget that never
    // existed; a P2034 abort surfaced as a raw 500 to the invite sender.
    // Transient serialization failures now retry via the house helper.
    invitation = await withSerializableRetry(() =>
      prisma.$transaction(
      async (tx) => {
        const existing = await tx.invitation.findFirst({
          where: {
            organizationId: orgId,
            email,
            status: "pending",
          },
        });
        wasExisting = !!existing;

        // PR-1d / #675: an unverified org may onboard a small founding
        // team but is hard-capped until at least one OrgDomainClaim is
        // verified. Skip the gate for re-invites (the seat is already
        // counted in the active+pending sum from the original send).
        if (!existing) {
          const verified = await hasVerifiedDomain(tx, orgId);
          if (!verified) {
            const [activeMembers, pendingInvites] = await Promise.all([
              tx.membership.count({
                where: { organizationId: orgId, status: "ACTIVE" },
              }),
              tx.invitation.count({
                where: { organizationId: orgId, status: "pending" },
              }),
            ]);
            if (activeMembers + pendingInvites >= UNVERIFIED_ORG_SEAT_CAP) {
              throw new DomainVerificationRequiredError("BULK_SEATS");
            }
          }
        }

        const token = existing?.id ?? crypto.randomUUID();
        const record = existing
          ? await tx.invitation.update({
              where: { id: existing.id },
              data: { role, expiresAt },
            })
          : await tx.invitation.create({
              data: {
                id: token,
                organizationId: orgId,
                email,
                role,
                status: "pending",
                expiresAt,
                inviterId: access.session.user.id,
              },
            });

        await tx.orgAuditLog.create({
          data: {
            organizationId: orgId,
            actorMembershipId: access.member.id,
            category: "MEMBER",
            action: existing
              ? AUDIT_ACTIONS.MEMBER.INVITE_RESENT
              : AUDIT_ACTIONS.MEMBER.INVITE_SENT,
            description: `${existing ? "Re-sent" : "Sent"} invite to ${email} as ${role}`,
            details: { email, role, expiresAt: expiresAt.toISOString() },
          },
        });

        return record;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  } catch (err) {
    if (err instanceof DomainVerificationRequiredError) {
      return NextResponse.json(
        {
          error: `Verify a domain to invite more than ${UNVERIFIED_ORG_SEAT_CAP} members`,
          code: err.code,
        },
        { status: err.httpStatus },
      );
    }
    // P2002 from a future partial unique index would land here; today
    // we hit it only if the Serializable retry budget exhausts. Convert
    // to 409 so the client can simply re-render the existing invitation.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return NextResponse.json(
        {
          error: "Pending invitation already exists for this email",
          code: "INVITATION_EXISTS",
        },
        { status: 409 },
      );
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "organizations" } });
    throw err;
  }

  // Side-effect: trigger Novu email delivery to the invitee. Non-blocking
  // — on failure we still return the invitation response. The existing
  // email-send flow (lib/email.ts / Resend) continues to run; Novu is
  // additive so in-app bell delivery works once the invitee has a user
  // account.
  const origin = new URL(req.url).origin;
  notifyOrgInviteSent(email, {
    inviterName: access.session.user.name ?? access.session.user.email,
    orgName: access.org.name,
    role,
    inviteUrl: `${origin}/organizations/invite/${invitation.id}`,
    expiresAt: expiresAt.toISOString(),
  }).catch((err) => {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "organizations" } });
    console.error("[notifyOrgInviteSent] failed:", err);
  });

  return NextResponse.json({ invitation }, { status: wasExisting ? 200 : 201 });
}
