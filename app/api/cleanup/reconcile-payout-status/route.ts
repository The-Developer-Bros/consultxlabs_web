/**
 * Payout Status Reconciliation API Endpoint
 *
 * Thin wrapper around scripts/reconcile-payout-status.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 6 hours (via GitHub Actions or external cron)
 */

import { cleanupRoute, statusFor } from "@/lib/cron/cleanup-route";
import { reconcilePayoutStatus } from "@/scripts/payouts/reconcile-payout-status";

export const { GET, POST } = cleanupRoute({
  job: "reconcile-payout-status",
  run: () => reconcilePayoutStatus(),
  summarize: (r) => ({
    totalProcessed: r.totalProcessed,
    reconciledCount: r.reconciledCount,
    completedCount: r.completedCount,
    failedCount: r.failedCount,
    discrepanciesCount: r.discrepancies.length,
  }),
  // 207 when discrepancies were found and the run itself was clean.
  status: (r) => statusFor(r, r.discrepancies.length > 0),
  failureMessage: "Failed to reconcile payout status",
});
