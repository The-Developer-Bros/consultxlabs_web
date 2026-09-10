import { NextRequest, NextResponse } from "next/server";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";
import {
  cleanupAbandonedPayments,
  cleanupExpiredApprovalPendingPayments,
  disconnectDatabase,
} from "@/scripts/payments/cleanup-abandoned-payments";
import {
  InvalidLimitError,
  parseLimitParam,
  statusFor,
} from "@/lib/cron/cleanup-route";
import * as Sentry from "@sentry/nextjs";
import {
  assertNotInMaintenance,
  MaintenanceActiveError,
} from "@/lib/maintenance-cron";

export async function POST(req: NextRequest) {
  try {
    // Verify this is called by a cron job or authorized service
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json(
        {
          error: "Unauthorized",
          message:
            "Please provide a valid authorization header with the CRON_SECRET",
        },
        { status: 401 },
      );
    }
    // The cron core is shared with the jobs/** entrypoint, which exits on
    // maintenance; this HTTP twin cannot exit, so it answers 503 instead.
    await assertNotInMaintenance("cleanup-abandoned-payments");

    Sentry.logger.info("cron:cleanup-abandoned-payments started");

    // Run both cleanup tasks. `limit` is passed to each pass IN FULL, not
    // split or subtracted between them: it bounds each pass's own query so a
    // single pass fits the ticker's 26s function ceiling, and the unbounded
    // GitHub Actions run is the backstop that drains whatever a bounded tick
    // leaves behind (ADR 27).
    const limit = parseLimitParam(req);
    const paymentResult = await cleanupAbandonedPayments({ limit });
    const consultationResult = await cleanupExpiredApprovalPendingPayments({
      limit,
    });
    await disconnectDatabase();

    Sentry.logger.info("cron:cleanup-abandoned-payments finished", {
      paymentSuccess: paymentResult.success,
      consultationSuccess: consultationResult.success,
    });

    const overallSuccess = paymentResult.success && consultationResult.success;
    return NextResponse.json(
      {
        paymentCleanup: paymentResult,
        consultationCleanup: consultationResult,
        overallSuccess,
      },
      // #1464 — this twin always answered 200, so a run that reported failures
      // in its own body still read as healthy to the ticker and to anything
      // watching the status. The shared mapping answers 500 when the sweep
      // says it failed, which is what the rest of the cohort already does.
      { status: statusFor({ success: overallSuccess }) },
    );
  } catch (error) {
    // #476 — concurrent invocation (schedule overlap / manual re-run)
    // skips with a 409 instead of double-running.
    if (error instanceof CronLockHeldError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof InvalidLimitError) {
      return NextResponse.json({ error: "INVALID_LIMIT" }, { status: 400 });
    }
    if (error instanceof MaintenanceActiveError) {
      return NextResponse.json(
        { error: error.message, phase: error.phase },
        { status: error.httpStatus },
      );
    }
    Sentry.captureException(error, {
      tags: { subsystem: "cron", job: "cleanup-abandoned-payments" },
    });
    console.error("Cleanup API route failed:", error);
    return NextResponse.json(
      {
        error: "Cleanup job failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
