import { NextRequest, NextResponse } from "next/server";
import { reconcileOrphanedSessions } from "@/jobs/meetings/reconcile-orphaned-sessions";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";
import {
  assertNotInMaintenance,
  MaintenanceActiveError,
} from "@/lib/maintenance-cron";

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json(
        {
          error: "Unauthorized",
          message:
            "Please provide a valid authorization header with the CRON_SECRET",
        },
        { status: 401 },
      );
    }

    // This route keeps its own handler (its result shape predates the
    // cleanupRoute factory), but not its own maintenance policy: the local
    // OFFLINE-only check could not see the financial-job registry and would
    // have drifted from the rest of the cohort the moment the rule changed.
    // The canonical job name is the one the jobs/** entrypoint guards with.
    await assertNotInMaintenance("reconcile-orphaned-sessions");

    Sentry.logger.info("cron:reconcile-sessions started");
    const result = await reconcileOrphanedSessions();
    Sentry.logger.info("cron:reconcile-sessions finished", { ...result });

    return NextResponse.json(result);
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
      tags: { subsystem: "cron", job: "reconcile-sessions" },
    });
    console.error("Reconcile sessions API route failed:", error);
    // The exception text stays in Sentry and the server log; echoing it back
    // leaks internal detail the caller has no use for.
    return NextResponse.json(
      { error: "Reconciliation job failed" },
      { status: 500 },
    );
  }
}
