import { getSession } from "@/lib/auth-server";
import { NextResponse } from "next/server";
import type { Session } from "@/lib/auth";
import prisma from "@/lib/prisma";
import type {
  FundingSource,
  Organization,
  Membership,
  MemberRole,
  UserRole,
} from "@prisma/client";
import {
  hasBackofficePermission,
  type BackofficeSurface,
} from "@/lib/auth/backoffice-permissions";

/**
 * Requires API authentication and returns the session or an error response.
 * Use this at the start of protected API route handlers.
 *
 * Always reads force-fresh, and there is deliberately no opt-out. Session
 * revocation is invisible to a cached read, and `session.user.role` comes from
 * the cookie payload — ~86 call sites branch on that role directly (e.g. the
 * ADMIN gate on DELETE /api/bookings/subscriptions/[id]), so a stale read
 * honours a demotion up to 5 minutes late. The cookie cache would save roughly
 * one query in four anyway, because customSession re-runs its enrichment on
 * every call regardless.
 */
export async function requireApiAuth(): Promise<
  { session: Session; error?: never } | { session?: never; error: NextResponse }
> {
  const session = await getSession(true);
  if (!session?.user?.id) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  // #693 defense-in-depth — ban-time session deletion + the sign-in gate
  // cover the normal paths; this catches a session minted in the race window.
  if (session.user.banned === true) {
    return {
      error: NextResponse.json({ error: "Account suspended" }, { status: 403 }),
    };
  }
  return { session };
}

/**
 * Checks if a user has privileged access (ADMIN or STAFF role).
 *
 * Prefer the typed helpers below in API handlers — this is here for
 * places that just need a boolean branch (e.g., conditional DB queries).
 */
export function isPrivileged(role: string | undefined | null): boolean {
  return role === "ADMIN" || role === "STAFF";
}

/**
 * Strict ADMIN-only auth — for routes that mutate platform-level state
 * irreversibly (system jobs, maintenance mode, exchange rates, newsletters,
 * payouts processing). Replaces ad-hoc inline `requireAdmin()` helpers
 * scattered across `app/api/admin/**`.
 *
 * @see docs/api/auth-helpers.md for the decision matrix.
 */
export async function requireAdminAuth(): Promise<
  { session: Session; error?: never } | { session?: never; error: NextResponse }
> {
  const auth = await requireApiAuth();
  if (auth.error) return { error: auth.error };
  if (auth.session.user.role !== "ADMIN") {
    return {
      error: NextResponse.json(
        { error: "Forbidden — admin access required" },
        { status: 403 },
      ),
    };
  }
  return { session: auth.session };
}

/**
 * Strict STAFF-only auth — rejects ADMIN.
 *
 * Use for routes that are specifically staff-scoped and where an ADMIN
 * should NOT have access (e.g., "my support tickets" viewed by the staff
 * member who owns them, separated from admin's own views). This is
 * deliberately strict — most admin/staff routes want the PRIVILEGED
 * flavor below. If you're refactoring a route that previously allowed
 * both ADMIN and STAFF, use `requirePrivilegedAuth` instead.
 */
export async function requireStaffAuth(): Promise<
  { session: Session; error?: never } | { session?: never; error: NextResponse }
> {
  const auth = await requireApiAuth();
  if (auth.error) return { error: auth.error };
  if (auth.session.user.role !== "STAFF") {
    return {
      error: NextResponse.json(
        { error: "Forbidden — staff access required" },
        { status: 403 },
      ),
    };
  }
  return { session: auth.session };
}

/**
 * Privileged operator auth — ADMIN or STAFF. Use for read endpoints,
 * moderation queues, support operations, and the shared admin/staff
 * dashboard API surface. This is the most common helper for
 * `app/api/admin/**` and `app/api/staff/**` routes.
 *
 * @see docs/api/auth-helpers.md for the decision matrix.
 */
export async function requirePrivilegedAuth(): Promise<
  { session: Session; error?: never } | { session?: never; error: NextResponse }
> {
  const auth = await requireApiAuth();
  if (auth.error) return { error: auth.error };
  if (!isPrivileged(auth.session.user.role)) {
    return {
      error: NextResponse.json(
        { error: "Forbidden — admin or staff access required" },
        { status: 403 },
      ),
    };
  }
  return { session: auth.session };
}

/**
 * Surface-scoped back-office auth — the granular flavor of
 * `requirePrivilegedAuth`. Resolves the caller's UserRole against
 * `BACKOFFICE_PERMISSIONS`, so the API route, the page guard, and the
 * sidebar all agree on who may reach a surface.
 *
 * Prefer this over `requireAdminAuth` / `requireStaffAuth` on any route the
 * merged `/dashboard/admin` renders: those two only express "is this an
 * admin", which is why `admin/feedback` ended up calling `/api/staff/*` and
 * `staff/refunds` calling `/api/admin/*`. Pick the surface, not the role.
 *
 * @see lib/auth/backoffice-permissions.ts for the matrix and its rationale.
 */
