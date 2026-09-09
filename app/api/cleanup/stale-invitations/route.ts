/**
 * POST /api/cleanup/stale-invitations
 *
 * HTTP companion to `jobs/cleanup/cleanup-stale-invitations.ts`. Lets
 * an operator run the cleanup on-demand (e.g. after bulk-inviting a
 * stale email list) without waiting for the scheduled 02:30 UTC slot.
 *
 * Gated by CRON_SECRET (or VERCEL_CRON_SECRET) — identical pattern to
 * every other `/api/cleanup/*` route.
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { cleanupStaleInvitations } from "@/scripts/cleanup/cleanup-stale-invitations";

export const { GET, POST } = cleanupRoute({
  job: "cleanup-stale-invitations",
  run: () => cleanupStaleInvitations(),
  summarize: (r) => ({ expired: r.expired, success: r.success }),
  unauthorizedMessage:
    "Please provide a valid authorization header with the CRON_SECRET",
  failureMessage: "Cleanup failed",
});
