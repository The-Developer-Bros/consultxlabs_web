/**
 * Webhook Event Archive Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/archive-webhook-events.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs weekly (Sunday midnight) via scheduled workflow.
 */

import {
  archiveWebhookEvents,
  disconnectDatabase,
  type WebhookArchiveResult,
} from "../../scripts/cleanup/archive-webhook-events";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: WebhookArchiveResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `processed_deleted=${result.processedEventsDeleted}`,
      `failed_deleted=${result.failedEventsDeleted}`,
      `total_deleted=${result.totalDeleted}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (result.totalDeleted > 0) {
    console.log(
      `::notice::Archived ${result.totalDeleted} webhook events (${result.processedEventsDeleted} processed, ${result.failedEventsDeleted} failed)`,
    );
  }

  if (!result.success) {
    console.log(
      `::warning::Webhook archive had errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("archive-webhook-events");
  Sentry.logger.info("job:archive-webhook-events started");
  console.log("🗄️ Starting webhook event archive job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await archiveWebhookEvents();

    console.log("\n📊 Job Results:");
    console.log(
      `   Processed Events Deleted: ${result.processedEventsDeleted}`,
    );
    console.log(`   Failed Events Deleted: ${result.failedEventsDeleted}`);
    console.log(`   Total Deleted: ${result.totalDeleted}`);
    console.log(`   Success: ${result.success}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    Sentry.logger.info("job:archive-webhook-events finished", {
      processedDeleted: result.processedEventsDeleted,
      failedDeleted: result.failedEventsDeleted,
      totalDeleted: result.totalDeleted,
    });
    outputToGitHubActions(result);

    if (!result.success) {
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
}

runJob("archive-webhook-events", main);
