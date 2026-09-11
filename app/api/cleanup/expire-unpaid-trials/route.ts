/**
 * Unpaid Trial Expiry API Endpoint
 *
 * Thin wrapper around scripts/trials/expire-unpaid-trials.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * The scheduled run is the GitHub Action (jobs/trials/expire-unpaid-trials.ts);
 * no workflow curls this. Both entries share the cron lock held in the core.
 *
 * Schedule: Hourly (via GitHub Actions or external cron)
 */

import * as Sentry from "@sentry/nextjs";
import {
  assertNotInMaintenance,
  MaintenanceActiveError,
} from "@/lib/maintenance-cron";
import { NextRequest, NextResponse } from "next/server";

import { CronLockHeldError } from "@/lib/cron/with-cron-lock";
import { expireUnpaidTrials } from "@/scripts/trials/expire-unpaid-trials";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // Verify cron secret to prevent unauthorized access
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      console.warn("Unauthorized unpaid trial expiry attempt");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // The cron core is shared with the jobs/** entrypoint, which exits on
    // maintenance; this HTTP twin cannot exit, so it answers 503 instead.
    await assertNotInMaintenance("expire-unpaid-trials");

    Sentry.logger.info("cron:expire-unpaid-trials started");
    console.log("🧹 Starting unpaid trial expiry via API...");

    const result = await expireUnpaidTrials();

    console.log("✅ Unpaid trial expiry completed:", {
      trialsExpired: result.trialsExpired,
    });
    Sentry.logger.info("cron:expire-unpaid-trials finished", {
      trialsExpired: result.trialsExpired,
    });

    return NextResponse.json({
      success: result.success,
      trialsExpired: result.trialsExpired,
      errors: result.errors,
      timestamp: result.timestamp,
    });
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof MaintenanceActiveError) {
      return NextResponse.json(
        { error: error.message, phase: error.phase },
        { status: error.httpStatus },
      );
    }
    Sentry.captureException(error, {
      tags: { subsystem: "cron", job: "expire-unpaid-trials" },
    });
    console.error("Error in unpaid trial expiry:", error);
    return NextResponse.json(
      { success: false, error: "Failed to expire unpaid trial sessions" },
      { status: 500 },
    );
  }
}