export async function requireBackofficeSurface(
  surface: BackofficeSurface,
): Promise<
  { session: Session; error?: never } | { session?: never; error: NextResponse }
> {
  const auth = await requireApiAuth();
  if (auth.error) return { error: auth.error };

  const role = auth.session.user.role as UserRole | undefined;
  if (!role || !hasBackofficePermission(role, surface)) {
    return {
      error: NextResponse.json(
        { error: "Forbidden — insufficient back-office permissions" },
        { status: 403 },
      ),
    };
  }
  return { session: auth.session };
}

/**
 * Checks if the session user owns a resource based on their profile ID.
 * Returns true if the user's profile ID matches the resource owner ID.
 */
export function checkOwnership(
  session: Session,
  resourceOwnerId: string | null | undefined,
  profileType: "consultant" | "consultee" | "staff" | "admin",
): boolean {
  if (!resourceOwnerId) return false;

  const profileKeyMap = {
    consultant: "consultantProfileId",
    consultee: "consulteeProfileId",
    staff: "staffProfileId",
    admin: "adminProfileId",
  } as const;

  const profileKey = profileKeyMap[profileType];
  const userProfileId = session.user[profileKey];

  return userProfileId === resourceOwnerId;
}

/**
 * Checks if the session user is a participant in a consultation.
 * Returns true if they are either the consultant or consultee.
 */
export function isConsultationParticipant(
  session: Session,
  consultantProfileId: string | null | undefined,
  consulteeProfileId: string | null | undefined,
): boolean {
  const isConsultant = session.user.consultantProfileId === consultantProfileId;
  const isConsultee = session.user.consulteeProfileId === consulteeProfileId;
  return isConsultant || isConsultee;
}

/**
 * Creates a standardized 403 Forbidden response.
 */
export function forbiddenResponse(message = "Forbidden"): NextResponse {
  return NextResponse.json({ error: message }, { status: 403 });
}

/**
 * Creates a standardized 401 Unauthorized response.
 */
export function unauthorizedResponse(message = "Unauthorized"): NextResponse {
  return NextResponse.json({ error: message }, { status: 401 });
}

/**
 * Creates a standardized 422 Unprocessable Entity response.
 */
export function unprocessableResponse(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 422 });
}

/**
 * Authorize access to an event (consultation/subscription/webinar/class).
 * Checks if the session user is the consultant (plan owner), consultee (requester),
 * or has a privileged role (ADMIN/STAFF).
 *
 * @returns null if authorized, or a 403 NextResponse if not
 */
export async function authorizeEventAccess(
  session: Session,
  eventType: "consultation" | "subscription" | "webinar" | "class",
  eventId: string,
): Promise<NextResponse | null> {
  if (isPrivileged(session.user.role)) return null;

  const consultantProfileId = session.user.consultantProfileId;
  const consulteeProfileId = session.user.consulteeProfileId;

  let isAuthorized = false;

  if (eventType === "consultation") {
    const event = await prisma.consultation.findUnique({
      where: { id: eventId },
      select: {
        requestedById: true,
        consultationPlan: { select: { consultantProfileId: true } },
      },
    });
    if (event) {
      isAuthorized =
        consultantProfileId === event.consultationPlan.consultantProfileId ||
        consulteeProfileId === event.requestedById;
    }
  } else if (eventType === "subscription") {
    const event = await prisma.subscription.findUnique({
      where: { id: eventId },
      select: {
        requestedById: true,
        subscriptionPlan: { select: { consultantProfileId: true } },
      },
    });
    if (event) {
      isAuthorized =
        consultantProfileId === event.subscriptionPlan.consultantProfileId ||
        consulteeProfileId === event.requestedById;
    }
  } else if (eventType === "webinar") {
    const event = await prisma.webinar.findUnique({
      where: { id: eventId },
      select: {
        webinarPlan: { select: { id: true, consultantProfileId: true } },
      },
    });
    if (event) {
      isAuthorized =
        consultantProfileId === event.webinarPlan.consultantProfileId;
      if (!isAuthorized && consultantProfileId) {
        const collab = await prisma.collaborator.findFirst({
          where: {
            webinarPlanId: event.webinarPlan.id,
            consultantProfileId,
            status: "ACCEPTED",
          },
        });
        isAuthorized = !!collab;
      }
    }
  } else if (eventType === "class") {
    const event = await prisma.class.findUnique({
      where: { id: eventId },
      select: {
        classPlan: { select: { id: true, consultantProfileId: true } },
      },
    });
    if (event) {
      isAuthorized =
        consultantProfileId === event.classPlan.consultantProfileId;
      if (!isAuthorized && consultantProfileId) {
        const collab = await prisma.collaborator.findFirst({
          where: {
            classPlanId: event.classPlan.id,
            consultantProfileId,
            status: "ACCEPTED",
          },
        });
        isAuthorized = !!collab;
      }
    }
  }

  if (!isAuthorized) {
    return forbiddenResponse("You are not authorized to access this event");
  }

  return null;
}

