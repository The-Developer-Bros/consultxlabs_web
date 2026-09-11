/**
 * Shared data reads for the operator (cross-org) workspace dashboard.
 *
 * Extracted from the org-workspace API routes so the routes and the
 * server pages' SSR prefetch read through one code path — the dehydrated
 * SSR cache and the client's CSR fetch can't drift. Auth stays at the
 * call site: each route keeps its own `requireApiAuth` + IDOR guard, and
 * the server pages run under the org-workspace layout's IDOR gate. These
 * functions take the already-authenticated `userId` (plus ids/cursor)
 * and return the EXACT object the corresponding route serialises as JSON.
 *
 * Return shapes are fully plain/JSON-safe (Dates pre-stringified to ISO)
 * so they cross the RSC→client boundary and React Query hydration applies
 * verbatim against the client query keys.
 */

import { reportSentryError } from "@/lib/observability/report";
import type { FundingSource, MemberRole, OrgStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import { sumPaise } from "@/lib/payments/utils/money";

/* ------------------------------------------------------------------ *
 * GET /api/organizations                                              *
 * ------------------------------------------------------------------ */

export interface OperatorOrgRow {
  membershipId: string;
  role: MemberRole;
  status: string;
  organization: {
    id: string;
    name: string;
    slug: string;
    status: OrgStatus;
    canSponsor: boolean;
    canHost: boolean;
    logo: string | null;
    billingAccount: {
      fundingSource: FundingSource;
      walletBalance: number | null;
      currency: string;
    } | null;
  };
}

/**
 * The org list behind the workspace "your organizations" grid. Mirrors
 * the body of GET /api/organizations verbatim: `{ data: [...] }`.
 */
export async function getOperatorOrganizations(
  userId: string,
): Promise<{ data: OperatorOrgRow[] }> {
  const memberships = await prisma.membership.findMany({
    where: { userId, status: "ACTIVE" },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          canSponsor: true,
          canHost: true,
          brandingProfile: { select: { logo: true } },
          billingAccount: {
            select: { fundingSource: true, walletBalance: true, currency: true },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return {
    data: memberships.map((m) => ({
      membershipId: m.id,
      role: m.role,
      status: m.status,
      organization: {
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        status: m.organization.status,
        canSponsor: m.organization.canSponsor,
        canHost: m.organization.canHost,
        // Flatten brandingProfile.logo so the UI sees the same shape as before.
        logo: m.organization.brandingProfile?.logo ?? null,
        billingAccount: m.organization.billingAccount,
      },
    })),
  };
}

/* ------------------------------------------------------------------ *
 * GET /api/org-workspace/[id]/billing                                 *
 * ------------------------------------------------------------------ */

export interface WorkspaceBillingSummary {
  orgsOwned: number;
  totalActiveMembers: number;
  totalOutstandingPaise: number;
  totalWalletPaise: number;
}

export interface WorkspaceBillingPerOrgRow {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  organizationStatus: string;
  fundingSource: FundingSource | null;
  currency: string;
  walletBalancePaise: number;
  outstandingCount: number;
  outstandingPaise: number;
  activeMembers: number;
}

export interface WorkspaceBillingRollup {
  summary: WorkspaceBillingSummary;
  perOrg: WorkspaceBillingPerOrgRow[];
}

/**
 * Cross-org billing roll-up over every org the caller OWNS. Shared by
 * the workspace home stats row (`.summary`) and the billing page
 * (`.summary` + `.perOrg`). Mirrors GET /api/org-workspace/[id]/billing.
 */
export async function getWorkspaceBillingRollup(
  userId: string,
): Promise<WorkspaceBillingRollup> {
  const ownedMemberships = await prisma.membership.findMany({
    where: { userId, role: "OWNER", status: "ACTIVE" },
    select: {
      organizationId: true,
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          billingAccount: {
            select: {
              id: true,
              walletBalance: true,
              currency: true,
              fundingSource: true,
            },
          },
        },
      },
    },
  });

  const orgIds = ownedMemberships.map((m) => m.organizationId);

  if (orgIds.length === 0) {
    return {
      summary: {
        orgsOwned: 0,
        totalActiveMembers: 0,
        totalOutstandingPaise: 0,
        totalWalletPaise: 0,
      },
      perOrg: [],
    };
  }

  const [invoiceAgg, memberAgg] = await Promise.all([
    prisma.organizationInvoice.groupBy({
      by: ["billingAccountId"],
      where: {
        billingAccount: { ownerOrgId: { in: orgIds } },
        status: { in: ["ISSUED", "OVERDUE"] },
      },
      _sum: { totalPaise: true },
      _count: { _all: true },
    }),
    prisma.membership.groupBy({
      by: ["organizationId"],
      where: { organizationId: { in: orgIds }, status: "ACTIVE" },
      _count: { _all: true },
    }),
  ]);

  const invoiceByBA = new Map(
    invoiceAgg.map((row) => [
      row.billingAccountId,
      {
        outstandingCount: row._count._all,
        outstandingPaise: sumPaise(row._sum.totalPaise),
      },
    ]),
  );
  const membersByOrg = new Map(
    memberAgg.map((row) => [row.organizationId, row._count._all]),
  );

  const perOrg = ownedMemberships.map((m) => {
    const ba = m.organization.billingAccount;
    const inv = ba ? invoiceByBA.get(ba.id) : undefined;
    return {
      organizationId: m.organization.id,
      organizationName: m.organization.name,
      organizationSlug: m.organization.slug,
      organizationStatus: m.organization.status,
      fundingSource: ba?.fundingSource ?? null,
      currency: ba?.currency ?? "INR",
      walletBalancePaise: ba?.walletBalance ?? 0,
      outstandingCount: inv?.outstandingCount ?? 0,
      outstandingPaise: inv?.outstandingPaise ?? 0,
      activeMembers: membersByOrg.get(m.organization.id) ?? 0,
    };
  });

  const summary = {
    orgsOwned: ownedMemberships.length,
    totalActiveMembers: perOrg.reduce((sum, o) => sum + o.activeMembers, 0),
    totalOutstandingPaise: perOrg.reduce(
      (sum, o) => sum + o.outstandingPaise,
      0,
    ),
    totalWalletPaise: perOrg.reduce((sum, o) => sum + o.walletBalancePaise, 0),
  };

  return { summary, perOrg };
}

/* ------------------------------------------------------------------ *
 * GET /api/org-workspace/[id]/activity                                *
 * ------------------------------------------------------------------ */

export const WORKSPACE_ACTIVITY_DEFAULT_LIMIT = 50;

export interface WorkspaceActivityRow {
  id: string;
  organizationId: string;
  organizationName: string | null;
  organizationSlug: string | null;
  category: string;
  action: string;
  description: string;
  createdAt: string;
  actorName: string | null;
}

export interface WorkspaceActivityPage {
  data: WorkspaceActivityRow[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
    limit: number;
  };
}

/**
 * One page of the cross-org audit feed (latest-first, cursor on id).
 * Mirrors GET /api/org-workspace/[id]/activity. `createdAt` is
 * pre-stringified to ISO so the hydrated cache matches the client's
 * `ActivityResponse` (which types it as a string).
 */
export async function getWorkspaceActivity(
  userId: string,
  cursor: string | null,
  limit: number = WORKSPACE_ACTIVITY_DEFAULT_LIMIT,
): Promise<WorkspaceActivityPage> {
  const ownedOrgs = await prisma.membership.findMany({
    where: { userId, role: "OWNER", status: "ACTIVE" },
    select: {
      organizationId: true,
      organization: { select: { id: true, name: true, slug: true } },
    },
  });
  const orgIds = ownedOrgs.map((o) => o.organizationId);
  const orgById = new Map(ownedOrgs.map((o) => [o.organizationId, o.organization]));

  if (orgIds.length === 0) {
    return {
      data: [],
      pagination: { hasMore: false, nextCursor: null, limit },
    };
  }

  const rows = await prisma.orgAuditLog.findMany({
    where: { organizationId: { in: orgIds } },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    select: {
      id: true,
      organizationId: true,
      actorMembershipId: true,
      category: true,
      action: true,
      description: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? slice[slice.length - 1]?.id ?? null : null;

  const actorIds = Array.from(
    new Set(slice.map((r) => r.actorMembershipId).filter((v): v is string => !!v)),
  );
  const actors = actorIds.length
    ? await prisma.membership.findMany({
        where: { id: { in: actorIds } },
        select: {
          id: true,
          user: { select: { name: true, email: true } },
        },
      })
    : [];
  const actorById = new Map(actors.map((a) => [a.id, a]));

  const data = slice.map((r) => {
    const org = orgById.get(r.organizationId);
    const actor = r.actorMembershipId
      ? actorById.get(r.actorMembershipId)
      : undefined;
    return {
      id: r.id,
      organizationId: r.organizationId,
      organizationName: org?.name ?? null,
      organizationSlug: org?.slug ?? null,
      category: r.category,
      action: r.action,
      description: r.description,
      createdAt: r.createdAt.toISOString(),
      actorName: actor?.user?.name ?? actor?.user?.email ?? null,
    };
  });

  return {
    data,
    pagination: { hasMore, nextCursor, limit },
  };
}

/* ------------------------------------------------------------------ *
 * GET /api/org-workspace/[id]/settings                                *
 * ------------------------------------------------------------------ */

export interface WorkspaceSettingsProfile {
  id: string;
  defaultLandingOrganizationId: string | null;
  notificationRoutingMode: string;
  locale: string | null;
  currencyDisplayCode: string | null;
  updatedAt: string;
}

export interface WorkspaceSettingsCandidateOrg {
  id: string;
  name: string;
  status: string;
}

export interface WorkspaceSettings {
  profile: WorkspaceSettingsProfile;
  candidateOrgs: WorkspaceSettingsCandidateOrg[];
}

/**
 * Operator-level preferences + the owned-org picklist for the default
 * landing selector. Mirrors GET /api/org-workspace/[id]/settings.
 * `updatedAt` is pre-stringified to ISO so the hydrated cache matches
 * the client's `SettingsGetResponse` (which types it as a string).
 *
 * Throws when the profile row is absent — the route's IDOR guard has
 * already matched `orgWorkspaceProfileId` to `orgWorkspaceId`, so a
 * missing row is a genuine error and the SSR prefetch should reject
 * (Promise.allSettled degrades it to a client-side fetch).
 */
export async function getWorkspaceSettings(
  userId: string,
  orgWorkspaceId: string,
): Promise<WorkspaceSettings> {
  const profile = await prisma.orgWorkspaceProfile.findUnique({
    where: { id: orgWorkspaceId },
    select: {
      id: true,
      defaultLandingOrganizationId: true,
      notificationRoutingMode: true,
      locale: true,
      currencyDisplayCode: true,
      updatedAt: true,
    },
  });

  if (!profile) {
    // Modelled: the caller's Promise.allSettled degrades this to a
    // client-side fetch (see docstring above) — captured for visibility
    // into how often the IDOR-checked id resolves to no row.
    const notFoundErr = new Error("OrgWorkspaceProfile not found");
    reportSentryError(notFoundErr, { subsystem: "organizations", expected: true });
    throw notFoundErr;
  }

  const ownedOrgs = await prisma.membership.findMany({
    where: { userId, role: "OWNER", status: "ACTIVE" },
    select: {
      organization: { select: { id: true, name: true, status: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const candidateOrgs = ownedOrgs
    .map((m) => m.organization)
    .filter((o) => o.status !== "DEACTIVATED");

  return {
    profile: {
      id: profile.id,
      defaultLandingOrganizationId: profile.defaultLandingOrganizationId,
      notificationRoutingMode: profile.notificationRoutingMode,
      locale: profile.locale,
      currencyDisplayCode: profile.currencyDisplayCode,
      updatedAt: profile.updatedAt.toISOString(),
    },
    candidateOrgs,
  };
}
