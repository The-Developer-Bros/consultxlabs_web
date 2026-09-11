/**
 * Invalid Appointments Cleanup Job (GitHub Actions Version)
 *
 * Thin wrapper around the core cleanup logic in scripts/cleanup-invalid-appointments.ts.
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs every hour via scheduled workflow.
 */

import {
  runAllCleanupTasks,
  type CleanupResult,
} from "../../scripts/appointments/cleanup-invalid-appointments";

import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

/**
 * Output results to GitHub Actions using environment files
 * See: https://github.blog/changelog/2022-10-11-github-actions-deprecating-save-state-and-set-output-commands/
 */
function outputToGitHubActions(result: CleanupResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `duplicate_consultations_cancelled=${result.duplicateConsultationsCancelled}`,
      `duplicate_subscriptions_cancelled=${result.duplicateSubscriptionsCancelled}`,
      `invalid_duration_consultations_cancelled=${result.invalidDurationConsultationsCancelled}`,
      `invalid_duration_subscriptions_cancelled=${result.invalidDurationSubscriptionsCancelled}`,
      `total_cancelled=${result.totalCancelled}`,
      `error_count=${result.errors.length}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (!result.success) {
    const allErrors = result.errors.join("; ");
    console.log(`::error::Cleanup job completed with errors: ${allErrors}`);
  }
}

/**
 * Entry point for GitHub Actions
 */
async function main(): Promise<void> {
  await abortIfMaintenance("cleanup-invalid-appointments");
  Sentry.logger.info("job:cleanup-invalid-appointments started");
  const startTime = Date.now();
  console.log(
    `🚀 Starting invalid appointments cleanup job at ${new Date().toISOString()}`,
  );

  // Run all cleanup tasks
  const result = await runAllCleanupTasks();

  const duration = (Date.now() - startTime) / 1000;
  console.log(`⏱️ Job completed in ${duration.toFixed(2)} seconds`);

  // Summary
  console.log(`\n📊 Cleanup Summary:`);
  console.log(
    `   🔄 Duplicate consultations cancelled: ${result.duplicateConsultationsCancelled}`,
  );
  console.log(
    `   🔄 Duplicate subscriptions cancelled: ${result.duplicateSubscriptionsCancelled}`,
  );
  console.log(
    `   ⏱️ Invalid duration consultations cancelled: ${result.invalidDurationConsultationsCancelled}`,
  );
  console.log(
    `   ⏱️ Invalid duration subscriptions cancelled: ${result.invalidDurationSubscriptionsCancelled}`,
  );
  console.log(`   📊 Total cancelled: ${result.totalCancelled}`);
  console.log(`   ❌ Errors: ${result.errors.length}`);

  // Output to GitHub Actions
  outputToGitHubActions(result);

  if (result.success) {
    console.log("🎉 Cleanup job completed successfully");
    Sentry.logger.info("job:cleanup-invalid-appointments finished", {
      duplicateConsultationsCancelled: result.duplicateConsultationsCancelled,
      duplicateSubscriptionsCancelled: result.duplicateSubscriptionsCancelled,
      invalidDurationConsultationsCancelled: result.invalidDurationConsultationsCancelled,
      invalidDurationSubscriptionsCancelled: result.invalidDurationSubscriptionsCancelled,
      totalCancelled: result.totalCancelled,
      errorCount: result.errors.length,
    });
  } else {
    console.error("❌ Cleanup job completed with errors");
    process.exitCode = 1;
  }
  // Note: runAllCleanupTasks() handles database disconnection in its finally block
}

// Run the cleanup job
runJob("cleanup-invalid-appointments", main);
