/**
 * Stuck Payouts Handler Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/handle-stuck-payouts.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs every 4 hours via scheduled workflow.
 */

import {
  handleStuckPayouts,
  disconnectDatabase,
  type StuckPayoutsResult,
} from "../../scripts/payouts/handle-stuck-payouts";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import {
  recordSystemEvent,
  recordSystemError,
} from "../../lib/enterprise/system-events";
import { CronLockHeldError } from "../../lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: StuckPayoutsResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `total_processed=${result.totalProcessed}`,
      `reconciled_count=${result.reconciledCount}`,
      `retried_count=${result.retriedCount}`,
      `failed_count=${result.failedCount}`,
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

  if (result.failedCount > 0) {
    console.log(
      `::warning::${result.failedCount} payouts permanently failed after max retries`,
    );
  }

  if (!result.success) {
    console.log(
      `::error::Stuck payouts handler completed with errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("handle-stuck-payouts");
  Sentry.logger.info("job:handle-stuck-payouts started");
  console.log("🔄 Starting stuck payouts handler job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await handleStuckPayouts();

    console.log("\n📊 Handler Results:");
    console.log(`   Total Processed: ${result.totalProcessed}`);
    console.log(`   Reconciled: ${result.reconciledCount}`);
    console.log(`   Retried: ${result.retriedCount}`);
    console.log(`   Failed: ${result.failedCount}`);
    console.log(`   Skipped: ${result.skippedCount}`);
    console.log(`   Success: ${result.success}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    outputToGitHubActions(result);

    Sentry.logger.info("job:handle-stuck-payouts finished", {
      totalProcessed: result.totalProcessed,
      reconciledCount: result.reconciledCount,
      retriedCount: result.retriedCount,
      failedCount: result.failedCount,
      skippedCount: result.skippedCount,
    });

    // #776 §K — stuck/failed payouts mean a consultant isn't getting paid;
    // page on it rather than leaving it in CI logs.
    if (result.failedCount > 0 || !result.success) {
      await recordSystemEvent({
        category: "PAYOUT",
        severity: "ERROR",
        message: `Stuck-payout handler: ${result.failedCount} permanently failed, success=${result.success}`,
        context: {
          totalProcessed: result.totalProcessed,
          failedCount: result.failedCount,
          retriedCount: result.retriedCount,
          errors: result.errors,
        },
      });
    }

    if (!result.success) {
      process.exitCode = 1;
    }
  } catch (error) {
    // #776 §K — a crashed handler means a consultant isn't getting paid, so it
    // goes to the telemetry sink as well. Everything generic (capture, job tag,
    // step annotation, exit code, lock-held skip) is runJob's. (#1066)
    if (!(error instanceof CronLockHeldError)) {
      await recordSystemError({
        category: "PAYOUT",
        summary: "Stuck-payout handler crashed",
        err: error,
      });
    }
    throw error;
  } finally {
    await disconnectDatabase();
  }
}

runJob("handle-stuck-payouts", main);