// ============================================================================
// ORGANIZATION ACCESS HELPERS — Arch 4-Modified (Issue #681)
// ============================================================================

import { isAtLeastRole } from "@/lib/auth/role-ranks";
import { hasOrgPermission, type OrgSurface } from "@/lib/auth/org-permissions";

export type OrgAccessGrant = {
  session: Session;
  member: Membership;
  org: Organization;
};

/**
 * Capability gate for {@link requireOrgAccess}. All fields are optional;
 * any field that is set must match for the request to proceed.
 *
 * - `canSponsor: true` — require the org to sponsor bookings
 *   (BillingAccount present, sponsor-side APIs). A host-only org gets a
 *   404 (the page / API endpoint "doesn't exist" for that org shape).
 * - `canHost: true` — mirror for host-side APIs.
 * - `fundingSource` — require the org's BillingAccount to be in a
 *   specific funding mode. Used by WALLET-only endpoints like
 *   /billing-account/wallet. 404 on mismatch.
 */
export type OrgCapabilityGate = {
  minimumRole?: MemberRole;
  /**
   * Surface grant from the org permission matrix
   * (lib/auth/org-permissions.ts) — the preferred gate for surface access.
   * Unlike `minimumRole` it expresses the operations/finance track split
   * (SUPPORT reads operations; BILLING_ADMIN is operator-blind) that the
   * rank ladder cannot. Both may be set; both must pass.
   */
  permission?: OrgSurface;
  canSponsor?: true;
  canHost?: true;
  fundingSource?: FundingSource;
  /**
   * Require `Organization.status === "ACTIVE"`. A newly created org sits
   * in PENDING_VERIFICATION until a platform admin runs the verify action;
   * setting this on side-effecting routes (invite send, wallet top-up,
   * contract submit) keeps the graceful pre-verification UX while still
   * blocking spam surfaces. Returns 409 ORG_NOT_VERIFIED so the UI can
   * distinguish this from plain 403.
   */
  requireActive?: true;
};

/**
 * Require that the session user is an active Membership of the specified
 * organization.
 *
 * Accepts either a bare `MemberRole` (legacy single-arg callers) or an
 * options object that also enforces capability + funding-source gates.
 * Platform admins (`UserRole.ADMIN`) bypass membership + role checks and
 * get a synthesized OWNER-rank stub; capability checks still apply so
 * an admin hitting a WALLET-only endpoint on an INVOICE org still gets
 * the structural 404.
 */
