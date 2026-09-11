/**
 * Audit Log Retention Job (GitHub Actions Wrapper)
 *
 * Daily at 03:15 UTC via .github/workflows/prune-audit-logs.yml.
 * Deletes audit rows past retention (7y financial / 2y other).
 */

import "dotenv/config";

import {
  pruneAuditLogs,
  disconnectDatabase,
  type AuditPruneResult,
} from "../../scripts/cleanup/prune-audit-logs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

function outputToGitHubActions(result: AuditPruneResult): void {
  if (!process.env.GITHUB_ACTIONS) return;
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  const lines = [
    `scanned=${result.scanned}`,
    `deleted7y=${result.deleted7y}`,
    `deleted2y=${result.deleted2y}`,
    `per_org_summaries=${result.perOrgSummaries}`,
    `success=${result.success}`,
  ].join("\n");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("fs") as typeof import("fs");
  fs.appendFileSync(outputFile, lines + "\n");
}

if (require.main === module) {
  runJob("prune-audit-logs", async () => {
    await abortIfMaintenance("prune-audit-logs");
    Sentry.logger.info("job:prune-audit-logs started");
    console.log("🧹 Pruning audit logs past retention...");
    try {
      const result = await pruneAuditLogs();
      console.log(JSON.stringify(result, null, 2));
      outputToGitHubActions(result);
      if (!result.success) {
        process.exitCode = 1;
        return;
      }
      Sentry.logger.info("job:prune-audit-logs finished", { scanned: result.scanned, deleted7y: result.deleted7y, deleted2y: result.deleted2y });
    } finally {
      await disconnectDatabase();
    }
  });
}
