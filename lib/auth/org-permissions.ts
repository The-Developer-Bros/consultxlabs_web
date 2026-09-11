import type { MemberRole } from "@prisma/client";

/**
 * Org-dashboard permission matrix — the single source of truth for which
 * MemberRole can access which surface. The sidebar (visibility), the page
 * guards (useRequireOrgAccess), and the API routes (requireOrgAccess) all
 * consume THIS map, so a surface can no longer drift into "tab shown, page
 * redirects, API 403s" states (the 2026-07 role audit found nine of those).
 *
 * Why a matrix instead of the rank ladder: privilege here is not
 * one-dimensional. The org has an operations track (MANAGER, SUPPORT), a
 * finance track (BILLING_ADMIN), and member roles (EXPERT, LEARNER) —
 * BILLING_ADMIN outranks MANAGER numerically (70 > 60) yet must see LESS
 * operationally ("operator-blind"), and SUPPORT (30) sees MORE than EXPERT
 * (40) on operations surfaces. Rank comparisons (isAtLeastRole) remain
 * correct only for genuine hierarchy (OWNER > MAINTAINER > MANAGER
 * management chains) — surface access lives here.
 *
 * Capability gates (canSponsor / canHost / requiresPO / fundingSource) are
 * deliberately NOT part of the matrix — they describe the org's shape, not
 * the member's role, and stay as separate structural checks combined with
 * the matrix at each consumer.
 */

export type OrgSurface =
  // People & governance
  | "members.read"
  | "members.manage"
  | "invitations.manage"
  | "learners.read"
  | "experts.read"
  | "audit.read"
  | "consent.read"
  | "consent.manage"
  | "settings.manage"
  // Commerce (sponsor-side; combine with canSponsor at the consumer)
  | "contracts.read"
  | "contracts.manage"
  // Host-side: authoring the org's OWN bookable offerings. Distinct from
  // programs.manage, which is the sponsor's entitlement CRUD — combine with
  // canHost at the consumer.
  | "catalog.manage"
  | "programs.manage"
  | "purchaseOrders.read"
  | "purchaseOrders.manage"
  // Finance
  | "billing.read"
  | "billing.manage"
  | "payouts.read"
  | "payouts.manage"
  | "reimbursements.read"
  | "disputes.read"
  | "integrations.read"
  // Operations (org-scoped appointments, trials, documents,
  // recordings, analytics — one read grant for the whole group, incl. the
  // L1/L2 SUPPORT carve-out)
  | "operations.read"
  // Member-facing home surfaces (exact-role, capability-gated in the layout)
  | "myProgram.read"
  | "myArrangement.read";

const roles = (...list: MemberRole[]): ReadonlySet<MemberRole> =>
  new Set<MemberRole>(list);

// Named tiers so the matrix reads as policy, not repetition.
const GOVERNANCE = roles("OWNER", "MAINTAINER");
const OPERATORS = roles("OWNER", "MAINTAINER", "MANAGER");
const OPERATIONS_READERS = roles("OWNER", "MAINTAINER", "MANAGER", "SUPPORT");
const FINANCE_READERS = roles(
  "OWNER",
  "MAINTAINER",
  "BILLING_ADMIN",
  "MANAGER",
);
const FINANCE_MUTATORS = roles("OWNER", "BILLING_ADMIN");

export const ORG_PERMISSIONS: Record<OrgSurface, ReadonlySet<MemberRole>> = {
  // People & governance — BILLING_ADMIN is operator-blind by design.
  "members.read": OPERATIONS_READERS,
  "members.manage": GOVERNANCE,
  "invitations.manage": GOVERNANCE,
  "learners.read": OPERATORS,
  "experts.read": OPERATORS,
  "audit.read": roles("OWNER", "MAINTAINER", "SUPPORT"),
  "consent.read": OPERATORS,
  "consent.manage": OPERATORS,
  "settings.manage": GOVERNANCE,

  // Commerce — contract terms and program design are org-structural
  // decisions (spec: MAINTAINER floor); POs are day-to-day.
  "contracts.read": GOVERNANCE,
  "contracts.manage": roles("OWNER"),
  // OPERATORS rather than GOVERNANCE: publishing an offering is day-to-day
  // delivery work, not an org-structural decision like a contract or a
  // sponsorship program, so MANAGER holds it. EXPERT deliberately does NOT —
  // an org-owned plan commits the ORG's revenue and payout obligation, so it
  // needs an operator in the loop. An EXPERT is named as the deliverer instead.
  "catalog.manage": OPERATORS,
  "programs.manage": GOVERNANCE,
  "purchaseOrders.read": FINANCE_READERS,
  "purchaseOrders.manage": FINANCE_MUTATORS,

  // Finance — MANAGER reads, mutations stay with OWNER/BILLING_ADMIN
  // (preserves the requireOrgBillingAdminOrOwner disjunction).
  "billing.read": FINANCE_READERS,
  "billing.manage": FINANCE_MUTATORS,
  "payouts.read": FINANCE_READERS,
  "payouts.manage": FINANCE_MUTATORS,
  "reimbursements.read": FINANCE_READERS,
  "disputes.read": FINANCE_READERS,
  "integrations.read": FINANCE_READERS,

  // Operations — includes the SUPPORT carve-out (L1/L2 triage reads).
  "operations.read": OPERATIONS_READERS,

  // Member-facing surfaces.
  "myProgram.read": roles("LEARNER"),
  "myArrangement.read": roles("EXPERT"),
};

export function hasOrgPermission(
  role: MemberRole,
  surface: OrgSurface,
): boolean {
  return ORG_PERMISSIONS[surface].has(role);
}
