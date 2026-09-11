/**
 * GET    /api/organizations/[orgId]/members
 * POST   /api/organizations/[orgId]/members
 *
 * The single members endpoint subsumes the old /consultants and /learners
 * views — callers pass `?role=EXPERT` or `?role=LEARNER` to filter. Also
 * accepts a comma-separated role list (`?role=EXPERT,LEARNER`) for the
 * union case, plus `status` / `departmentLabel` / `q` / pagination.
 *
 * Everything is parsed through Zod. Runtime narrowing never relies on
 * `as` assertions.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { MemberRoleSchema } from "@/lib/labels/org-labels";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import {
  isAtLeastRole,
} from "@/lib/auth/role-ranks";
import type { MemberRole, MemberStatus } from "@prisma/client";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";
import { isBlockedRoleTransition } from "@/lib/enterprise/role-transitions";
import { transitionMembership } from "@/lib/enterprise/transitions";
import {
  applyMembershipRoleEffects,
  bumpUserSessionGeneration,
} from "@/lib/api/organizations/membership-transitions";

// #817 — the canonical full-enum Zod mirror lives in org-labels; the local
// duplicate here drifted (BILLING_ADMIN went missing), so import it instead.

const MemberStatusSchema = z.enum(["PENDING", "ACTIVE", "SUSPENDED", "REMOVED"]);

/**
 * Accepts a string like "EXPERT" or "EXPERT,LEARNER" and returns the
 * narrowed list. Empty/invalid → undefined (no filter applied).
 */
function parseRoleFilter(raw: string | null): MemberRole[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const parsed: MemberRole[] = [];
  for (const p of parts) {
    const result = MemberRoleSchema.safeParse(p);
    if (result.success) parsed.push(result.data);
  }
  return parsed.length ? parsed : undefined;
}

