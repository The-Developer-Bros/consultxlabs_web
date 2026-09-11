/**
 * Disjunction gate: OWNER or BILLING_ADMIN.
 *
 * Why this exists alongside `requireOrgAccess` + `requireOrgOwner`
 * ----------------------------------------------------------------
 * The base `requireOrgAccess(orgId, { minimumRole: "X" })` is a rank
 * comparison (`ORG_ROLE_RANK[actual] >= ORG_ROLE_RANK[minimum]`). For
 * billing routes we don't want that semantics: BILLING_ADMIN should
 * sit ABOVE MANAGER on the rank ladder (it has more privileges than
 * MANAGER on the financial surface) but the route gate must NOT
 * implicitly grant access to MAINTAINER, which holds a higher rank
 * but explicitly does NOT have billing rights per the role
 * description in `lib/labels/org-labels.ts`:
 *
 *   MAINTAINER  → "Members, plans, programs, and settings.
 *                   No billing or deletion."
 *   BILLING_ADMIN → "Manages invoices, POs, payouts, rate cards,
 *                    and outbound webhooks. No member or SSO changes."
 *
 * The two roles are governance-orthogonal: one is the org-admin
 * surface, the other is the finance surface. A rank-based gate would
 * conflate them. Hence the explicit disjunction here.
 *
 * Surfaces that should use this helper (downgrade from OWNER-only):
 *   - billing-account / wallet PATCH + top-up create
 *   - billing-account / purchase-orders CRUD
 *   - billing-account / invoices POST + invoice-status PATCH
 *   - payouts CRUD
 *   - rate-cards CRUD
 *   - outbound webhook endpoints (create / update / redeliver) — see
 *     Batch 3 of PR #655 enterprise lockdown.
 *
 * Surfaces that must STAY OWNER-only (do NOT use this helper):
 *   - org delete + ownership transfer
 *   - SSO providers + settings
 *   - domain claims
 *   - member invite / role change / removal
 *   - SCIM token CRUD
 *
 * Platform-admin bypass
 * ---------------------
 * `requireOrgAccess` already synthesizes an OWNER-rank stub for
 * platform admins (`UserRole.ADMIN`). That stub satisfies our
 * `role === "OWNER"` branch automatically, so no separate admin
 * handling is needed here.
 */

import { NextResponse } from "next/server";
import {
  requireOrgAccess,
  type OrgCapabilityGate,
} from "@/lib/auth-helpers";

/**
 * Returns the same shape as `requireOrgAccess`. On failure the
 * `error` field carries a 403 `NextResponse`; on success the caller
 * gets the standard `{ session, member, org }` triple.
 */
export async function requireOrgBillingAdminOrOwner(
  organizationId: string,
  opts?: Omit<OrgCapabilityGate, "minimumRole">,
) {
  // First gate: caller must be SOME active member of the org. Reuse
  // `requireOrgAccess` with the lowest meaningful floor — LEARNER — so
  // capability checks (canSponsor, requireActive, etc.) still run. The
  // role disjunction below is the load-bearing check.
  //
  // We intentionally do NOT pass `minimumRole: "BILLING_ADMIN"` here,
  // because that would let MAINTAINER through on the rank comparison.
  const access = await requireOrgAccess(organizationId, {
    ...(opts ?? {}),
    minimumRole: "LEARNER",
  });
  if (access.error) return access;

  const role = access.member.role;
  if (role !== "OWNER" && role !== "BILLING_ADMIN") {
    return {
      error: NextResponse.json(
        {
          error: "Forbidden",
          // Specific code so the dashboard can show the right copy
          // (humanizeOrgError treats unknown codes as verbatim, which
          // is fine here — most calls hit this from server-rendered
          // routes that map the JSON shape themselves).
          code: "BILLING_ADMIN_OR_OWNER_REQUIRED",
        },
        { status: 403 },
      ),
    } as const;
  }

  return access;
}
