/**
 * Staff Payouts API
 * Staff access to payout listing.
 *
 * Thin shell — listing/aggregation logic lives in
 * `lib/api/operators/payouts.ts` and is shared with `/api/admin/payouts`.
 */

import { NextRequest, NextResponse } from "next/server";
import { PayoutStatus } from "@prisma/client";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { getOperatorPayouts } from "@/lib/api/operators";

/**
 * GET /api/staff/payouts
 * Get payouts with optional status filter (staff access)
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireBackofficeSurface("payouts.read");
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const result = await getOperatorPayouts({
      status: searchParams.get("status") as PayoutStatus | null,
      search: searchParams.get("search"),
      // #674 comment 7 — org-scope filter via earnings.payment.organizationId.
      orgId: searchParams.get("orgId"),
      limit: parseInt(searchParams.get("limit") || "50"),
      offset: parseInt(searchParams.get("offset") || "0"),
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error fetching payouts:", error);
    return NextResponse.json(
      { error: "Failed to fetch payouts" },
      { status: 500 },
    );
  }
}
