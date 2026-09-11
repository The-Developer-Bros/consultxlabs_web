/**
 * Lost Dispute Handler Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/handle-lost-disputes.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * GitHub Issue: #304
 * Runs every 6 hours via scheduled workflow.
 */

import {
  handleLostDisputes,
  disconnectDatabase,
  type LostDisputeHandlerResult,
} from "../../scripts/disputes/handle-lost-disputes";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: LostDisputeHandlerResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `total_processed=${result.totalProcessed}`,
      `updated_count=${result.updatedCount}`,
      `skipped_count=${result.skippedCount}`,
      `already_paid_count=${result.alreadyPaidCount}`,
      `error_count=${result.errorCount}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  // Critical: Alert if any earnings were already paid
  if (result.alreadyPaidCount > 0) {
    console.log(
      `::warning::${result.alreadyPaidCount} earnings were already PAID when dispute was lost - manual recovery required!`,
    );
  }

  if (!result.success) {
    console.log(
      `::error::Lost dispute handler completed with errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("handle-lost-disputes");
  Sentry.logger.info("job:handle-lost-disputes started");
  console.log("🔄 Starting lost dispute handler job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await handleLostDisputes();

    console.log("\n📊 Handler Results:");
    console.log(`   Total Processed: ${result.totalProcessed}`);
    console.log(`   Updated: ${result.updatedCount}`);
    console.log(`   Skipped: ${result.skippedCount}`);
    console.log(`   Already Paid (CRITICAL): ${result.alreadyPaidCount}`);
    console.log(`   Errors: ${result.errorCount}`);
    console.log(`   Success: ${result.success}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    Sentry.logger.info("job:handle-lost-disputes finished", {
      totalProcessed: result.totalProcessed,
      updatedCount: result.updatedCount,
      skippedCount: result.skippedCount,
      alreadyPaidCount: result.alreadyPaidCount,
      errorCount: result.errorCount,
    });
    outputToGitHubActions(result);

    // Exit with error if we have critical cases
    if (!result.success || result.alreadyPaidCount > 0) {
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
}

runJob("handle-lost-disputes", main);
