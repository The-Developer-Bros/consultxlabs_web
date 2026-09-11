/**
 * Staff Moderation Profile Verification API
 * List consultant profile verifications.
 *
 * Thin shell — query/formatting lives in
 * `lib/api/operators/verification.ts` and is shared with
 * `/api/admin/verification`.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { ProfileVerificationStatus } from "@prisma/client";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { getVerificationQueue } from "@/lib/api/operators";

/**
 * GET /api/staff/moderation/profiles
 * List consultant profile verifications
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const result = await getVerificationQueue({
      status: searchParams.get("status") as ProfileVerificationStatus | null,
      page: parseInt(searchParams.get("page") || "1"),
      limit: parseInt(searchParams.get("limit") || "20"),
    });

    return NextResponse.json(result);
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "staff" } });
    console.error("Error fetching profile verifications:", error);
    return NextResponse.json(
      { error: "Failed to fetch verifications" },
      { status: 500 },
    );
  }
}
