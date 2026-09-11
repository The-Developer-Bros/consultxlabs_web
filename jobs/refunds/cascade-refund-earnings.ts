/**
 * Refund-Earning Cascade Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/cascade-refund-earnings.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * GitHub Issue: #305
 * Runs every 15 minutes via scheduled workflow.
 */

import {
  cascadeRefundToEarnings,
  disconnectDatabase,
  type RefundEarningCascadeResult,
} from "../../scripts/refunds/cascade-refund-earnings";
import { cascadeRunFailed } from "../../scripts/refunds/cascade-run-outcome";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: RefundEarningCascadeResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `total_processed=${result.totalProcessed}`,
      `updated_count=${result.updatedCount}`,
      `skipped_count=${result.skippedCount}`,
      `error_count=${result.errorCount}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (!result.success) {
    console.log(
      `::error::Refund-earning cascade completed with errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("cascade-refund-earnings");
  Sentry.logger.info("job:cascade-refund-earnings started");
  console.log("🔄 Starting refund-earning cascade job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await cascadeRefundToEarnings();

    console.log("\n📊 Cascade Results:");
    console.log(`   Total Processed: ${result.totalProcessed}`);
    console.log(`   Updated: ${result.updatedCount}`);
    console.log(`   Skipped: ${result.skippedCount}`);
    console.log(`   Errors: ${result.errorCount}`);
    console.log(`   Success: ${result.success}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    outputToGitHubActions(result);

    // PM-34 — result.success === false means some SUCCEEDED refunds failed
    // their cascade; a green exit reads as healthy to the cron monitor and
    // never pages. Non-zero exitCode (NOT process.exit() — that would kill
    // the Sentry flush; see lib/observability/job-sentry).
    if (cascadeRunFailed(result)) {
      process.exitCode = 1;
      return;
    }

    Sentry.logger.info("job:cascade-refund-earnings finished", {
      totalProcessed: result.totalProcessed,
      updatedCount: result.updatedCount,
      skippedCount: result.skippedCount,
      errorCount: result.errorCount,
    });
  } finally {
    await disconnectDatabase();
  }
}

runJob("cascade-refund-earnings", main);
