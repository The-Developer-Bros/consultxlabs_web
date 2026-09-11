/**
 * Orphaned Payments Alert Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/alert-orphaned-payments.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs every 6 hours via scheduled workflow.
 */

import {
  alertOrphanedPayments,
  disconnectDatabase,
  type OrphanedPaymentsAlertResult,
} from "../../scripts/alerts/alert-orphaned-payments";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: OrphanedPaymentsAlertResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `total_orphaned=${result.totalOrphaned}`,
      `critical_count=${result.criticalCount}`,
      `total_amount=${result.totalAmount}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  // CRITICAL warning if orphaned payments found
  if (result.totalOrphaned > 0) {
    console.log(
      `::error::CRITICAL: ${result.totalOrphaned} orphaned payments found! Customers charged but no appointment created. Total amount: ${(result.totalAmount / 100).toFixed(2)}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("alert-orphaned-payments");
  Sentry.logger.info("job:alert-orphaned-payments started");
  console.log("🔍 Starting orphaned payments alert job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await alertOrphanedPayments();

    console.log("\n📊 Alert Results:");
    console.log(`   Total Orphaned: ${result.totalOrphaned}`);
    console.log(`   Critical Count: ${result.criticalCount}`);
    console.log(`   Total Amount: ${(result.totalAmount / 100).toFixed(2)}`);
    console.log(`   Success: ${result.success}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    outputToGitHubActions(result);

    Sentry.logger.info("job:alert-orphaned-payments finished", {
      totalOrphaned: result.totalOrphaned,
      criticalCount: result.criticalCount,
      totalAmount: result.totalAmount,
      success: result.success,
    });

    // Exit with error code if orphaned payments found (to trigger alerts)
    if (result.totalOrphaned > 0) {
      console.log("\n⚠️ Exiting with code 1 to trigger workflow failure alert");
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
}

runJob("alert-orphaned-payments", main);
