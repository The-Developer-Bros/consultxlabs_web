/**
 * Dispute Deadline Alerts API Endpoint
 *
 * Thin wrapper around scripts/alert-dispute-deadlines.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Hourly (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { alertDisputeDeadlines } from "@/scripts/disputes/alert-dispute-deadlines";

export const { GET, POST } = cleanupRoute({
  job: "alert-dispute-deadlines",
  run: () => alertDisputeDeadlines(),
  summarize: (r) => ({
    urgentCount: r.urgentCount,
    criticalCount: r.criticalCount,
  }),
  // Return 207 if critical disputes found (needs immediate attention)
  status: (r) => (r.criticalCount > 0 ? 207 : 200),
  failureMessage: "Failed to check dispute deadlines",
});
