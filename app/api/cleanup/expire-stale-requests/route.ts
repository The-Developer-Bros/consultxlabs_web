/**
 * Stale Request Expiration API Endpoint
 *
 * Thin wrapper around scripts/expire-stale-requests.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Daily (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { expireStaleRequests } from "@/scripts/appointments/expire-stale-requests";

export const { GET, POST } = cleanupRoute({
  job: "expire-stale-requests",
  run: () => expireStaleRequests(),
  summarize: (r) => ({
    consultationsExpired: r.consultationsExpired,
    subscriptionsExpired: r.subscriptionsExpired,
    paymentPendingExpired: r.paymentPendingExpired,
  }),
  failureMessage: "Failed to expire stale requests",
});
