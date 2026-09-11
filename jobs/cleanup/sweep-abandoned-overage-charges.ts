/**
 * Abandoned CHARGE_MEMBER overage-charge sweeper (GitHub Actions wrapper) —
 * #785, task #25. FAILs never-paid PENDING side-charges so they stop counting
 * toward the per-cycle circuit-breaker ceiling. Runs daily.
 */
import {
  sweepAbandonedOverageCharges,
  disconnectDatabase,
  type OverageSweepResult,
} from "../../scripts/cleanup/sweep-abandoned-overage-charges";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

function outputToGitHubActions(result: OverageSweepResult): void {
  if (!process.env.GITHUB_ACTIONS) return;
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(
      outputFile,
      [`scanned=${result.scanned}`, `failed=${result.failed}`, `success=${result.success}`].join("\n") + "\n",
    );
  }
  if (result.failed > 0) {
    console.log(`::notice::Failed ${result.failed} abandoned overage charge(s)`);
  }
}

async function main(): Promise<void> {
  await abortIfMaintenance("sweep-abandoned-overage-charges");
  Sentry.logger.info("job:sweep-abandoned-overage-charges started");
  console.log("🧹 Starting abandoned overage-charge sweep...");
  console.log(`Timestamp: ${new Date().toISOString()}`);
  try {
    const result = await sweepAbandonedOverageCharges();
    console.log("\n📊 Job Results:");
    console.log(`   Scanned: ${result.scanned}`);
    console.log(`   Failed (ceiling freed): ${result.failed}`);
    outputToGitHubActions(result);
    Sentry.logger.info("job:sweep-abandoned-overage-charges finished", { scanned: result.scanned, failed: result.failed });
  } finally {
    await disconnectDatabase();
  }
}

runJob("sweep-abandoned-overage-charges", main);
