/**
 * Dispute Reconciliation API Endpoint
 *
 * Thin wrapper around scripts/reconcile-disputes.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 6 hours (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { reconcileDisputes } from "@/scripts/disputes/reconcile-disputes";

export const { GET, POST } = cleanupRoute({
  job: "reconcile-disputes",
  run: async () => {
    const result = await reconcileDisputes();
    // Alert on urgent disputes
    if (result.urgentCount > 0) {
      console.warn(
        `ALERT: ${result.urgentCount} disputes require immediate attention!`,
      );
    }
    return result;
  },
  summarize: (r) => ({
    totalProcessed: r.totalProcessed,
    reconciledCount: r.reconciledCount,
    urgentCount: r.urgentCount,
    razorpayManualReviewCount: r.razorpayManualReviewCount,
    skippedFenced: r.skippedFenced,
  }),
  // #1459 — no `status` override: a hardcoded 200 reported every failed run as
  // healthy, the same masking #1390 removed from the other sweeps. The default
  // mapping answers 500 when `success` is false.
  failureMessage: "Failed to reconcile disputes",
});
