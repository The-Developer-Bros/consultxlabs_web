/**
 * Stale Invitation Cleanup Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/cleanup/cleanup-stale-invitations.ts.
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs daily at 08:10 IST (02:40 UTC; #709 minute map) via
 * .github/workflows/cleanup-stale-invitations.yml — offset from
 * cleanup-abandoned-org-top-ups at 07:30 IST (02:00 UTC) to avoid
 * Prisma connection contention.
 */

import fs from "fs";
import {
  cleanupStaleInvitations,
  disconnectDatabase,
  type StaleInvitationsCleanupResult,
} from "../../scripts/cleanup/cleanup-stale-invitations";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

function outputToGitHubActions(result: StaleInvitationsCleanupResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `expired=${result.expired}`,
      `success=${result.success}`,
    ].join("\n");
    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (!result.success) {
    console.log(
      `::error::Stale invitation cleanup completed with errors: ${result.errors.join("; ")}`,
    );
  }
}

async function main(): Promise<void> {
  await abortIfMaintenance("cleanup-stale-invitations");
  Sentry.logger.info("job:cleanup-stale-invitations started");
  console.log("🧹 Starting stale invitation cleanup job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await cleanupStaleInvitations();

    console.log("\n📊 Cleanup Results:");
    console.log(`   Expired: ${result.expired}`);
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

    Sentry.logger.info("job:cleanup-stale-invitations finished", { expired: result.expired });
  } finally {
    await disconnectDatabase();
  }
}

runJob("cleanup-stale-invitations", main);