function parseStatusFilter(raw: string | null): MemberStatus[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const parsed: MemberStatus[] = [];
  for (const p of parts) {
    const result = MemberStatusSchema.safeParse(p);
    if (result.success) parsed.push(result.data);
  }
  return parsed.length ? parsed : undefined;
}

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  // members.read (OWNER/MAINTAINER/MANAGER/SUPPORT) — the roster is an
  // operator surface. The old `|| finance` branch admitted BILLING_ADMIN,
  // contradicting its operator-blind role design; the consent member-picker
  // it served is itself consent.read-gated (no BILLING_ADMIN) now.
  const access = await requireOrgAccess(orgId, { permission: "members.read" });
  if (access.error) return access.error;

  const url = new URL(req.url);
  const roles = parseRoleFilter(url.searchParams.get("role"));
  const statuses = parseStatusFilter(url.searchParams.get("status"));
  const departmentLabel =
    url.searchParams.get("departmentLabel")?.trim() || undefined;
  const q = url.searchParams.get("q")?.trim() || undefined;
  const parsedPagination = ListQuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!parsedPagination.success) {
    return NextResponse.json(
      { error: "Invalid pagination", detail: parsedPagination.error.flatten() },
      { status: 400 },
    );
  }
  const { page, perPage } = parsedPagination.data;

  // Query-param-driven filter; role and status accept lists so the same
  // endpoint serves the sidebar filters (?role=LEARNER) and consultants
  // management (?role=EXPERT&status=ACTIVE) without new routes.
  const where = {
    organizationId: orgId,
    ...(roles && { role: { in: roles } }),
    ...(statuses && { status: { in: statuses } }),
    ...(departmentLabel && { departmentLabel }),
    ...(q && {
      user: {
        OR: [
          { name: { contains: q, mode: "insensitive" as const } },
          { email: { contains: q, mode: "insensitive" as const } },
        ],
      },
    }),
  };

  const [total, data] = await prisma.$transaction([
    prisma.membership.count({ where }),
    prisma.membership.findMany({
      where,
      include: {
        user: {
          select: { id: true, name: true, email: true, image: true },
        },
        // ConsultantProfile + ConsulteeProfile are 1:1 optionals. Always
        // including them here means the consultants page gets
        // `headline / rating / isVerified` in one round-trip without
        // needing a separate /consultants endpoint.
        consultantProfile: {
          select: {
            id: true,
            headline: true,
            rating: true,
            isVerified: true,
          },
        },
        consulteeProfile: {
          select: { id: true },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  return NextResponse.json({
    data,
    meta: { total, page, perPage },
  });
}

/**
 * Direct-add a member by email (dashboard path) or userId
 * (SSO auto-provisioning / admin tooling). Exactly one of the two
 * identifiers must be present; the server resolves email → userId
 * and returns 404 USER_NOT_FOUND when the account doesn't exist.
 */
const CreateBodySchema = z
  .object({
    userId: z.string().min(1).optional(),
    email: z.string().email().optional(),
    role: MemberRoleSchema,
    departmentLabel: z.string().max(100).optional().nullable(),
  })
  .refine((v) => !!(v.userId || v.email), {
    message: "userId or email is required",
  })
  .refine((v) => !(v.userId && v.email), {
    message: "Provide userId OR email, not both",
  });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  // Mirrors the /invitations guard: pre-verification we block direct-add
  // too, otherwise the banner promise ("inviting members unlocks once
  // verified") is misleading. SSO auto-provisioning goes through the
  // session.create hook, not this route, so it is unaffected.
  const access = await requireOrgAccess(orgId, {
    minimumRole: "MAINTAINER",
    requireActive: true,
  });
  if (access.error) return access.error;

  const bodyRaw = await req.json().catch(() => null);
  const parsed = CreateBodySchema.safeParse(bodyRaw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { userId: providedUserId, email, role, departmentLabel } = parsed.data;

  // OWNER role gate (#789): only an OWNER can mint another OWNER. This is the
  // same guard the members PATCH route applies; without it a MAINTAINER could
  // direct-add an ACTIVE OWNER and grant themselves the security-sensitive
  // surface (billing, deletion, ownership transfer, SSO/SCIM) by proxy.
  if (role === "OWNER" && !isAtLeastRole(access.member.role, "OWNER")) {
    return NextResponse.json(
      {
        error: "Only an OWNER can assign the OWNER role",
        code: "OWNER_ROLE_REQUIRES_OWNER",
      },
      { status: 403 },
    );
  }

  // EXPERT requires the org to actually host consultants — otherwise
  // there's no rate card / payout account to settle their earnings.
  // Mirrors the gate in app/api/organizations/[orgId]/invitations/route.ts.
  if (role === "EXPERT" && !access.org.canHost) {
    return NextResponse.json(
      {
        error: "EXPERT can only be assigned on host-capable organizations",
        code: "EXPERT_REQUIRES_CANHOST",
      },
      { status: 400 },
    );
  }

  // LEARNER mirrors EXPERT: requires the org to actually sponsor sessions.
  // Host-only orgs have no Contract / Program / Wallet / BillingAccount
  // path, so a LEARNER membership would be a hollow shell with no funded
  // bookings and a blank /my-program. Reject at the boundary.
  if (role === "LEARNER" && !access.org.canSponsor) {
    return NextResponse.json(
      {
        error: "LEARNER can only be assigned on sponsor-capable organizations",
        code: "LEARNER_REQUIRES_CANSPONSOR",
      },
      { status: 400 },
    );
  }

  // The dashboard sends email; SSO / admin tooling sends userId. Profile
  // FK hydration is handled inside the transaction below by
  // applyMembershipRoleEffects (lazy-creates ConsulteeProfile /
  // ConsultantProfile when needed for LEARNER / EXPERT).
  const user = providedUserId
    ? await prisma.user.findUnique({
        where: { id: providedUserId },
        select: { id: true },
      })
    : await prisma.user.findUnique({
        where: { email: email!.toLowerCase() },
        select: { id: true },
      });
  if (!user) {
    return NextResponse.json({ error: "USER_NOT_FOUND" }, { status: 404 });
  }
  const userId = user.id;

  // #729 §AC4/AC5 + #819 — who-is-acting identity rule. Direct-add is an
  // ADMIN acting on someone else, so BOTH roles require a pre-existing
  // profile: the shared `applyMembershipRoleEffects` helper would
  // otherwise lazy-create one and silently promote a stranger to a
  // consultant / consumer identity they never asked for. Contrast
  // invitation-accept, where the LEARNER gate is deliberately absent —
  // accepting is the user's OWN consenting click, so the lightweight
  // ConsulteeProfile lazy-creates there (EXPERT stays strict on every
  // surface). SSO JIT auto-join keeps its lazy path as a separate
  // provisioning channel with its own authorization layer. The
  // who-is-acting pins in __tests__/enterprise/invitation-accept.test.ts
  // keep the three surfaces from drifting apart.
  if (role === "EXPERT") {
    const existingConsultant = await prisma.consultantProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!existingConsultant) {
      return NextResponse.json(
        { error: "NOT_A_CONSULTANT" },
        { status: 400 },
      );
    }
  }
  if (role === "LEARNER") {
    const existingConsultee = await prisma.consulteeProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!existingConsultee) {
      return NextResponse.json(
        { error: "NOT_A_CONSULTEE" },
        { status: 400 },
      );
    }
  }

  // Idempotency: a duplicate POST for a currently-active (or pending/
  // suspended) member is a conflict. A REMOVED row is *not* a conflict —
  // that path flips the existing row back to ACTIVE instead of 409'ing
  // (so re-adding someone who was off-boarded doesn't require cleaning up
  // the tombstone first).
  const existing = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId: orgId } },
    select: { id: true, status: true, role: true },
  });

  if (existing && existing.status !== "REMOVED") {
    return NextResponse.json(
      { error: "User is already a member of this organization" },
      { status: 409 },
    );
  }

  let membership;
  try {
    membership = await prisma.$transaction(async (tx) => {
    // Profile FK + payoutRecipient defaults from the shared helper. The
    // helper lazy-creates a ConsulteeProfile (LEARNER) or
    // ConsultantProfile (EXPERT) inside the same tx if the user does
    // not already have one, so direct-add stays consistent with
    // invitations/accept and SSO auto-join.
    const roleEffects = await applyMembershipRoleEffects(tx, {
      userId,
      role,
    });
    if (existing) {
      // Reactivation keeps the same Membership row (preserves downstream
      // FKs on ProgramAssignment / audit trail). That means the LEARNER
      // <-> EXPERT boundary applies here too: a previously-LEARNER user
      // can't be re-added as EXPERT on the same Membership. They need a
      // brand-new Membership, which (given we soft-delete rather than
      // hard-delete) effectively means they can't swap roles inside
      // this org.
      if (
        existing.status === "REMOVED" &&
        isBlockedRoleTransition(existing.role, role)
      ) {
        throw Object.assign(
          new Error("ROLE_TRANSITION_BLOCKED"),
          { httpStatus: 409 },
        );
      }

      // REMOVED → ACTIVE reactivation. Keep the same membership row so
      // downstream FKs (ProgramAssignment, audit trail, etc.) stay intact.
      // Routed through the central FSM (#1132 follow-up): its CAS where-clause
      // refuses ERASED rows, so a tombstone can never be resurrected even if
      // the pre-transaction `existing` read above went stale concurrently
      // with an erasure run. Throws IllegalTransitionError (409) on loss.
      await transitionMembership(tx, {
        to: "ACTIVE",
        where: { id: existing.id, organizationId: orgId },
        data: {
          role,
          departmentLabel: departmentLabel ?? null,
          consulteeProfileId: roleEffects.consulteeProfileId,
          consultantProfileId: roleEffects.consultantProfileId,
          payoutRecipient: roleEffects.payoutRecipient,
        },
      });
      const reactivated = await tx.membership.findUniqueOrThrow({
        where: { id: existing.id },
      });
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          targetMembershipId: reactivated.id,
          category: "MEMBER",
          action: AUDIT_ACTIONS.MEMBER.MEMBER_REACTIVATED,
          description: `Reactivated ${userId} as ${role}`,
          details: { role, departmentLabel: departmentLabel ?? null },
        },
      });
      await bumpUserSessionGeneration(tx, userId);
      return reactivated;
    }

    const created = await tx.membership.create({
      data: {
        userId,
        organizationId: orgId,
        role,
        status: "ACTIVE",
        departmentLabel: departmentLabel ?? null,
        consulteeProfileId: roleEffects.consulteeProfileId,
        consultantProfileId: roleEffects.consultantProfileId,
        payoutRecipient: roleEffects.payoutRecipient,
      },
    });
    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        targetMembershipId: created.id,
        category: "MEMBER",
        action: AUDIT_ACTIONS.MEMBER.MEMBER_ADDED,
        description: `Added ${userId} as ${role}`,
        details: { role, departmentLabel: departmentLabel ?? null },
      },
    });
    // Bump the user's session-generation marker so the next request
    // through customSession refetches and includes this new org
    // membership without waiting for BetterAuth's 24h session rotation.
    // Audit Phase B.5.
    await bumpUserSessionGeneration(tx, userId);

    // Outbound webhook: notify subscribed integrations (HRIS sync,
    // customer-success tools, ERP). The dispatch helper inserts
    // delivery rows on the SAME transaction so if this whole block
    // rolls back, the webhook rows roll back too — the receiver only
    // sees a member.added event for memberships that actually committed.
    await dispatchWebhookEvent({
      prisma: tx,
      organizationId: orgId,
      eventType: "member.added",
      payload: {
        membershipId: created.id,
        userId,
        role,
        departmentLabel: departmentLabel ?? null,
      },
    });
    return created;
    });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
    throw err;
  }

  return NextResponse.json(
    { membership },
    { status: existing ? 200 : 201 },
  );
}
