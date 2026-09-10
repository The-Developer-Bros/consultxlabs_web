/**
 * Deactivate Expired Discounts API Endpoint
 *
 * Thin wrapper around scripts/deactivate-expired-discounts.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Daily at midnight (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { deactivateExpiredDiscounts } from "@/scripts/cleanup/deactivate-expired-discounts";

export const { GET, POST } = cleanupRoute({
  job: "deactivate-expired-discounts",
  run: () => deactivateExpiredDiscounts(),
  summarize: (r) => ({
    expiredByDateCount: r.expiredByDateCount,
    maxUsesReachedCount: r.maxUsesReachedCount,
    totalDeactivated: r.totalDeactivated,
  }),
  failureMessage: "Failed to deactivate expired discounts",
});
