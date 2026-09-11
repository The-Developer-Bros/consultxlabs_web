/**
 * POST /api/cleanup/dispatch-outbound-webhooks
 *
 * Cron tick for the outbound webhook delivery worker. Gated by
 * `CRON_SECRET` like every other route under /api/cleanup — the worker
 * itself is idempotent so a casual extra invocation is harmless, but
 * the bearer gate keeps random callers from running it.
 */

import { cleanupRoute, parseLimitParam } from "@/lib/cron/cleanup-route";
import { dispatchOutboundWebhooks } from "@/scripts/cleanup/dispatch-outbound-webhooks";

export const { GET, POST } = cleanupRoute({
  job: "dispatch-outbound-webhooks",
  // The HTTP route does NOT disconnect — `prisma` is the global singleton
  // shared with the rest of the Next runtime. We only disconnect in the
  // standalone job wrapper (jobs/cleanup/*).
  run: (req) => dispatchOutboundWebhooks({ limit: parseLimitParam(req) }),
  summarize: (r) => ({
    scanned: r.scanned,
    succeeded: r.succeeded,
    retried: r.retried,
    failed: r.failed,
  }),
  unauthorizedMessage: "Provide a valid Bearer CRON_SECRET",
  failureMessage: "Dispatch tick failed",
});
