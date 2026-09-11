import type { MemberRole } from "@prisma/client";

/**
 * Why the ladder is sparse (steps of ~20)
 * --------------------------------------
 * Leaves room for future roles to slot between existing rungs without
 * renumbering everything. BILLING_ADMIN landed at 70 between MAINTAINER
 * (80) and MANAGER (60) for exactly this reason — see PR #655 audit.
 *
 * Why BILLING_ADMIN = 70 (not 90 or 50)
 * -------------------------------------
 * - **Above MANAGER**: a billing-admin must be able to do anything a
 *   manager can (read members, view activity, manage program assignments)
 *   plus the financial mutations. Putting BILLING_ADMIN below MANAGER
 *   would force every billing route gate to be expressed as a
 *   disjunction (`OWNER | BILLING_ADMIN`) AND a re-check that the role
 *   ladder also satisfies the MANAGER-and-up read paths.
 * - **Below MAINTAINER**: maintainers control SSO, domain claims, member
 *   invite/role mutations. Billing-admins explicitly do NOT — those are
 *   security-sensitive surfaces governance teams prefer to keep with
 *   OWNER + MAINTAINER. Sitting below MAINTAINER means
 *   `isAtLeastRole(BILLING_ADMIN, MAINTAINER)` is false and the SSO
 *   routes auto-deny without per-route plumbing.
 *
 * Why SUPPORT sits below MANAGER
 * ------------------------------
 * Support-tier members read audit logs but don't mutate billing. Keep
 * their numeric rank (30) explicitly distinct from EXPERT (40) so role
 * promotions don't have to walk EXPERT.
 */
export const ORG_ROLE_RANK: Record<MemberRole, number> = {
  OWNER: 100,
  MAINTAINER: 80,
  BILLING_ADMIN: 70,
  MANAGER: 60,
  EXPERT: 40,
  SUPPORT: 30,
  LEARNER: 20,
};

export function isAtLeastRole(actual: MemberRole, minimum: MemberRole): boolean {
  return ORG_ROLE_RANK[actual] >= ORG_ROLE_RANK[minimum];
}

/**
 * Sidebar-visibility helper that respects the BILLING_ADMIN ↔ MAINTAINER
 * disjunction documented in `lib/auth/billing-admin-gate.ts`.
 *
 * The rank ladder is correct for capability-comparison checks (a higher
 * rank can do anything a lower rank can — billing-flavoured surfaces).
 * But navigation visibility is different: a BILLING_ADMIN at rank 70
 * must NOT see Members / Invitations / SSO / Audit just because their
 * numeric rank exceeds MANAGER's 60 — those are governance surfaces
 * reserved for MANAGER and up, where "and up" means MAINTAINER + OWNER
 * but NOT BILLING_ADMIN.
 *
 * Two flavours:
 *
 *   canSeeOperatorSurface(role) → governance/people pages (Members,
 *      Invitations, Learners, Experts, Audit, Settings, etc.). True
 *      for OWNER / MAINTAINER / MANAGER / SUPPORT; **false for
 *      BILLING_ADMIN** because that role is finance-only.
 *
 *   canSeeFinanceSurface(role) → invoices, POs, payouts, rate cards,
 *      wallet, webhooks, data exports. True for OWNER, MAINTAINER,
 *      BILLING_ADMIN, MANAGER (read-only). MANAGER is included for
 *      visibility — the route gates still refuse mutations.
 *
 * Why these are not implicit-cast `isAtLeastRole` calls: rank order is
 * a partial order on capability, not navigation. Sidebar logic needs
 * the explicit disjunction so any future role insertion doesn't
 * accidentally widen the wrong surface.
 */
// Why the `MemberRole[]` annotation on the array literal: a bare
// string array would widen to `string[]`, which can't be passed to
// `Set<MemberRole>` without losing the narrow type. Annotating the
// array (rather than the Set) keeps the source readable.
const OPERATOR_ROLES: ReadonlySet<MemberRole> = new Set<MemberRole>([
  "OWNER",
  "MAINTAINER",
  "MANAGER",
  "SUPPORT",
]);

const FINANCE_ROLES: ReadonlySet<MemberRole> = new Set<MemberRole>([
  "OWNER",
  "MAINTAINER",
  "BILLING_ADMIN",
  "MANAGER",
]);

export function canSeeOperatorSurface(role: MemberRole): boolean {
  return OPERATOR_ROLES.has(role);
}

export function canSeeFinanceSurface(role: MemberRole): boolean {
  return FINANCE_ROLES.has(role);
}
