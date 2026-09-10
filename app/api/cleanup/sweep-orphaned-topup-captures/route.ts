/**
 * Captured-but-uncredited wallet top-up reconciler API endpoint (#785, task #23).
 * Thin CRON_SECRET-gated wrapper around the reconciler. Runs every ~30 minutes.
 */
import { cleanupRoute, parseLimitParam } from "@/lib/cron/cleanup-route";
import { sweepOrphanedTopupCaptures } from "@/scripts/cleanup/sweep-orphaned-topup-captures";

export const { GET, POST } = cleanupRoute({
  job: "sweep-orphaned-topup-captures",
  run: (req) => sweepOrphanedTopupCaptures({ limit: parseLimitParam(req) }),
  summarize: (r) => ({
    scanned: r.scanned,
    recredited: r.recredited,
    stillFailing: r.stillFailing,
  }),
  status: (r) => (r.stillFailing > 0 ? 207 : 200),
  failureMessage: "Failed to sweep captured top-ups",
});
