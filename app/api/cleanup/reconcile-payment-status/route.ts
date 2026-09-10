/**
 * Payment Status Reconciliation API Endpoint
 *
 * Thin wrapper around scripts/reconcile-payment-status.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 30 minutes (via GitHub Actions or external cron)
 */

import {
  cleanupRoute,
  parseLimitParam,
  statusFor,
} from "@/lib/cron/cleanup-route";
import { reconcilePaymentStatus } from "@/scripts/payments/reconcile-payment-status";

export const { GET, POST } = cleanupRoute({
  job: "reconcile-payment-status",
  run: (req) => reconcilePaymentStatus({ limit: parseLimitParam(req) }),
  summarize: (r) => ({
    totalProcessed: r.totalProcessed,
    reconciledCount: r.reconciledCount,
    succeededCount: r.succeededCount,
    failedCount: r.failedCount,
  }),
  // 207 when succeeded payments were reconciled and the run itself was clean.
  status: (r) => statusFor(r, r.succeededCount > 0),
  failureMessage: "Failed to reconcile payment status",
});