export async function requireOrgAccess(
  organizationId: string,
  opts?: MemberRole | OrgCapabilityGate,
): Promise<({ error?: never } & OrgAccessGrant) | { error: NextResponse }> {
  const options: OrgCapabilityGate =
    typeof opts === "string" ? { minimumRole: opts } : (opts ?? {});
  const {
    minimumRole,
    permission,
    canSponsor,
    canHost,
    fundingSource,
    requireActive,
  } = options;

  const auth = await requireApiAuth();
  if (auth.error) return { error: auth.error };

  // Pull the billingAccount alongside the org so fundingSource gates
  // don't need a second round-trip. Non-capability callers pay the same
  // (cheap) cost — this read is LEFT JOIN one row keyed on a unique
  // index.
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: {
      billingAccount: {
        select: { id: true, fundingSource: true },
      },
    },
  });
  if (!org) {
    return {
      error: NextResponse.json(
        { error: "Organization not found" },
        { status: 404 },
      ),
    };
  }

  if (org.status === "DEACTIVATED") {
    return {
      error: NextResponse.json(
        { error: "Organization has been deactivated" },
        { status: 403 },
      ),
    };
  }

  if (requireActive && org.status !== "ACTIVE") {
    return {
      error: NextResponse.json(
        {
          error: "ORG_NOT_VERIFIED",
          message:
            "This action is paused until a platform admin verifies your organization.",
          status: org.status,
        },
        { status: 409 },
      ),
    };
  }

  // Capability guards are structural, not authorization — a host-only
  // org doesn't have sponsor APIs at all, so "404 not found" is the
  // honest response (rather than 403, which implies "you're allowed
  // elsewhere"). Mirrors how filesystems surface missing paths.
  if (canSponsor === true && !org.canSponsor) {
    return {
      error: NextResponse.json(
        { error: "This organization does not sponsor bookings" },
        { status: 404 },
      ),
    };
  }
  if (canHost === true && !org.canHost) {
    return {
      error: NextResponse.json(
        { error: "This organization does not host consultants" },
        { status: 404 },
      ),
    };
  }
  if (fundingSource && org.billingAccount?.fundingSource !== fundingSource) {
    return {
      error: NextResponse.json(
        {
          error: `This endpoint requires ${fundingSource} funding`,
          currentFundingSource: org.billingAccount?.fundingSource ?? null,
        },
        { status: 404 },
      ),
    };
  }

  const userId = auth.session.user.id;

  // Platform admins bypass org membership checks. Capability guards
  // above still apply so the admin gets the same structural 404 as a
  // regular user — the endpoint genuinely doesn't exist on that org.
  if (auth.session.user.role === "ADMIN") {
    const stub: Membership = {
      id: `__admin_stub_${userId}`,
      userId,
      organizationId: org.id,
      status: "ACTIVE",
      role: "OWNER",
      departmentLabel: null,
      consulteeProfileId: null,
      consultantProfileId: null,
      payoutRecipient: "SELF",
      rateCardOverrideId: null,
      exclusiveEngagement: false,
      betterAuthMemberId: null,
      // PR #655 SCIM addition — the stub satisfies the Membership type
      // by tracking every schema column. Admin sessions never have a
      // SCIM-provisioned identity by definition; nullable column.
      externalScimId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    return { session: auth.session, member: stub, org };
  }

  const member = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId: org.id } },
  });

  if (!member) {
    return {
      error: NextResponse.json(
        { error: "Not a member of this organization" },
        { status: 403 },
      ),
    };
  }

  if (member.status !== "ACTIVE") {
    return {
      error: NextResponse.json(
        { error: `Membership is ${member.status.toLowerCase()}` },
        { status: 403 },
      ),
    };
  }

  if (minimumRole && !isAtLeastRole(member.role, minimumRole)) {
    return {
      error: NextResponse.json(
        { error: `Forbidden — ${minimumRole} or higher required` },
        { status: 403 },
      ),
    };
  }

  if (permission && !hasOrgPermission(member.role, permission)) {
    return {
      error: NextResponse.json(
        { error: `Forbidden — your role does not grant ${permission}` },
        { status: 403 },
      ),
    };
  }

  return { session: auth.session, member, org };
}

/**
 * Convenience wrapper around {@link requireOrgAccess} for owner-only operations.
 * Accepts the same capability gate as `requireOrgAccess` (sans `minimumRole`,
 * which is always OWNER here).
 */
export async function requireOrgOwner(
  organizationId: string,
  opts?: Omit<OrgCapabilityGate, "minimumRole">,
): Promise<({ error?: never } & OrgAccessGrant) | { error: NextResponse }> {
  return requireOrgAccess(organizationId, {
    ...opts,
    minimumRole: "OWNER",
  });
}

/**
 * Whether this caller may waive the consultant's own published availability
 * when allocating.
 *
 * Deliberately narrower than {@link authorizeEventAccess}, which admits the
 * consultee as a participant. Accepting a time outside the published window is
 * the consultant's decision about their own schedule; a consultee asserting it
 * would let them book whenever they liked.
 */
export async function isEventConsultant(
  session: Session,
  eventType: "consultation" | "subscription" | "webinar" | "class",
  eventId: string,
): Promise<boolean> {
  if (isPrivileged(session.user.role)) return true;

  const consultantProfileId = session.user.consultantProfileId;
  if (!consultantProfileId) return false;

  switch (eventType) {
    case "consultation": {
      const event = await prisma.consultation.findUnique({
        where: { id: eventId },
        select: { consultationPlan: { select: { consultantProfileId: true } } },
      });
      return (
        event?.consultationPlan.consultantProfileId === consultantProfileId
      );
    }
    case "subscription": {
      const event = await prisma.subscription.findUnique({
        where: { id: eventId },
        select: { subscriptionPlan: { select: { consultantProfileId: true } } },
      });
      return (
        event?.subscriptionPlan.consultantProfileId === consultantProfileId
      );
    }
    case "webinar": {
      const event = await prisma.webinar.findUnique({
        where: { id: eventId },
        select: { webinarPlan: { select: { consultantProfileId: true } } },
      });
      return event?.webinarPlan.consultantProfileId === consultantProfileId;
    }
    case "class": {
      const event = await prisma.class.findUnique({
        where: { id: eventId },
        select: { classPlan: { select: { consultantProfileId: true } } },
      });
      return event?.classPlan.consultantProfileId === consultantProfileId;
    }
  }
}
