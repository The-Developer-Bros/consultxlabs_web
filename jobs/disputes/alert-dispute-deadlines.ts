/**
 * Dispute Deadline Alerts Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/alert-dispute-deadlines.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs hourly via scheduled workflow.
 */

import {
  alertDisputeDeadlines,
  disconnectDatabase,
  type DisputeDeadlineAlertResult,
} from "../../scripts/disputes/alert-dispute-deadlines";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: DisputeDeadlineAlertResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `urgent_count=${result.urgentCount}`,
      `critical_count=${result.criticalCount}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (result.criticalCount > 0) {
    console.log(
      `::error::${result.criticalCount} CRITICAL disputes need immediate attention!`,
    );
  } else if (result.urgentCount > 0) {
    console.log(
      `::warning::${result.urgentCount} disputes have deadlines within 48 hours`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("alert-dispute-deadlines");
  Sentry.logger.info("job:alert-dispute-deadlines started");
  console.log("🔔 Starting dispute deadline alert check...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await alertDisputeDeadlines();

    console.log("\n📊 Alert Results:");
    console.log(`   Urgent Disputes: ${result.urgentCount}`);
    console.log(`   Critical: ${result.criticalCount}`);

    if (result.disputes.length > 0) {
      console.log("\n📋 Dispute Details:");
      result.disputes.forEach((d) => {
        console.log(
          `   - ${d.disputeId}: ${d.currency} ${(d.amount / 100).toFixed(2)} (${d.hoursRemaining}h remaining)`,
        );
      });
    }

    outputToGitHubActions(result);
    Sentry.logger.info("job:alert-dispute-deadlines finished", {
      urgentCount: result.urgentCount,
      criticalCount: result.criticalCount,
    });

    // Exit with error if critical disputes found (to trigger notifications)
    if (result.criticalCount > 0) {
      console.log("\n🚨 Exiting with error status due to critical disputes");
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
}

runJob("alert-dispute-deadlines", main);
