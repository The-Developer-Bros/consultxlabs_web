/**
 * Tentative Slot Cleanup Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/cleanup-tentative-slots.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs every 2 hours via scheduled workflow.
 */

import {
  cleanupTentativeSlots,
  disconnectDatabase,
  type TentativeSlotCleanupResult,
} from "../../scripts/appointments/cleanup-tentative-slots";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: TentativeSlotCleanupResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `slots_released=${result.slotsReleased}`,
      `appointments_affected=${result.appointmentsAffected}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (result.slotsReleased > 0) {
    console.log(
      `::notice::Released ${result.slotsReleased} stale tentative slots`,
    );
  }

  if (!result.success) {
    console.log(
      `::warning::Tentative slot cleanup had errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("cleanup-tentative-slots");
  Sentry.logger.info("job:cleanup-tentative-slots started");
  console.log("🧹 Starting tentative slot cleanup job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await cleanupTentativeSlots();

    console.log("\n📊 Job Results:");
    console.log(`   Slots Released: ${result.slotsReleased}`);
    console.log(`   Appointments Affected: ${result.appointmentsAffected}`);
    console.log(`   Success: ${result.success}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    outputToGitHubActions(result);

    if (!result.success) {
      process.exitCode = 1;
      return;
    }

    Sentry.logger.info("job:cleanup-tentative-slots finished", {
      slotsReleased: result.slotsReleased,
      appointmentsAffected: result.appointmentsAffected,
    });
  } finally {
    await disconnectDatabase();
  }
}

runJob("cleanup-tentative-slots", main);
