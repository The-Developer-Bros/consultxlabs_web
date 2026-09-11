/**
 * Captured-but-uncredited wallet top-up reconciler (GitHub Actions wrapper) —
 * #785, task #23. Re-credits gateway-captured top-ups whose confirm/ledger post
 * rolled back (capturedAt set, still PENDING). Runs every 30 minutes.
 */
import {
  sweepOrphanedTopupCaptures,
  disconnectDatabase,
  type TopupCaptureSweepResult,
} from "../../scripts/cleanup/sweep-orphaned-topup-captures";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

function outputToGitHubActions(result: TopupCaptureSweepResult): void {
  if (!process.env.GITHUB_ACTIONS) return;
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `scanned=${result.scanned}`,
      `recredited=${result.recredited}`,
      `still_failing=${result.stillFailing}`,
      `success=${result.success}`,
    ].join("\n");
    fs.appendFileSync(outputFile, outputs + "\n");
  }
  if (result.recredited > 0) {
    console.log(`::notice::Re-credited ${result.recredited} captured top-up(s)`);
  }
  if (result.stillFailing > 0) {
    console.log(
      `::warning::${result.stillFailing} captured top-up(s) still failing: ${result.errors.join("; ")}`,
    );
  }
}

async function main(): Promise<void> {
  await abortIfMaintenance("sweep-orphaned-topup-captures");
  Sentry.logger.info("job:sweep-orphaned-topup-captures started");
  console.log("🧹 Starting captured-but-uncredited top-up sweep...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await sweepOrphanedTopupCaptures();
    console.log("\n📊 Job Results:");
    console.log(`   Scanned: ${result.scanned}`);
    console.log(`   Re-credited: ${result.recredited}`);
    console.log(`   Still failing: ${result.stillFailing}`);
    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }
    outputToGitHubActions(result);
    Sentry.logger.info("job:sweep-orphaned-topup-captures finished", {
      scanned: result.scanned,
      recredited: result.recredited,
      stillFailing: result.stillFailing,
    });
  } finally {
    await disconnectDatabase();
  }
}

runJob("sweep-orphaned-topup-captures", main);
