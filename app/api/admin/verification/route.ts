/**
 * Admin Verification API
 * GET /api/admin/verification - List profile verifications.
 *
 * Thin shell — query/formatting lives in
 * `lib/api/operators/verification.ts` and is shared with
 * `/api/staff/moderation/profiles`.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { ProfileVerificationStatus } from "@prisma/client";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { getVerificationQueue } from "@/lib/api/operators";

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const statusParam = searchParams.get("status") || "PENDING";

    const result = await getVerificationQueue({
      status: statusParam as ProfileVerificationStatus,
      page: parseInt(searchParams.get("page") || "1"),
      limit: parseInt(searchParams.get("limit") || "20"),
    });

    return NextResponse.json(result);
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "admin" } });
    console.error("Error fetching verifications:", error);
    return NextResponse.json(
      { error: "Failed to fetch verifications" },
      { status: 500 },
    );
  }
}
