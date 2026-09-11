/**
 * Stale Pending Consultations Cleanup Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/cleanup-stale-pending-consultations.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs hourly via scheduled workflow.
 */

import {
  cleanupStalePendingConsultations,
  disconnectDatabase,
  type StalePendingConsultationsResult,
} from "../../scripts/appointments/cleanup-stale-pending-consultations";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: StalePendingConsultationsResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `consultations_cancelled=${result.consultationsCancelled}`,
      `slots_released=${result.slotsReleased}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (result.consultationsCancelled > 0) {
    console.log(
      `::notice::Cancelled ${result.consultationsCancelled} stale pending consultations`,
    );
  }

  if (!result.success) {
    console.log(
      `::warning::Stale consultation cleanup had errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("cleanup-stale-pending-consultations");
  Sentry.logger.info("job:cleanup-stale-pending-consultations started");
  console.log("🧹 Starting stale pending consultations cleanup job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await cleanupStalePendingConsultations();

    console.log("\n📊 Job Results:");
    console.log(`   Consultations Cancelled: ${result.consultationsCancelled}`);
    console.log(`   Slots Released: ${result.slotsReleased}`);
    console.log(`   Success: ${result.success}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    outputToGitHubActions(result);

    Sentry.logger.info("job:cleanup-stale-pending-consultations finished", {
      consultationsCancelled: result.consultationsCancelled,
      slotsReleased: result.slotsReleased,
    });

    if (!result.success) {
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
}

runJob("cleanup-stale-pending-consultations", main);
