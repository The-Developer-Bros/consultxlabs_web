/**
 * Reschedule Proposal Expiry API Endpoint
 *
 * Thin wrapper around scripts/appointments/expire-reschedule-proposals.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Hourly (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { expireRescheduleProposals } from "@/scripts/appointments/expire-reschedule-proposals";

export const { GET, POST } = cleanupRoute({
  job: "expire-reschedule-proposals",
  run: () => expireRescheduleProposals(),
  summarize: (r) => ({ proposalsExpired: r.proposalsExpired }),
  failureMessage: "Failed to expire reschedule proposals",
});
