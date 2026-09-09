/**
 * Refund Reconciliation Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/reconcile-pending-refunds.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs every 15 minutes via scheduled workflow.
 */

import {
  reconcilePendingRefunds,
  notifyFailedRefunds,
  disconnectDatabase,
  type RefundReconciliationResult,
} from "../../scripts/refunds/reconcile-pending-refunds";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: RefundReconciliationResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `total_processed=${result.totalProcessed}`,
      `reconciled_count=${result.reconciledCount}`,
      `failed_count=${result.failedCount}`,
      `skipped_count=${result.skippedCount}`,
      // #1458 — surfaced as its own output so a workflow can alert on refunds
      // stranded behind a gateway fence without parsing the log.
      `skipped_fenced=${result.skippedFenced}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (!result.success) {
    console.log(
      `::error::Refund reconciliation completed with errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("reconcile-pending-refunds");
  Sentry.logger.info("job:reconcile-pending-refunds started");
  console.log("🔄 Starting refund reconciliation job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await reconcilePendingRefunds();

    console.log("\n📊 Reconciliation Results:");
    console.log(`   Total Processed: ${result.totalProcessed}`);
    console.log(`   Reconciled: ${result.reconciledCount}`);
    console.log(`   Failed: ${result.failedCount}`);
    console.log(`   Skipped: ${result.skippedCount}`);
    console.log(`   Success: ${result.success}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    outputToGitHubActions(result);

    // #779 §A — page payers of FAILED refunds that haven't been notified yet.
    // Runs after reconciliation (which can itself FLIP a stale PENDING refund
    // to FAILED) so a just-failed refund is caught in the same pass.
    const failedNotify = await notifyFailedRefunds();
    console.log(
      `\n📨 Failed-refund notifications: scanned=${failedNotify.scanned} notified=${failedNotify.notified}`,
    );

    Sentry.logger.info("job:reconcile-pending-refunds finished", {
      totalProcessed: result.totalProcessed,
      reconciledCount: result.reconciledCount,
      failedCount: result.failedCount,
      skippedCount: result.skippedCount,
    });

    if (!result.success) {
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
}

runJob("reconcile-pending-refunds", main);
