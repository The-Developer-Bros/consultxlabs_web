/**
 * Deactivate Expired Discounts Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/deactivate-expired-discounts.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs daily at midnight via scheduled workflow.
 */

import {
  deactivateExpiredDiscounts,
  disconnectDatabase,
  type ExpiredDiscountsResult,
} from "../../scripts/cleanup/deactivate-expired-discounts";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: ExpiredDiscountsResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `expired_by_date=${result.expiredByDateCount}`,
      `max_uses_reached=${result.maxUsesReachedCount}`,
      `total_deactivated=${result.totalDeactivated}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (result.totalDeactivated > 0) {
    console.log(
      `::notice::Deactivated ${result.totalDeactivated} discount codes (${result.expiredByDateCount} expired, ${result.maxUsesReachedCount} maxed out)`,
    );
  }

  if (!result.success) {
    console.log(
      `::warning::Discount deactivation had errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("deactivate-expired-discounts");
  Sentry.logger.info("job:deactivate-expired-discounts started");
  console.log("🏷️ Starting expired discount code deactivation job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await deactivateExpiredDiscounts();

    console.log("\n📊 Job Results:");
    console.log(`   Expired by Date: ${result.expiredByDateCount}`);
    console.log(`   Max Uses Reached: ${result.maxUsesReachedCount}`);
    console.log(`   Total Deactivated: ${result.totalDeactivated}`);
    console.log(`   Success: ${result.success}`);

    if (result.deactivatedCodes.length > 0) {
      console.log("\n   Deactivated Codes:");
      result.deactivatedCodes.forEach((c) => console.log(`      - ${c}`));
    }

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    outputToGitHubActions(result);

    Sentry.logger.info("job:deactivate-expired-discounts finished", {
      expiredByDateCount: result.expiredByDateCount,
      maxUsesReachedCount: result.maxUsesReachedCount,
      totalDeactivated: result.totalDeactivated,
    });

    if (!result.success) {
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
}

runJob("deactivate-expired-discounts", main);
