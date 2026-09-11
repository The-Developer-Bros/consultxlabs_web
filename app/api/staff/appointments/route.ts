/**
 * Staff Appointments API
 * Staff/Admin access to all appointments with filtering and pagination.
 *
 * Thin shell — the JSON-safe read lives in `lib/data/staff-appointments.ts`
 * (`getStaffAppointments`), shared with the server prefetch (#890) so SSR
 * hydration and the client fetch resolve identical payloads.
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { getStaffAppointments } from "@/lib/data/staff-appointments";
import type { Scope } from "@/lib/api/scope/parse";

// Coerce a query param to a positive integer; NaN / <1 / non-integer falls
// back to `fallback`. `parseInt("abc")` returns NaN (truthy), so a bare
// `|| default` never triggers — and the data layer doesn't clamp the offset.
function positiveIntParam(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * #674 defect 13 — `?orgId=` drills into one tenant; its absence is the
 * platform-wide view this endpoint exists for. requirePrivilegedAuth above is
 * what earns `all`, so no membership check is needed to widen it.
 */
function staffScope(orgId: string | null): Scope {
  return orgId ? { kind: "org", orgId } : { kind: "all" };
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const result = await getStaffAppointments({
      type: searchParams.get("type"),
      status: searchParams.get("status"),
      search: searchParams.get("search"),
      dateFrom: searchParams.get("dateFrom"),
      dateTo: searchParams.get("dateTo"),
      scope: staffScope(searchParams.get("orgId")),
      page: positiveIntParam(searchParams.get("page"), 1),
      limit: positiveIntParam(searchParams.get("limit"), 20),
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error fetching appointments:", error);
    return NextResponse.json(
      { error: "Failed to fetch appointments" },
      { status: 500 },
    );
  }
}
