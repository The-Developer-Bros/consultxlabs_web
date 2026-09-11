/**
 * Staff Dashboard Stats API
 * Returns homepage statistics for the staff dashboard.
 *
 * Thin shell — the JSON-safe read lives in `lib/data/staff-stats.ts`
 * (`getStaffStats`), shared with the server prefetch (#890) so SSR
 * hydration and the client fetch resolve identical payloads.
 */

import { NextResponse } from "next/server";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { getStaffStats } from "@/lib/data/staff-stats";

export async function GET() {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const stats = await getStaffStats();
    return NextResponse.json(stats);
  } catch (error) {
    console.error("Error fetching staff stats:", error);
    return NextResponse.json(
      { error: "Failed to fetch staff stats" },
      { status: 500 },
    );
  }
}
