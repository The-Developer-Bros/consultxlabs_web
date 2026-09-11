import * as Sentry from "@sentry/nextjs";
import type { PrismaLike } from "@/lib/prisma";
/**
 * Outbound webhook delivery worker.
 *
 * Drains `OutboundWebhookDelivery` rows whose status is PENDING (first
 * attempt) or RETRY (any subsequent attempt whose `nextRetryAt` is now
 * or earlier). One worker tick:
 *
 *   1. Picks up to `MAX_BATCH` rows ordered by `nextRetryAt ASC NULLS FIRST`.
 *   2. For each row, signs the body and POSTs to the endpoint URL with
 *      a 10-second timeout.
 *   3. Records the outcome:
 *        - 2xx → status=SUCCESS, deliveredAt=now, endpoint.lastSuccessAt
 *        - 4xx (except 408 / 429) → status=FAILED, no retry — receiver
 *          told us the request is malformed; retrying won't help.
 *        - 5xx / 408 / 429 / network error → status=RETRY with the next
 *          backoff slot, OR status=FAILED if we just used the last
 *          attempt (5).
 *
 * Backoff schedule
 * ----------------
 *   attempt 1 → 1 minute
 *   attempt 2 → 5 minutes
 *   attempt 3 → 30 minutes
 *   attempt 4 → 2 hours
 *   attempt 5 → 8 hours (last)
 *   attempt 6 → FAILED
 *
 * Total wall-clock window from first attempt to FAILED: ~10h 36m.
 * Pairs with the 9h replay window in `signing.ts` so a receiver can
 * still verify the last attempt's signature even when the worker has
 * been catching up.
 *
 * Why fire-and-forget instead of a proper queue (SQS / RabbitMQ)
 * --------------------------------------------------------------
 * The project runs on Netlify primary / Vercel fallback — neither
 * vendor offers a first-class queue without an extra paid tier. The
 * delivery table IS the queue: an indexed (status, nextRetryAt) walk
 * is plenty for the volume (<10k orgs × low single-digit webhook RPS).
 * When the volume justifies SQS, the swap-in is a single function:
 * everything else stays.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  generateEndpointSecret as _unused_re_export,
  SIGNATURE_HEADER,
  signPayload,
  WEBHOOK_ROTATION_GRACE_MS,
} from "./signing";
import { assertPublicUrl } from "./ssrf-guard";
import { recordSystemEvent } from "@/lib/enterprise/system-events";

// Re-export silenced — the worker doesn't generate secrets; this keeps
// the module's surface area clean while preventing an unused-import lint.
void _unused_re_export;

const MAX_BATCH = 50;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 5;

/**
 * Wave-3 (#1230) — consecutive-failure threshold at which an ACTIVE endpoint
 * is auto-disabled. Previously failureCount grew unread and a dead receiver
 * kept costing a full delivery attempt + backoff slot every tick forever.
 * Re-enable is the existing endpoint PATCH route (operator action after
 * fixing the receiver).
 */
export const ENDPOINT_AUTO_DISABLE_FAILURES = 25;

async function maybeAutoDisableEndpoint(
  prisma: PrismaLike,
  endpoint: { id: string; organizationId: string; url: string },
): Promise<void> {
  const flipped = await prisma.webhookEndpoint.updateMany({
    where: {
      id: endpoint.id,
      status: "ACTIVE",
      failureCount: { gte: ENDPOINT_AUTO_DISABLE_FAILURES },
    },
    data: { status: "DISABLED" },
  });
  if (flipped.count > 0) {
    void recordSystemEvent({
      organizationId: endpoint.organizationId,
      category: "WEBHOOK",
      severity: "WARN",
      message: `Webhook endpoint auto-disabled after ${ENDPOINT_AUTO_DISABLE_FAILURES} consecutive failures: ${endpoint.url}`,
      context: { endpointId: endpoint.id, url: endpoint.url },
    });
  }
}

// #812: A row flipped to IN_FLIGHT (the soft lock below) but never resolved is a
// worker that crashed mid-delivery. Nothing re-selects IN_FLIGHT, so without a
// reaper window the row is orphaned forever. Anything older than this (> the
// 10s request timeout by a wide margin) is treated as crashed and re-queued.
const IN_FLIGHT_STALE_MS = 10 * 60 * 1000; // 10 min

/**
 * Backoff lookup keyed by the attempt number AFTER incrementing. So if
 * a row currently has `attempts = 0` and we just tried once, we look up
 * `BACKOFF_MS[1]` to compute when to try next.
 */
const BACKOFF_MS: Record<number, number> = {
  1: 60_000, // 1 min
  2: 5 * 60_000, // 5 min
  3: 30 * 60_000, // 30 min
  4: 2 * 60 * 60_000, // 2 h
  5: 8 * 60 * 60_000, // 8 h
};

export interface WorkerRunResult {
  scanned: number;
  succeeded: number;
  retried: number;
  failed: number;
  errors: string[];
}

