/**
 * Moderation enforcement retry (GitHub Actions wrapper) — #1270.
 *
 * Thin wrapper around scripts/cleanup/retry-moderation-enforcement.ts. When a
 * ban's Stream revocation fails, the database says banned and the moderator has
 * been told it worked, while the target's existing chat token keeps working.
 * This re-drives exactly that Stream step so the enforcement actually lands.
 *
 * Scheduled rather than on-demand for the same reason the webhook sweeper is:
 * the failure it repairs is invisible from the product, so nobody would think
 * to press a button.
 */
import fs from "node:fs";
import * as Sentry from "@sentry/nextjs";

import {
  retryModerationEnforcement,
  disconnectDatabase,
  type ModerationRetryResult,
} from "../../scripts/cleanup/retry-moderation-enforcement";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { runJob } from "../../lib/observability/job-sentry";

function outputToGitHubActions(result: ModerationRetryResult): void {
  if (!process.env.GITHUB_ACTIONS) return;
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(
      outputFile,
      [
        `scanned=${result.scanned}`,
        `recovered=${result.recovered}`,
        `gave_up=${result.gaveUp}`,
        `success=${result.success}`,
      ].join("\n") + "\n",
    );
  }
  if (result.recovered > 0) {
    console.log(
      `::notice::Re-drove ${result.recovered} failed moderation enforcement(s)`,
    );
  }
  if (result.gaveUp > 0) {
    // A ban that could not be enforced within its retry budget needs a human to
    // finish it by hand, so this is a warning rather than a note.
    console.log(
      `::warning::${result.gaveUp} moderation enforcement(s) gave up and need manual action`,
    );
  }
}

async function main(): Promise<void> {
  await abortIfMaintenance("retry-moderation-enforcement");
  Sentry.logger.info("job:retry-moderation-enforcement started");

  try {
    const result = await retryModerationEnforcement();

    console.log("\n📊 Job Results:");
    console.log(`   Scanned: ${result.scanned}`);
    console.log(`   Recovered: ${result.recovered}`);
    console.log(`   Still failing: ${result.stillFailing}`);
    console.log(`   Gave up: ${result.gaveUp}`);
    console.log(`   Skipped (ban lifted): ${result.skipped}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    Sentry.logger.info("job:retry-moderation-enforcement finished", {
      scanned: result.scanned,
      recovered: result.recovered,
      stillFailing: result.stillFailing,
      gaveUp: result.gaveUp,
    });
    outputToGitHubActions(result);
  } finally {
    await disconnectDatabase();
  }
}

runJob("retry-moderation-enforcement", main);
