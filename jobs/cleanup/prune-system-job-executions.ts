/**
 * SystemJobExecution Retention Job (GitHub Actions Wrapper)
 *
 * Daily at 03:26 UTC via .github/workflows/prune-system-job-executions.yml.
 * Deletes cron-trail rows past 90 days and closes runs that have been RUNNING
 * for more than six hours, which no live job can be.
 */

import "dotenv/config";

import fs from "node:fs";

import {
  pruneSystemJobExecutions,
  disconnectDatabase,
  type SystemJobExecutionPruneResult,
} from "../../scripts/cleanup/prune-system-job-executions";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

function outputToGitHubActions(result: SystemJobExecutionPruneResult): void {
  if (!process.env.GITHUB_ACTIONS) return;
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  const lines = [`pruned=${result.pruned}`, `stranded=${result.stranded}`].join(
    "\n",
  );
  fs.appendFileSync(outputFile, lines + "\n");
}

if (require.main === module) {
  runJob("prune-system-job-executions", async () => {
    await abortIfMaintenance("prune-system-job-executions");
    Sentry.logger.info("job:prune-system-job-executions started");
    console.log("🧹 Pruning the cron trail and closing stranded runs...");
    try {
      const result = await pruneSystemJobExecutions();
      console.log(JSON.stringify(result, null, 2));
      outputToGitHubActions(result);
      if (result.stranded > 0) {
        // A stranded run means a job process died without reporting; that is
        // worth a look even though the sweep itself succeeded.
        console.log(
          `::warning::Closed ${result.stranded} stranded job execution(s)`,
        );
      }
      Sentry.logger.info("job:prune-system-job-executions finished", {
        pruned: result.pruned,
        stranded: result.stranded,
      });
    } finally {
      await disconnectDatabase();
    }
  });
}