/**
 * Single-tick worker. Idempotent — safe to call repeatedly (the
 * `status` flip from PENDING → IN_FLIGHT marks rows in-progress so a
 * second tick doesn't grab them).
 */
export async function runDispatchTick(params: {
  prisma: PrismaLike;
  /// Inject for testing — production uses globalThis.fetch.
  fetchFn?: typeof fetch;
  /// Override the clock for deterministic tests.
  now?: () => number;
  /// Batch ceiling override; defaults to MAX_BATCH.
  maxBatch?: number;
  /// Inject for testing — production uses the real SSRF guard. Fixture
  /// endpoints use reserved non-resolving hosts (`*.example`), which the guard
  /// correctly refuses, so tests exercising delivery pass a no-op here. Never
  /// override this in production code.
  assertUrlFn?: (url: string) => Promise<void>;
}): Promise<WorkerRunResult> {
  const { prisma } = params;
  const fetchImpl = params.fetchFn ?? globalThis.fetch;
  const assertUrl = params.assertUrlFn ?? assertPublicUrl;
  const now = params.now ?? (() => Date.now());
  const batchLimit = params.maxBatch ?? MAX_BATCH;

  Sentry.logger.info("webhook-worker: tick started");

  const result: WorkerRunResult = {
    scanned: 0,
    succeeded: 0,
    retried: 0,
    failed: 0,
    errors: [],
  };

  // Why we don't SELECT FOR UPDATE: Prisma's high-level client doesn't
  // expose row locks, and the worker is single-tenant per cron tick.
  // The status flip to IN_FLIGHT below is the soft lock — a second
  // worker grabbing the same row would observe IN_FLIGHT and skip.
  const nowDate = new Date(now());
  const inFlightStaleBefore = new Date(now() - IN_FLIGHT_STALE_MS);
  const dueRows = await prisma.outboundWebhookDelivery.findMany({
    where: {
      OR: [
        { status: "PENDING" },
        { status: "RETRY", nextRetryAt: { lte: nowDate } },
        // #812: A stale IN_FLIGHT row is a crashed-mid-delivery orphan — the
        // worker died after the soft-lock flip but before recording the
        // outcome. Keyed on updatedAt (@updatedAt) so the staleness window
        // tracks the last soft-lock touch, not enqueue. Re-queue it; the
        // receiver-side idempotency keys make a re-POST safe even if the
        // original request did land.
        { status: "IN_FLIGHT", updatedAt: { lt: inFlightStaleBefore } },
      ],
    },
    orderBy: [{ nextRetryAt: { sort: "asc", nulls: "first" } }],
    take: batchLimit,
    include: {
      endpoint: {
        select: {
          id: true,
          url: true,
          secret: true,
          status: true,
          organizationId: true,
          secretRotatedAt: true,
          previousSecretHash: true,
        },
      },
    },
  });

  for (const row of dueRows) {
    result.scanned += 1;
    // Skip rows whose endpoint was paused / disabled after the delivery
    // was queued — the operator's explicit pause should win over our
    // retry schedule. We mark as FAILED with a descriptive error.
    if (row.endpoint.status !== "ACTIVE") {
      await prisma.outboundWebhookDelivery.update({
        where: { id: row.id },
        data: {
          status: "FAILED",
          lastError: `Endpoint is ${row.endpoint.status}; aborted delivery.`,
        },
      });
      result.failed += 1;
      continue;
    }

    // #812 — guarded atomic claim: only flip to IN_FLIGHT if the row is STILL
    // in the status we selected it under. An unguarded update-by-id let the
    // stale-IN_FLIGHT reaper defeat the soft lock (two ticks re-claiming the
    // same orphan). count===0 means another tick won the race — skip it.
    const claim = await prisma.outboundWebhookDelivery.updateMany({
      where: { id: row.id, status: row.status },
      data: { status: "IN_FLIGHT" },
    });
    if (claim.count === 0) continue;

    const body = JSON.stringify({
      id: row.id,
      type: row.eventType,
      createdAt: row.createdAt.toISOString(),
      data: row.payload,
    });
    // Dual-sign during the 24h rotation grace window: if the operator
    // rotated recently AND we still hold the prior secret value, emit a
    // second `v1=` so receivers verifying with EITHER secret stay green
    // across the cutover. `previousSecretHash` holds the prior secret
    // VALUE during the window (see schema note #768). After the window
    // we sign with the current secret only.
    const inRotationGrace =
      row.endpoint.secretRotatedAt != null &&
      row.endpoint.previousSecretHash != null &&
      now() - row.endpoint.secretRotatedAt.getTime() <=
        WEBHOOK_ROTATION_GRACE_MS;
    const signature = signPayload(
      row.endpoint.secret,
      body,
      Math.floor(now() / 1000),
      inRotationGrace ? row.endpoint.previousSecretHash : null,
    );
    const attemptNumber = row.attempts + 1;

    let httpStatusCode: number | undefined;
    let networkError: string | undefined;

    try {
      // #1132 — re-verify immediately before dialling. Registration-time
      // validation alone is defeated by DNS rebinding: a host that answered
      // with a public address at create time can answer with 169.254.169.254
      // now. Treated as a delivery failure, so it retries and eventually
      // disables the endpoint rather than 500-ing the tick.
      await assertUrl(row.endpoint.url);

      // AbortController + timer: fetch's default has no per-request
      // timeout in the Node runtime. A receiver hanging at the TCP
      // layer would stall the whole tick.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetchImpl(row.endpoint.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [SIGNATURE_HEADER]: signature,
            "User-Agent": "Familiarise-Webhooks/1.0",
          },
          body,
          signal: ac.signal,
          // Do not follow redirects: a public host must not be able to bounce
          // us to a private one after assertPublicUrl has passed. A 3xx is
          // surfaced as its own status and counts as a delivery failure.
          redirect: "manual",
        });
        httpStatusCode = res.status;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      networkError = err instanceof Error ? err.message : String(err);
    }

    const isSuccess =
      httpStatusCode !== undefined &&
      httpStatusCode >= 200 &&
      httpStatusCode < 300;
    // 4xx that are NOT 408 / 429 are permanent: the receiver told us
    // the request is malformed. Retrying same body + same signature
    // won't change the outcome.
    const isPermanentClientError =
      httpStatusCode !== undefined &&
      httpStatusCode >= 400 &&
      httpStatusCode < 500 &&
      httpStatusCode !== 408 &&
      httpStatusCode !== 429;

    if (isSuccess) {
      await prisma.outboundWebhookDelivery.update({
        where: { id: row.id },
        data: {
          status: "SUCCESS",
          httpStatusCode,
          signature,
          attempts: attemptNumber,
          deliveredAt: nowDate,
          lastError: null,
        },
      });
      await prisma.webhookEndpoint.update({
        where: { id: row.endpoint.id },
        data: { lastSuccessAt: nowDate, failureCount: 0 },
      });
      result.succeeded += 1;
      continue;
    }

    if (isPermanentClientError) {
      await prisma.outboundWebhookDelivery.update({
        where: { id: row.id },
        data: {
          status: "FAILED",
          httpStatusCode,
          signature,
          attempts: attemptNumber,
          lastError: `Permanent client error: ${httpStatusCode}`,
        },
      });
      await prisma.webhookEndpoint.update({
        where: { id: row.endpoint.id },
        data: {
          lastFailureAt: nowDate,
          failureCount: { increment: 1 },
        },
      });
      await maybeAutoDisableEndpoint(prisma, row.endpoint);
      result.failed += 1;
      continue;
    }

    // Retry path — 5xx / 408 / 429 / network error.
    const nextAttemptNumber = attemptNumber + 1;
    if (attemptNumber >= MAX_ATTEMPTS) {
      // DEAD_LETTER, not FAILED: delivery-starved (receiver may be fine
      // tomorrow), operator-replayable via /redeliver. FAILED stays the
      // receiver-rejected terminal (permanent 4xx / endpoint paused).
      const deadLetterError =
        networkError ??
        `Exhausted retries; last status ${httpStatusCode ?? "n/a"}`;
      await prisma.outboundWebhookDelivery.update({
        where: { id: row.id },
        data: {
          status: "DEAD_LETTER",
          httpStatusCode: httpStatusCode ?? null,
          signature,
          attempts: attemptNumber,
          lastError: deadLetterError,
        },
      });
      await prisma.webhookEndpoint.update({
        where: { id: row.endpoint.id },
        data: {
          lastFailureAt: nowDate,
          failureCount: { increment: 1 },
        },
      });
      await maybeAutoDisableEndpoint(prisma, row.endpoint);
      Sentry.captureException(
        new Error(`Webhook delivery dead-lettered: ${deadLetterError}`),
        {
          tags: { subsystem: "enterprise", component: "outbound-webhooks" },
          level: "warning",
          contexts: {
            delivery: {
              deliveryId: row.id,
              endpointId: row.endpoint.id,
              eventType: row.eventType,
              attempts: attemptNumber,
              httpStatusCode: httpStatusCode ?? null,
            },
          },
        },
      );
      result.failed += 1;
    } else {
      const backoff = BACKOFF_MS[nextAttemptNumber] ?? BACKOFF_MS[MAX_ATTEMPTS];
      await prisma.outboundWebhookDelivery.update({
        where: { id: row.id },
        data: {
          status: "RETRY",
          httpStatusCode: httpStatusCode ?? null,
          signature,
          attempts: attemptNumber,
          nextRetryAt: new Date(now() + backoff),
          lastError: networkError ?? `Transient ${httpStatusCode ?? "network"}`,
        },
      });
      result.retried += 1;
    }
  }

  Sentry.logger.info("webhook-worker: tick finished", {
    scanned: result.scanned,
    succeeded: result.succeeded,
    retried: result.retried,
    failed: result.failed,
  });

  return result;
}
