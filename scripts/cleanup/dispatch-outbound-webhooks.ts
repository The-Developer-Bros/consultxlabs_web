/**
 * Outbound Webhook Dispatch Cron — Core Logic
 *
 * Drains the `OutboundWebhookDelivery` queue by invoking `runDispatchTick`
 * on a one-minute cadence. The worker handles signing, retries, and
 * status flips; this script is the thin "production" surface that
 * forwards to it and exposes the result.
 *
 * Imported by:
 *   - jobs/cleanup/dispatch-outbound-webhooks.ts (GitHub Actions wrapper)
 *   - app/api/cleanup/dispatch-outbound-webhooks/route.ts (HTTP endpoint)
 *
 * Schedule: every minute via .github/workflows/dispatch-outbound-webhooks.yml.
 * The worker is idempotent (rows transition PENDING → IN_FLIGHT → SUCCESS
 * or RETRY) so a concurrent invocation simply observes the in-flight row
 * and skips it on the next tick.
 */

import prisma from "../../lib/prisma";
import { runDispatchTick } from "../../lib/enterprise/outbound-webhooks/worker";
import { withCronLock } from "@/lib/cron/with-cron-lock";

export interface DispatchOutboundWebhooksResult {
  scanned: number;
  succeeded: number;
  retried: number;
  failed: number;
  success: boolean;
  errors: string[];
}

export interface DispatchOutboundWebhooksOptions {
  /** #1356 — forwarded as `runDispatchTick`'s `maxBatch`; undefined keeps its
   * own MAX_BATCH default (the unbounded-per-tick GitHub Actions behaviour). */
  limit?: number;
}

// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
export async function dispatchOutboundWebhooks(
  opts: DispatchOutboundWebhooksOptions = {},
): Promise<DispatchOutboundWebhooksResult> {
  return withCronLock("dispatch-outbound-webhooks", { failMode: "open" }, () =>
    dispatchOutboundWebhooksUnlocked(opts),
  );
}

async function dispatchOutboundWebhooksUnlocked(
  opts: DispatchOutboundWebhooksOptions = {},
): Promise<DispatchOutboundWebhooksResult> {
  const tick = await runDispatchTick({ prisma, maxBatch: opts.limit });
  return {
    scanned: tick.scanned,
    succeeded: tick.succeeded,
    retried: tick.retried,
    failed: tick.failed,
    success: tick.errors.length === 0,
    errors: tick.errors,
  };
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
