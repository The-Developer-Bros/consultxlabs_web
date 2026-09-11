/**
 * Abandoned Payment Cleanup Job (GitHub Actions Version)
 *
 * Thin wrapper around the core cleanup logic in scripts/cleanup-abandoned-payments.ts.
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs every 15 minutes via scheduled workflow.
 */

import {
  cleanupAbandonedPayments,
  cleanupExpiredApprovalPendingPayments,
  disconnectDatabase,
  type CleanupResult,
} from "../../scripts/payments/cleanup-abandoned-payments";

import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

/**
 * Output results to GitHub Actions using environment files
 * See: https://github.blog/changelog/2022-10-11-github-actions-deprecating-save-state-and-set-output-commands/
 */
function outputToGitHubActions(
  paymentResult: CleanupResult,
  consultationResult: CleanupResult,
  overallSuccess: boolean,
): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `cleaned_count=${paymentResult.cleanedCount}`,
      `error_count=${paymentResult.errorCount}`,
      `total_processed=${paymentResult.totalProcessed}`,
      `consultation_cleaned_count=${consultationResult.cleanedCount}`,
      `consultation_error_count=${consultationResult.errorCount}`,
      `success=${overallSuccess}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (!overallSuccess) {
    const allErrors = [
      ...paymentResult.errors,
      ...consultationResult.errors,
    ].join("; ");
    console.log(`::error::Cleanup job completed with errors: ${allErrors}`);
  }
}

/**
 * Entry point for GitHub Actions
 */
async function main(): Promise<void> {
  await abortIfMaintenance("cleanup-abandoned-payments");
  Sentry.logger.info("job:cleanup-abandoned-payments started");
  const startTime = Date.now();
  console.log(`🚀 Starting cleanup job at ${new Date().toISOString()}`);

  try {
    // Run abandoned payment cleanup
    const paymentResult = await cleanupAbandonedPayments();

    // Run expired consultation cleanup
    const consultationResult = await cleanupExpiredApprovalPendingPayments();

    const duration = (Date.now() - startTime) / 1000;
    console.log(`⏱️ Job completed in ${duration.toFixed(2)} seconds`);

    // Combined summary
    console.log(`\n📊 Overall Cleanup Summary:`);
    console.log(
      `   🧹 Abandoned payments cleaned: ${paymentResult.cleanedCount}`,
    );
    console.log(
      `   🧹 Expired consultations reset: ${consultationResult.cleanedCount}`,
    );
    console.log(
      `   ❌ Total errors: ${paymentResult.errorCount + consultationResult.errorCount}`,
    );

    // Determine overall success
    const overallSuccess = paymentResult.success && consultationResult.success;

    // Output to GitHub Actions
    outputToGitHubActions(paymentResult, consultationResult, overallSuccess);

    if (overallSuccess) {
      Sentry.logger.info("job:cleanup-abandoned-payments finished", {
        cleanedCount: paymentResult.cleanedCount,
        errorCount: paymentResult.errorCount,
        totalProcessed: paymentResult.totalProcessed,
        consultationCleanedCount: consultationResult.cleanedCount,
        consultationErrorCount: consultationResult.errorCount,
      });
      console.log("🎉 Cleanup job completed successfully");
    } else {
      console.error("❌ Cleanup job completed with errors");
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
}

// Run the cleanup job
runJob("cleanup-abandoned-payments", main);
