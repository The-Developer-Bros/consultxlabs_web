/**
 * Transfer Expiring Recordings Job (GitHub Actions Wrapper)
 *
 * Auto-transfers PERMANENT recordings from Stream S3 to Supabase.
 * Also identifies STREAM_ONLY recordings expiring soon for warnings.
 *
 * Runs every 6 hours via scheduled workflow.
 */

import { RecordingTransferService } from "../../lib/stream/recording-transfer-service";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { withCronLock } from "../../lib/cron/with-cron-lock";
import { notifyRecordingExpiring } from "../../lib/novu/service";
import { getAppUrl } from "../../lib/url";
import fs from "fs";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

// STR-3 — one expiry warning per consultant (count + soonest deadline), so a
// consultant with several expiring STREAM_ONLY recordings isn't spammed.
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
      return notifyRecordingExpiring(consultantUserId, {
        recordingCount: recs.length,
        expiresAt: soonest.toISOString(),
        dashboardUrl,
      });
    }),
  );
}

async function main(): Promise<void> {
  await abortIfMaintenance("transfer-expiring-recordings");
  Sentry.logger.info("job:transfer-expiring-recordings started");
  const startTime = Date.now();
  console.log("🚀 Starting transfer-expiring-recordings job...");
  console.log(`   Timestamp: ${new Date().toISOString()}`);

  // #476 — both steps under one entry-level lock; fail-open.
  const { result, expiringStreamOnly } = await withCronLock(
    "transfer-expiring-recordings",
    { failMode: "open" },
    async () => {
      // #899 — 14-day window = every READY permanent recording (Stream URLs
      // live exactly 14d), so the sweep starts transfers near-ready and
      // backstops ready-time webhook kicks that died, not just near-expiry.
      const result =
        await RecordingTransferService.processExpiringRecordings(
          14,
          10,
          "PERMANENT",
        );

      // Find STREAM_ONLY recordings expiring in 3 days (for warnings)
      const expiringStreamOnly =
        await RecordingTransferService.getExpiringStreamOnlyRecordings(3);
      return { result, expiringStreamOnly };
    },
  );

  // STR-3 — warn consultants whose STREAM_ONLY recordings are about to expire.
  if (expiringStreamOnly.length > 0) {
    await notifyConsultantsOfExpiringRecordings(expiringStreamOnly);
  }

  // #899 — backlog alert: permanent recordings <72h from Stream expiry that
  // this sweep still left untransferred. Non-zero means the pipeline is
  // falling behind or failing repeatedly; page before the bytes lapse.
  const atRisk =
    await RecordingTransferService.countAtRiskPermanentRecordings(72);
  if (atRisk > 0) {
    console.warn(
      `⚠️ ${atRisk} permanent recording(s) <72h from Stream expiry, still untransferred`,
    );
    Sentry.captureMessage(
      "Permanent recordings at risk of Stream URL expiry",
      {
        level: "warning",
        tags: { subsystem: "jobs", job: "transfer-expiring-recordings" },
        extra: { atRisk },
      },
    );
  }

  const duration = (Date.now() - startTime) / 1000;
  console.log(`\n⏱️ Job completed in ${duration.toFixed(2)} seconds`);
  console.log(`   Transferred: ${result.succeeded}`);
  console.log(`   Failed: ${result.failed}`);
  console.log(`   STREAM_ONLY expiring soon: ${expiringStreamOnly.length}`);

  if (result.errors.length > 0) {
    console.warn("   Errors:", result.errors.join("; "));
  }

  if (process.env.GITHUB_ACTIONS && process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `transferred=${result.succeeded}\nfailed=${result.failed}\nexpiring_stream_only=${expiringStreamOnly.length}\nsuccess=true\n`,
    );
  }

  Sentry.logger.info("job:transfer-expiring-recordings finished", {
    succeeded: result.succeeded,
    failed: result.failed,
    expiringStreamOnly: expiringStreamOnly.length,
  });

  if (result.failed > 0) {
    console.warn("⚠️ Some transfers failed");
    process.exitCode = 1;
    return;
  }

  console.log("🎉 Job completed successfully");
}

runJob("transfer-expiring-recordings", main);
