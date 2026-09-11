/**
 * Create Payout Batch API Endpoint
 *
 * FIX #620: Uses canonical lib/payments/payouts service (with distributed locking
 * and atomic transactions) instead of scripts/payouts which lacks those safety features.
 *
 * Schedule: Weekly on Mondays at 8:00 PM UTC (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { createPayoutBatch } from "@/lib/payments/payouts";

export const { GET, POST } = cleanupRoute({
  job: "create-payout-batch",
  run: async () => ({ success: true, batchId: await createPayoutBatch() }),
  summarize: (r) => ({ batchId: r.batchId }),
  failureMessage: "Failed to create payout batch",
});
