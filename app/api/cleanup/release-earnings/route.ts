/**
 * Release Earnings API Endpoint
 *
 * Thin wrapper around scripts/release-earnings.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Hourly (via GitHub Actions or external cron)
 */

import { cleanupRoute, parseLimitParam } from "@/lib/cron/cleanup-route";
import { releaseEarningsFromHold } from "@/scripts/earnings/release-earnings";

export const { GET, POST } = cleanupRoute({
  job: "release-earnings",
  run: (req) => releaseEarningsFromHold({ limit: parseLimitParam(req) }),
  summarize: (r) => ({
    releasedCount: r.releasedCount,
    // #1471 — the host-org arm is reported separately so the existing
    // `releasedCount` keeps meaning "consultant earnings released".
    organizationEarningsReleased: r.organizationEarningsReleased,
    errorCount: r.errorCount,
  }),
  // #1390 review — the constant 200 masked a caught job error (success:false)
  // as healthy; the default statusFor already reads result.success.
  failureMessage: "Failed to release earnings",
});
