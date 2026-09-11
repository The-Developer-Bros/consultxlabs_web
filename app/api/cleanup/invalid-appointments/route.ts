import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { runAllCleanupTasks } from "@/scripts/appointments/cleanup-invalid-appointments";
import { CronLockHeldError } from "@/lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";
import {
  assertNotInMaintenance,
  MaintenanceActiveError,
} from "@/lib/maintenance-cron";

export async function POST(req: NextRequest) {
  try {
    // Fail safely if CRON_SECRET is not configured
    if (!process.env.CRON_SECRET) {
      console.error("CRON_SECRET environment variable not set");
      return NextResponse.json(
        { error: "Internal Server Error", message: "Server misconfigured" },
        { status: 500 },
      );
    }

    // Verify this is called by a cron job or authorized service
    // Use timing-safe comparison to prevent timing attacks
    const authHeader = req.headers.get("authorization");
    const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;

    const providedAuthBuffer = Buffer.from(authHeader || "");
    const expectedAuthBuffer = Buffer.from(expectedAuth);

    if (
      providedAuthBuffer.length !== expectedAuthBuffer.length ||
      !timingSafeEqual(providedAuthBuffer, expectedAuthBuffer)
    ) {
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
    await assertNotInMaintenance("cleanup-invalid-appointments");

    // Run all cleanup tasks (handles its own database disconnection)
    Sentry.logger.info("cron:cleanup-invalid-appointments started");
    const result = await runAllCleanupTasks();

    Sentry.logger.info("cron:cleanup-invalid-appointments finished", {
      ...result,
    });
    return NextResponse.json({
      ...result,
      timestamp: new Date().toISOString(),
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
      tags: { subsystem: "cron", job: "cleanup-invalid-appointments" },
    });
    console.error("Invalid appointments cleanup API route failed:", error);
    return NextResponse.json(
      {
        error: "Cleanup job failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
