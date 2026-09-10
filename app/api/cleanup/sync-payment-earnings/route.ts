/**
 * Payment-Earning Sync API Endpoint
 *
 * Thin wrapper around scripts/sync-payment-earnings.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * GitHub Issue: #303
 * Schedule: Hourly (via GitHub Actions or external cron)
 */

import { cleanupRoute, parseLimitParam } from "@/lib/cron/cleanup-route";
import { syncPaymentEarnings } from "@/scripts/earnings/sync-payment-earnings";

export const { GET, POST } = cleanupRoute({
  job: "sync-payment-earnings",
  run: (req) => syncPaymentEarnings({ limit: parseLimitParam(req) }),
  summarize: (r) => ({
    totalProcessed: r.totalProcessed,
    createdCount: r.createdCount,
    skippedCount: r.skippedCount,
    errorCount: r.errorCount,
  }),
  // #1390 review — the constant 200 masked errorCount>0 runs as healthy; the
  // default statusFor already reads result.success.
  failureMessage: "Failed to sync payment earnings",
});
