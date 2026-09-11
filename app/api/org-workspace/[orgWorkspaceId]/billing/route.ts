/**
 * GET /api/org-workspace/[orgWorkspaceId]/billing
 *
 * Cross-org billing roll-up for an OrgWorkspace operator. Aggregates:
 *   - Outstanding invoice paise across all orgs the caller OWNS
 *     (status ∈ {ISSUED, OVERDUE} — i.e. issued but not paid)
 *   - Wallet balance across all orgs (BillingAccount.walletBalance)
 *   - Active member count across all orgs (informational, drives the
 *     home stats row)
 *   - Per-org breakdown so the dashboard table can list each org's
 *     numbers without a second round-trip
 *
 * Auth: the URL's orgWorkspaceId must match the caller's
 * `orgWorkspaceProfileId`. We never let one operator browse another
 * operator's portfolio — same posture as the dashboard layout's
 * IDOR guard.
 *
 * Returns 200 even when the operator has zero owned orgs (just
 * zeroed-out summary + empty per-org array). Avoids forcing the UI
 * to handle a "no profile yet" branch separately.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireApiAuth } from "@/lib/auth-helpers";
import { getWorkspaceBillingRollup } from "@/lib/data/org-workspace";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgWorkspaceId: string }> },
) {
  const { orgWorkspaceId } = await params;
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;

  // `orgWorkspaceProfileId` is part of the customSession-augmented user
  // type (lib/auth.ts:522) — direct access is type-safe.
  if (auth.session.user.orgWorkspaceProfileId !== orgWorkspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Body extracted to lib/data/org-workspace so the workspace home +
  // billing pages' SSR prefetch reads through the same code path. The
  // roll-up is scoped to the orgs the caller OWNS (not the workspace id),
  // so only the authenticated userId is needed.
  const result = await getWorkspaceBillingRollup(auth.session.user.id);
  return NextResponse.json(result);
}
