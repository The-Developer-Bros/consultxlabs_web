/**
 * Document Storage Reconciliation API Endpoint
 *
 * Thin wrapper around scripts/reconcile-document-storage.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Daily (via GitHub Actions or external cron)
 */

import { cleanupRoute, statusFor } from "@/lib/cron/cleanup-route";
import { reconcileDocumentStorage } from "@/scripts/cleanup/reconcile-document-storage";

export const { GET, POST } = cleanupRoute({
  job: "reconcile-document-storage",
  run: () => reconcileDocumentStorage(),
  summarize: (r) => ({
    orphanedFilesFound: r.orphanedFilesFound,
    orphanedFilesDeleted: r.orphanedFilesDeleted,
    missingFilesFound: r.missingFilesFound,
  }),
  // 207 when missing files were found and the run itself was clean.
  status: (r) => statusFor(r, r.missingFilesFound > 0),
  failureMessage: "Failed to reconcile document storage",
});
