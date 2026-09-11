/**
 * Transfer Expiring Recordings Cron Job
 *
 * Auto-transfers recordings from Stream S3 to Supabase for plans with
 * PERMANENT storage policy. Also identifies STREAM_ONLY
 * recordings expiring soon for consultant notification.
 *
 * Schedule: Every 6 hours (via GitHub Actions)
 */

import { NextRequest, NextResponse } from "next/server";
import { RecordingTransferService } from "@/lib/stream/recording-transfer-service";
import { streamLogger } from "@/lib/stream-logger";
import { withCronLock, CronLockHeldError } from "@/lib/cron/with-cron-lock";
import { notifyRecordingExpiring } from "@/lib/novu/service";
import { getAppUrl } from "@/lib/url";
import * as Sentry from "@sentry/nextjs";
import {
  assertNotInMaintenance,
  MaintenanceActiveError,
} from "@/lib/maintenance-cron";

// STR-3 — collapse the per-recording expiry list into one notification per
// consultant: count + soonest expiry. Keeps a consultant with 12 expiring
// recordings from getting 12 pings.
type ExpiringStreamOnly = {
  recordingId: string;
  title: string;
  consultantUserId: string;
  expiresAt: Date;
};

async function notifyConsultantsOfExpiringRecordings(
  expiring: ExpiringStreamOnly[],
): Promise<void> {
  const byConsultant = new Map<string, ExpiringStreamOnly[]>();
  for (const rec of expiring) {
    // A recording whose consultant could not be resolved upstream carries an
    // empty userId — skip it (no subscriber to notify).
    if (!rec.consultantUserId) continue;
    const list = byConsultant.get(rec.consultantUserId) ?? [];
    list.push(rec);
    byConsultant.set(rec.consultantUserId, list);
  }

  const dashboardUrl = `${getAppUrl()}/dashboard`;
  await Promise.allSettled(
    Array.from(byConsultant.entries()).map(([consultantUserId, recs]) => {
      const soonest = recs.reduce(
        (min, r) => (r.expiresAt < min ? r.expiresAt : min),
        recs[0].expiresAt,
      );
      // notifyRecordingExpiring is non-throwing (logs internally); allSettled
      // is belt-and-suspenders so one bad subscriber can't abort the batch.
      return notifyRecordingExpiring(consultantUserId, {
        recordingCount: recs.length,
        expiresAt: soonest.toISOString(),
        dashboardUrl,
      });
    }),
  );
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const authHeader = req.headers.get("authorization");
    const cronSecret =
      process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET;

    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // The cron core is shared with the jobs/** entrypoint, which exits on
    // maintenance; this HTTP twin cannot exit, so it answers 503 instead.
    await assertNotInMaintenance("transfer-expiring-recordings");

    streamLogger.info("Starting transfer-expiring-recordings cron");
    Sentry.logger.info("cron:transfer-expiring-recordings started");

    // #476 — both phases under one lock, same key as the GH Actions entry.
    const { transferResult, expiringStreamOnly } = await withCronLock(
      "transfer-expiring-recordings",
      { failMode: "open" },
      async () => {
        // Phase 1: Auto-transfer PERMANENT recordings.
        // #899 — 14-day window sweeps every READY permanent recording
        // (near-ready transfer), matching the GH Actions entry.
        const transferResult =
          await RecordingTransferService.processExpiringRecordings(
            14, // days before expiry (= full Stream URL lifetime)
            10, // batch size
            "PERMANENT",
          );

        // Phase 2: Find STREAM_ONLY recordings expiring soon (for notifications)
        const expiringStreamOnly =
          await RecordingTransferService.getExpiringStreamOnlyRecordings(3);
        return { transferResult, expiringStreamOnly };
      },
    );

    // STR-3 — warn consultants whose STREAM_ONLY recordings are about to expire.
    if (expiringStreamOnly.length > 0) {
      streamLogger.info("STREAM_ONLY recordings expiring soon", {
        count: expiringStreamOnly.length,
      });
      await notifyConsultantsOfExpiringRecordings(expiringStreamOnly);
    }

    Sentry.logger.info("cron:transfer-expiring-recordings finished", {
      transferred: transferResult.succeeded,
      failed: transferResult.failed,
      expiringStreamOnly: expiringStreamOnly.length,
    });
    return NextResponse.json({
      success: true,
      transferred: transferResult.succeeded,
      failed: transferResult.failed,
      expiringStreamOnly: expiringStreamOnly.length,
      errors: transferResult.errors,
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
      tags: { subsystem: "cron", job: "transfer-expiring-recordings" },
    });
    streamLogger.error("Transfer expiring recordings cron failed", error);
    return NextResponse.json({ error: "Cron job failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return GET(req);
}
