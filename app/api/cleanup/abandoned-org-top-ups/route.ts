/**
 * POST /api/cleanup/abandoned-org-top-ups
 *
 * Enterprise sibling of `/api/cleanup/abandoned-payments`. Reaps pending
 * `WalletEntry` placeholder rows that never received a webhook confirmation
 * within the grace window. See scripts/cleanup/cleanup-abandoned-org-top-ups.ts
 * for the full invariant + rationale.
 *
 * This route is a thin wrapper around the shared script so the same code
 * runs in both the GitHub Actions job (jobs/cleanup/cleanup-abandoned-org-top-ups.ts)
 * and the on-demand HTTP endpoint, matching the rest of /api/cleanup/*.
 *
 * Gated by CRON_SECRET (or VERCEL_CRON_SECRET) just like every other
 * cleanup route — the Authorization header must carry the bearer token.
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { cleanupAbandonedOrgTopUps } from "@/scripts/cleanup/cleanup-abandoned-org-top-ups";

export const { GET, POST } = cleanupRoute({
  job: "cleanup-abandoned-org-top-ups",
  run: () => cleanupAbandonedOrgTopUps(),
  summarize: (r) => ({
    reaped: r.reaped,
    graceHours: r.graceHours,
    success: r.success,
  }),
  unauthorizedMessage:
    "Please provide a valid authorization header with the CRON_SECRET",
  failureMessage: "Cleanup failed",
});
