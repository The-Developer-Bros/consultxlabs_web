/**
 * Refund-Earning Cascade API Endpoint
 *
 * Thin wrapper around scripts/cascade-refund-earnings.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * GitHub Issue: #305
 * Schedule: Every 15 minutes (via GitHub Actions or external cron)
 */

import { cleanupRoute, parseLimitParam } from "@/lib/cron/cleanup-route";
import { cascadeRefundToEarnings } from "@/scripts/refunds/cascade-refund-earnings";
import { cascadeRunFailed } from "@/scripts/refunds/cascade-run-outcome";

export const { GET, POST } = cleanupRoute({
  job: "cascade-refund-earnings",
  run: (req) => cascadeRefundToEarnings({ limit: parseLimitParam(req) }),
  summarize: (r) => ({
    totalProcessed: r.totalProcessed,
    updatedCount: r.updatedCount,
    skippedCount: r.skippedCount,
    errorCount: r.errorCount,
  }),
  // PM-34 — result.success === false means some SUCCEEDED refunds failed
  // their cascade; an unconditional 200 told the cron's health check
  // everything was fine and it never paged. Mirror the other money crons
  // (e.g. appointment-reminders) with a 500 on a failed run.
  status: (result) => (cascadeRunFailed(result) ? 500 : 200),
  failureMessage: "Failed to cascade refund to earnings",
});
