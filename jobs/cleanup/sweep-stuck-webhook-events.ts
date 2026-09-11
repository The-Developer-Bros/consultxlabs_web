/**
 * B5 stuck-webhook sweeper (GitHub Actions wrapper) — #785, task #10.
 *
 * Thin wrapper around scripts/cleanup/sweep-stuck-webhook-events.ts. Re-drives
 * WebhookEvent rows left processed=false after an after()-callback crash so the
 * money side-effects (invoice paid, wallet credited, dispute settled, overage
 * charged) actually land instead of relying on a gateway redelivery that never
 * comes. Runs every ~10 minutes via scheduled workflow.
 */
import {
  sweepStuckWebhookEvents,
  disconnectDatabase,
  type SweepResult,
} from "../../scripts/cleanup/sweep-stuck-webhook-events";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

function outputToGitHubActions(result: SweepResult): void {
  if (!process.env.GITHUB_ACTIONS) return;
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `scanned=${result.scanned}`,
      `recovered=${result.recovered}`,
      `still_failing=${result.stillFailing}`,
      `success=${result.success}`,
    ].join("\n");
    fs.appendFileSync(outputFile, outputs + "\n");
  }
  if (result.recovered > 0) {
    console.log(`::notice::Re-drove ${result.recovered} stuck webhook event(s)`);
  }
  if (result.stillFailing > 0) {
    console.log(
      `::warning::${result.stillFailing} webhook event(s) still failing after re-drive: ${result.errors.join("; ")}`,
    );
  }
}

async function main(): Promise<void> {
  await abortIfMaintenance("sweep-stuck-webhook-events");
  Sentry.logger.info("job:sweep-stuck-webhook-events started");
  console.log("🧹 Starting stuck-webhook sweep...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await sweepStuckWebhookEvents();

    console.log("\n📊 Job Results:");
    console.log(`   Scanned: ${result.scanned}`);
    console.log(`   Recovered: ${result.recovered}`);
    console.log(`   Still failing: ${result.stillFailing}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    Sentry.logger.info("job:sweep-stuck-webhook-events finished", {
      scanned: result.scanned,
      recovered: result.recovered,
      stillFailing: result.stillFailing,
    });
    outputToGitHubActions(result);
  } finally {
    await disconnectDatabase();
  }
}

runJob("sweep-stuck-webhook-events", main);
