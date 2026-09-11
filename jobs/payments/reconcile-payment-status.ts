/**
 * Payment Status Reconciliation Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/reconcile-payment-status.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs every 30 minutes via scheduled workflow.
 */

import {
  reconcilePaymentStatus,
  disconnectDatabase,
  type PaymentReconciliationResult,
} from "../../scripts/payments/reconcile-payment-status";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: PaymentReconciliationResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `total_processed=${result.totalProcessed}`,
      `reconciled_count=${result.reconciledCount}`,
      `succeeded_count=${result.succeededCount}`,
      `failed_count=${result.failedCount}`,
      `expired_count=${result.expiredCount}`,
      `skipped_count=${result.skippedCount}`,
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

  if (result.succeededCount > 0) {
    console.log(
      `::warning::${result.succeededCount} payments found succeeded - may need manual appointment creation!`,
    );
  }

  if (!result.success) {
    console.log(
      `::error::Payment reconciliation completed with errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("reconcile-payment-status");
  Sentry.logger.info("job:reconcile-payment-status started");
  console.log("🔄 Starting payment status reconciliation job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await reconcilePaymentStatus();

    console.log("\n📊 Reconciliation Results:");
    console.log(`   Total Processed: ${result.totalProcessed}`);
    console.log(`   Reconciled: ${result.reconciledCount}`);
    console.log(`   Succeeded (needs review): ${result.succeededCount}`);
    console.log(`   Failed: ${result.failedCount}`);
    console.log(`   Expired: ${result.expiredCount}`);
    console.log(`   Skipped: ${result.skippedCount}`);
    console.log(`   Success: ${result.success}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    outputToGitHubActions(result);

    Sentry.logger.info("job:reconcile-payment-status finished", {
      totalProcessed: result.totalProcessed,
      reconciledCount: result.reconciledCount,
      succeededCount: result.succeededCount,
      failedCount: result.failedCount,
      expiredCount: result.expiredCount,
      skippedCount: result.skippedCount,
    });

    if (!result.success) {
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
}

runJob("reconcile-payment-status", main);
