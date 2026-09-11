/**
 * Admin Payout Processing API
 * Process all approved payouts
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { processApprovedPayouts } from "@/lib/payments/payouts";
import { requireAdminAuth } from "@/lib/auth-helpers";

/**
 * POST /api/admin/payouts/process
 * Process all approved payouts
 */
export async function POST(_req: NextRequest) {
  try {
    const auth = await requireAdminAuth();
    if (auth.error) return auth.error;

    // Process approved payouts
    const results = await processApprovedPayouts();

    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    return NextResponse.json({
      success: true,
      processed: results.length,
      successful,
      failed,
      results,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "admin" } });
    console.error("Error processing payouts:", error);
    return NextResponse.json(
      { error: "Failed to process payouts" },
      { status: 500 },
    );
  }
}
