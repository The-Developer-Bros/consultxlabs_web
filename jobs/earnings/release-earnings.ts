/**
 * Release Earnings Job (GitHub Actions Version)
 *
 * Thin wrapper around the core release logic in scripts/release-earnings.ts.
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs hourly via scheduled workflow.
 */

import {
  releaseEarningsFromHold,
  disconnectDatabase,
  type ReleaseResult,
} from "../../scripts/earnings/release-earnings";

import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

/**
 * Output results to GitHub Actions using environment files
 */
function outputToGitHubActions(result: ReleaseResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `released_count=${result.releasedCount}`,
      // #1471 — host-org earnings are released by the same run; a separate
      // output keeps `released_count` meaning what downstream steps expect.
      `org_released_count=${result.organizationEarningsReleased}`,
      `error_count=${result.errorCount}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (!result.success) {
    const allErrors = result.errors.join("; ");
    console.log(
      `::error::Release earnings job completed with errors: ${allErrors}`,
    );
  }
}

/**
 * Entry point for GitHub Actions
 */
async function main(): Promise<void> {
  await abortIfMaintenance("release-earnings");
  Sentry.logger.info("job:release-earnings started");
  const startTime = Date.now();
  console.log(
    `🚀 Starting release earnings job at ${new Date().toISOString()}`,
  );

  try {
    // Run earnings release
    const result = await releaseEarningsFromHold();

    const duration = (Date.now() - startTime) / 1000;
    console.log(`⏱️ Job completed in ${duration.toFixed(2)} seconds`);

    // Summary
    console.log(`\n📊 Release Summary:`);
    console.log(`   ✅ Consultant earnings released: ${result.releasedCount}`);
    console.log(
      `   ✅ Organization earnings released: ${result.organizationEarningsReleased}`,
    );
    console.log(`   ❌ Errors: ${result.errorCount}`);

    // Output to GitHub Actions
    outputToGitHubActions(result);

    if (result.success) {
      Sentry.logger.info("job:release-earnings finished", { releasedCount: result.releasedCount, organizationEarningsReleased: result.organizationEarningsReleased, errorCount: result.errorCount });
      console.log("🎉 Release earnings job completed successfully");
    } else {
      console.error("❌ Release earnings job completed with errors");
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
}

// Run the job
runJob("release-earnings", main);
