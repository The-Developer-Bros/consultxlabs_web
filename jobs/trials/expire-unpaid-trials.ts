/**
 * Unpaid Trial Expiry Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/trials/expire-unpaid-trials.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs hourly via scheduled workflow.
 */

import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";
import fs from "fs";

import { abortIfMaintenance } from "../../lib/maintenance-cron";
import {
  disconnectDatabase,
  expireUnpaidTrials,
  type ExpireUnpaidTrialsResult,
} from "../../scripts/trials/expire-unpaid-trials";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: ExpireUnpaidTrialsResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `trials_expired=${result.trialsExpired}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (result.trialsExpired > 0) {
    console.log(
      `::notice::Expired ${result.trialsExpired} unpaid trial sessions`,
    );
  }

  if (!result.success) {
    console.log(
      `::warning::Unpaid trial expiry had errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("expire-unpaid-trials");
  Sentry.logger.info("job:expire-unpaid-trials started");
  console.log("🧹 Starting unpaid trial expiry job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await expireUnpaidTrials();

    console.log("\n📊 Job Results:");
    console.log(`   Trials Expired: ${result.trialsExpired}`);
    console.log(`   Success: ${result.success}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    outputToGitHubActions(result);

    Sentry.logger.info("job:expire-unpaid-trials finished", {
      trialsExpired: result.trialsExpired,
    });

    if (!result.success) {
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
}

runJob("expire-unpaid-trials", main);
