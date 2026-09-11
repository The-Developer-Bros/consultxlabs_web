/**
 * Payment-Earning Sync Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/sync-payment-earnings.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * GitHub Issue: #303
 * Runs hourly via scheduled workflow.
 */

import {
  syncPaymentEarnings,
  disconnectDatabase,
  type PaymentEarningSyncResult,
} from "../../scripts/earnings/sync-payment-earnings";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: PaymentEarningSyncResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `total_processed=${result.totalProcessed}`,
      `created_count=${result.createdCount}`,
      `skipped_count=${result.skippedCount}`,
      `error_count=${result.errorCount}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (!result.success) {
    console.log(
      `::error::Payment-earning sync completed with errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("sync-payment-earnings");
  Sentry.logger.info("job:sync-payment-earnings started");
  console.log("🔄 Starting payment-earning sync job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await syncPaymentEarnings();

    console.log("\n📊 Sync Results:");
    console.log(`   Total Processed: ${result.totalProcessed}`);
    console.log(`   Created: ${result.createdCount}`);
    console.log(`   Skipped: ${result.skippedCount}`);
    console.log(`   Errors: ${result.errorCount}`);
    console.log(`   Success: ${result.success}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    outputToGitHubActions(result);

    Sentry.logger.info("job:sync-payment-earnings finished", {
      totalProcessed: result.totalProcessed,
      createdCount: result.createdCount,
      skippedCount: result.skippedCount,
      errorCount: result.errorCount,
    });

    if (!result.success) {
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
}

runJob("sync-payment-earnings", main);
