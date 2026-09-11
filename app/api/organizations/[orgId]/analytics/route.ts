/**
 * GET /api/organizations/[orgId]/analytics
 *
 * Dashboard aggregate endpoint — the one call the org-home page makes to
 * render every stat tile. Returns an object keyed by section so the client
 * can lay out cards without extra round-trips:
 *
 *   capabilities  { canSponsor, canHost, fundingSource, walletBalance }
 *   members       { total, active, byRole }
 *   programs      { total, active, activeAssignments }
 *   wallet        { balancePaise, recentTopUps, recentDebits } (WALLET only)
 *   invoices      { outstanding, pastDue, paidLast30d }        (INVOICE only)
 *   reimbursements{ last30dCount, last30dPaise }               (PERSONAL only — #714)
 *   earnings      { pending, ready, paid, refunded }           (canHost only)
 *
 * The read itself lives in lib/data/org-analytics.ts so the org home +
 * analytics server pages' SSR prefetch and this route stay in lock-step. All
 * aggregates are `count` / `_sum` queries — no per-row enumeration — so the
 * response stays cheap even for orgs with tens of thousands of rows.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { getOrgAnalytics } from "@/lib/data/org-analytics";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { permission: "operations.read" });
  if (access.error) return access.error;

  const analytics = await getOrgAnalytics(orgId);
  if (!analytics) {
    return NextResponse.json(
      { error: "Organization not found" },
      { status: 404 },
    );
  }

  return NextResponse.json(analytics);
}
