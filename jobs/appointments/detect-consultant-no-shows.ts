/**
 * Consultant No-Show Detection Job (GitHub Actions Wrapper) — #471
 *
 * Thin wrapper around scripts/appointments/detect-consultant-no-shows.ts.
 * Adds GitHub Actions outputs + error handling. Runs hourly.
 */

import {
  detectConsultantNoShows,
  disconnectDatabase,
  type NoShowResult,
} from "../../scripts/appointments/detect-consultant-no-shows";
import fs from "node:fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

function outputToGitHubActions(result: NoShowResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `detected=${result.detected}`,
      `refunded=${result.refunded}`,
      `success=${result.success}`,
    ].join("\n");
    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (result.detected > 0) {
    console.log(
      `::notice::Consultant no-shows: ${result.detected} detected, ${result.refunded} refunded`,
    );
  }
  if (!result.success) {
    console.log(`::warning::No-show job had errors: ${result.errors.join("; ")}`);
  }
}

async function main(): Promise<void> {
  await abortIfMaintenance("detect-consultant-no-shows");
  Sentry.logger.info("job:detect-consultant-no-shows started");
  console.log("⏰ Starting consultant no-show detection job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await detectConsultantNoShows();

    console.log("\n📊 Job Results:");
    console.log(`   Detected: ${result.detected}`);
    console.log(`   Refunded: ${result.refunded}`);
    console.log(`   Success: ${result.success}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    outputToGitHubActions(result);

    Sentry.logger.info("job:detect-consultant-no-shows finished", {
      detected: result.detected,
      refunded: result.refunded,
    });

    if (!result.success) {
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
}

runJob("detect-consultant-no-shows", main);
