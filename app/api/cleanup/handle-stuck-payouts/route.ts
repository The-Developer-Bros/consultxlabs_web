/**
 * Stuck Payouts Handler API Endpoint
 *
 * Thin wrapper around scripts/handle-stuck-payouts.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 4 hours (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { handleStuckPayouts } from "@/scripts/payouts/handle-stuck-payouts";

export const { GET, POST } = cleanupRoute({
  job: "handle-stuck-payouts",
  run: () => handleStuckPayouts(),
  summarize: (r) => ({
    totalProcessed: r.totalProcessed,
    reconciledCount: r.reconciledCount,
    retriedCount: r.retriedCount,
    failedCount: r.failedCount,
  }),
  failureMessage: "Failed to handle stuck payouts",
});
