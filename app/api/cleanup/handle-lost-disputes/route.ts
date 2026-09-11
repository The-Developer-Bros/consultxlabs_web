/**
 * Lost Dispute Handler API Endpoint
 *
 * Thin wrapper around scripts/handle-lost-disputes.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * GitHub Issue: #304
 * Schedule: Every 6 hours (via GitHub Actions or external cron)
 */

import { cleanupRoute, statusFor } from "@/lib/cron/cleanup-route";
import { handleLostDisputes } from "@/scripts/disputes/handle-lost-disputes";

export const { GET, POST } = cleanupRoute({
  job: "handle-lost-disputes",
  run: () => handleLostDisputes(),
  summarize: (r) => ({
    totalProcessed: r.totalProcessed,
    updatedCount: r.updatedCount,
    skippedCount: r.skippedCount,
    alreadyPaidCount: r.alreadyPaidCount,
    errorCount: r.errorCount,
  }),
  // 207 when a dispute was already paid out and the run itself was clean; a
  // failed run must not hide behind the 2xx that flag used to win.
  status: (r) => statusFor(r, r.alreadyPaidCount > 0),
  failureMessage: "Failed to handle lost disputes",
});
