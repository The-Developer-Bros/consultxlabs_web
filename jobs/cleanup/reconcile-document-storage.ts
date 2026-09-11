/**
 * Document Storage Reconciliation Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/reconcile-document-storage.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs daily via scheduled workflow.
 */

import {
  reconcileDocumentStorage,
  disconnectDatabase,
  type DocumentReconciliationResult,
} from "../../scripts/cleanup/reconcile-document-storage";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: DocumentReconciliationResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `orphaned_found=${result.orphanedFilesFound}`,
      `orphaned_deleted=${result.orphanedFilesDeleted}`,
      `missing_found=${result.missingFilesFound}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (result.orphanedFilesDeleted > 0) {
    console.log(
      `::notice::Deleted ${result.orphanedFilesDeleted} orphaned files from storage`,
    );
  }

  if (result.missingFilesFound > 0) {
    console.log(
      `::warning::${result.missingFilesFound} files missing from storage - manual review needed`,
    );
  }

  if (!result.success) {
    console.log(
      `::error::Document storage reconciliation failed: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("reconcile-document-storage");
  Sentry.logger.info("job:reconcile-document-storage started");
  console.log("📂 Starting document storage reconciliation job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await reconcileDocumentStorage();

    console.log("\n📊 Job Results:");
    console.log(`   Orphaned Files Found: ${result.orphanedFilesFound}`);
    console.log(`   Orphaned Files Deleted: ${result.orphanedFilesDeleted}`);
    console.log(`   Missing Files Found: ${result.missingFilesFound}`);
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

    Sentry.logger.info("job:reconcile-document-storage finished", {
      orphanedFilesFound: result.orphanedFilesFound,
      orphanedFilesDeleted: result.orphanedFilesDeleted,
      missingFilesFound: result.missingFilesFound,
    });
  } finally {
    await disconnectDatabase();
  }
}

runJob("reconcile-document-storage", main);
