/**
 * POST /api/cleanup/sso-cert-expiry-alert
 *
 * HTTP companion to `jobs/cleanup/sso-cert-expiry-alert.ts`. Lets an
 * operator run the scan on-demand after rotating a cert or onboarding
 * a new SAML provider — useful for confirming the alert path without
 * waiting for the 03:00 UTC slot.
 *
 * Auth: `CRON_SECRET` bearer.
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { runSsoCertExpiryAlert } from "@/scripts/cleanup/sso-cert-expiry-alert";

export const { GET, POST } = cleanupRoute({
  job: "sso-cert-expiry-alert",
  run: () => runSsoCertExpiryAlert(),
  summarize: (r) => ({
    scanned: r.scanned,
    alerted: r.alerted,
    success: r.success,
  }),
  unauthorizedMessage:
    "Please provide a valid authorization header with the CRON_SECRET",
  failureMessage: "Alert scan failed",
});
