/**
 * B5 stuck-webhook sweeper API endpoint (#785, task #10).
 *
 * Thin wrapper around scripts/cleanup/sweep-stuck-webhook-events.ts. Re-drives
 * WebhookEvent rows left processed=false after an after()-callback crash.
 *
 * Schedule: every ~10 minutes (CRON_SECRET-gated, like the other cleanup jobs).
 */
import { cleanupRoute, parseLimitParam } from "@/lib/cron/cleanup-route";
import { sweepStuckWebhookEvents } from "@/scripts/cleanup/sweep-stuck-webhook-events";

export const { GET, POST } = cleanupRoute({
  job: "sweep-stuck-webhook-events",
  run: (req) => sweepStuckWebhookEvents({ limit: parseLimitParam(req) }),
  summarize: (r) => ({
    scanned: r.scanned,
    recovered: r.recovered,
    stillFailing: r.stillFailing,
  }),
  // 207 when some events are still failing after a re-drive (needs attention).
  status: (r) => (r.stillFailing > 0 ? 207 : 200),
  failureMessage: "Failed to sweep stuck webhook events",
});
