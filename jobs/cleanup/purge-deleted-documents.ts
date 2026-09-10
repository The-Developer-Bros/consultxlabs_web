/**
 * Purge Deleted Documents Job (GitHub Actions Wrapper)
 *
 * Finishes soft deletes: removes storage objects past the grace window, then
 * hard-deletes the tombstoned AppointmentDocument rows.
 *
 * Runs daily via scheduled workflow (purge-deleted-documents.yml).
 */

import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";
import { purgeExpiredDeletedDocuments } from "../../lib/documents/document-purge";
import { DOCUMENT_DELETE_GRACE_DAYS } from "../../lib/documents/document-review";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { withCronLock } from "../../lib/cron/with-cron-lock";
import fs from "node:fs";

async function main(): Promise<void> {
  await abortIfMaintenance("purge-deleted-documents");
  Sentry.logger.info("job:purge-deleted-documents started");
  const startTime = Date.now();
  console.log("🚀 Starting purge-deleted-documents job...");
  console.log(`   Grace window: ${DOCUMENT_DELETE_GRACE_DAYS} days`);

  const result = await withCronLock(
    "purge-deleted-documents",
    { failMode: "open" },
    () => purgeExpiredDeletedDocuments(DOCUMENT_DELETE_GRACE_DAYS),
  );

  const duration = (Date.now() - startTime) / 1000;
  console.log(`\n⏱️ Job completed in ${duration.toFixed(2)} seconds`);
  console.log(`   Rows purged: ${result.purged}`);
  console.log(
    `   Storage deletions failed (retry tomorrow): ${result.failedStorage}`,
  );
  console.log(`   Unexpected row failures: ${result.failedRows}`);

  if (process.env.GITHUB_ACTIONS && process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `purged=${result.purged}\nfailed_storage=${result.failedStorage}\nfailed_rows=${result.failedRows}\nsuccess=true\n`,
    );
  }

  Sentry.logger.info("job:purge-deleted-documents finished", result);
  console.log("🎉 Job completed successfully");
}

runJob("purge-deleted-documents", main);
