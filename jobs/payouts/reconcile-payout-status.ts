/**
 * Payout Status Reconciliation Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/reconcile-payout-status.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs every 6 hours via scheduled workflow.
 */

import {
  reconcilePayoutStatus,
  disconnectDatabase,
  type PayoutReconciliationResult,
} from "../../scripts/payouts/reconcile-payout-status";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: PayoutReconciliationResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `total_processed=${result.totalProcessed}`,
      `reconciled_count=${result.reconciledCount}`,
      `completed_count=${result.completedCount}`,
      `failed_count=${result.failedCount}`,
      `skipped_count=${result.skippedCount}`,
      `discrepancies_count=${result.discrepancies.length}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  // #677 PM-1 — match the canonical name the underlying script reads
  if (
    !process.env.RAZORPAY_KEY_ID ||
    !(process.env.RAZORPAY_SECRET ?? process.env.RAZORPAY_KEY_SECRET)
  ) {
    console.log(
      `::warning::Razorpay credentials not configured — Razorpay records were skipped`,
    );
  }

  if (result.discrepancies.length > 0) {
    console.log(
      `::warning::${result.discrepancies.length} payout status discrepancies found and reconciled!`,
    );
  }

  if (result.completedCount > 0) {
    console.log(
      `::notice::${result.completedCount} payouts found completed on gateway (were stuck in DB)`,
    );
  }

  if (result.failedCount > 0) {
    console.log(
      `::warning::${result.failedCount} payouts failed - consultants may need notification!`,
    );
  }

  if (!result.success) {
    console.log(
      `::error::Payout reconciliation completed with errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("reconcile-payout-status");
  Sentry.logger.info("job:reconcile-payout-status started");
  console.log("🔄 Starting payout status reconciliation job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await reconcilePayoutStatus();

    console.log("\n📊 Reconciliation Results:");
    console.log(`   Total Processed: ${result.totalProcessed}`);
    console.log(`   Reconciled: ${result.reconciledCount}`);
    console.log(`   Completed: ${result.completedCount}`);
    console.log(`   Failed: ${result.failedCount}`);
    console.log(`   Skipped: ${result.skippedCount}`);
    console.log(`   Discrepancies: ${result.discrepancies.length}`);
    console.log(`   Success: ${result.success}`);

    if (result.discrepancies.length > 0) {
      console.log("\n⚠️ Discrepancies:");
      result.discrepancies.forEach((d) => console.log(`   - ${d}`));
    }

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    outputToGitHubActions(result);

    Sentry.logger.info("job:reconcile-payout-status finished", {
      totalProcessed: result.totalProcessed,
      reconciledCount: result.reconciledCount,
      completedCount: result.completedCount,
      failedCount: result.failedCount,
      skippedCount: result.skippedCount,
      discrepanciesCount: result.discrepancies.length,
      success: result.success,
    });

    if (!result.success) {
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
}

runJob("reconcile-payout-status", main);
