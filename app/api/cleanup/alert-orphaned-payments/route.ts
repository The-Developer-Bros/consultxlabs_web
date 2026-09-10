/**
 * Orphaned Payments Alert API Endpoint
 *
 * Thin wrapper around scripts/alert-orphaned-payments.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 6 hours (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { alertOrphanedPayments } from "@/scripts/alerts/alert-orphaned-payments";

export const { GET, POST } = cleanupRoute({
  job: "alert-orphaned-payments",
  run: () => alertOrphanedPayments(),
  summarize: (r) => ({
    totalOrphaned: r.totalOrphaned,
    criticalCount: r.criticalCount,
    totalAmount: r.totalAmount,
  }),
  // Return 500 if orphaned payments found (to trigger alerts)
  status: (r) => (r.totalOrphaned > 0 ? 500 : 200),
  failureMessage: "Failed to check for orphaned payments",
});
