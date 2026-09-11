/**
 * Shared webhook bookkeeping: the delivery log that gives every provider
 * idempotency, and the DB-health probe handlers gate on.
 *
 * #1134 P1-2 — moved out of `app/api/webhooks/utils.ts` because the Stream
 * dispatch now lives in `lib/` (so the stuck-event sweeper can re-drive it) and
 * `lib/` may not import from `app/`. `app/api/webhooks/utils.ts` re-exports
 * these, so every existing caller is unchanged.
 */
import { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import { reportSentryError } from "@/lib/observability/report";

/**
 * Lightweight DB health check for webhook handlers.
 *
 * Returns false when the DB is unreachable or mid-migration.
 * Webhook handlers should return 503 when this is false — payment gateways
 * (Stripe, Razorpay, etc.) will retry the webhook automatically after a
 * delay, so no events are lost.
 */
export async function isDbHealthy(): Promise<boolean> {
  try {
    // ORM connectivity probe (no raw SQL): a LIMIT 1 read proves the connection.
    await prisma.user.findFirst({ select: { id: true } });
    return true;
  } catch (error) {
    // Handlers 503 on false so gateways retry — correct for a transient
    // outage, but a persistent non-connectivity fault (e.g. schema drift)
    // would 503 every webhook forever with no signal. Report it (#1125).
    reportSentryError(error, {
      subsystem: "webhooks",
      op: "isDbHealthy",
      expected: false,
    });
    return false;
  }
}

/**
 * Log webhook event for audit trail and debugging.
 * Prevents duplicate processing via unique eventId constraint.
 *
 * If a previous attempt exists but failed (has error and processed=true),
 * it is eligible for retry — returns isNew: true so the handler re-runs.
 */
export async function logWebhookEvent(
  provider: string,
  eventId: string,
  eventType: string,
  payload: unknown,
  signature?: string,
): Promise<{ isNew: boolean; eventRecordId?: string }> {
  try {
    // Check if event already exists
    const existing = await prisma.webhookEvent.findUnique({
      where: { eventId },
    });

    if (existing) {
      // Three-state machine using processed + error fields:
      //   processed=true  + no error  → SUCCESS: skip (idempotent)
      //   processed=true  + error set → FAILED:  allow retry (reset & re-process)
      //   processed=false + no error  → IN-PROGRESS: skip (another worker handling it)
      // This avoids a separate status enum while letting providers like Stream
      // retry failed events instead of silently dropping them.
      // If previously processed successfully, skip (true idempotency)
      if (existing.processed && !existing.error) {
        console.log(
          `⚠️ Webhook event ${eventId} already processed successfully, skipping`,
        );
        return { isNew: false, eventRecordId: existing.id };
      }

      // If previous attempt failed, allow retry by resetting state.
      //
      // `receivedAt` MUST move with it. The staleness check below measures
      // `now - receivedAt`, and a retried row keeps its original timestamp — so
      // every retry was instantly older than the 5-minute threshold and the
      // in-progress guard fell open for exactly the rows it exists to protect.
      // Two sweeper workers could then claim the same event simultaneously.
      //
      // The `updateMany` + count is the claim: two workers racing here, only one
      // sees `count === 1`, and the loser is told the row is not new. A bare
      // `update` cannot express that — it succeeds for both.
      if (existing.error) {
        const claimed = await prisma.webhookEvent.updateMany({
          where: { eventId, error: { not: null } },
          data: {
            processed: false,
            processedAt: null,
            error: null,
            receivedAt: new Date(),
            payload: payload as Prisma.InputJsonValue,
          },
        });
        if (claimed.count === 0) {
          console.log(
            `⚠️ Webhook event ${eventId} claimed by another worker, skipping`,
          );
          return { isNew: false, eventRecordId: existing.id };
        }
        console.log(
          `🔄 Webhook event ${eventId} previously failed, allowing retry`,
        );
        return { isNew: true, eventRecordId: existing.id };
      }

      // Currently being processed (processed=false, no error).
      // Add staleness check: if the event has been "in progress" for > 5 minutes,
      // treat it as abandoned (e.g., after() callback didn't run due to crash)
      // and allow reprocessing.
      const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
      const age = Date.now() - new Date(existing.receivedAt).getTime();
      if (age > STALE_THRESHOLD_MS) {
        // Claim it atomically. Reading the age and then writing is check-then-act:
        // two workers both see the row as stale, both write, and both believe
        // they own it — so the same event gets processed twice. Scoping the
        // update to the timestamp we read means exactly one write can land.
        const claimed = await prisma.webhookEvent.updateMany({
          where: { eventId, receivedAt: existing.receivedAt },
          data: {
            processed: false,
            processedAt: null,
            error: null,
            receivedAt: new Date(),
            payload: payload as Prisma.InputJsonValue,
          },
        });
        if (claimed.count === 0) {
          console.log(
            `⚠️ Webhook event ${eventId} claimed by another worker, skipping`,
          );
          return { isNew: false, eventRecordId: existing.id };
        }
        console.log(
          `🔄 Webhook event ${eventId} stale (in-progress for ${Math.round(age / 1000)}s), allowing retry`,
        );
        return { isNew: true, eventRecordId: existing.id };
      }

      console.log(
        `⚠️ Webhook event ${eventId} currently being processed, skipping`,
      );
      return { isNew: false, eventRecordId: existing.id };
    }

    // Create new event record
    const event = await prisma.webhookEvent.create({
      data: {
        provider,
        eventId,
        eventType,
        payload: payload as Prisma.InputJsonValue,
        signature,
        processed: false,
      },
    });

    return { isNew: true, eventRecordId: event.id };
  } catch (error) {
    // Handle unique constraint violation (race condition)
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      console.log(`⚠️ Webhook event ${eventId} duplicate (race condition)`);
      return { isNew: false };
    }
    throw error;
  }
}

/**
 * Close out a delivery: `processed=true` always, plus the error if there was one.
 *
 * The docstring used to say "only sets processed=true on success", which the
 * implementation contradicts and has to — `processed=true` with a non-null
 * `error` is the FAILED state that `logWebhookEvent` re-drives. Setting it only
 * on success would leave failures stuck in IN-PROGRESS forever.
 *
 * `error ?? null`, not `error || null`. A handler that throws `new Error("")`
 * yields an empty `processingError`, and `"" || null` collapses to null — which
 * is the SUCCESS shape. The event failed and was permanently marked handled, and
 * the sweeper's selector explicitly skips `processed=true, error=null`, so
 * nothing would ever look at it again. An empty message becomes a readable
 * placeholder rather than a silent success.
 */
/**
 * Error prefixes that mean "never re-drive this row".
 *
 * The sweeper re-drives any row carrying an error, bounded by a 168-hour
 * give-up window. That is right for a transient failure and wrong for a
 * permanent one: a payload that does not match its schema will not match it in
 * six days either, so the row churns through ~1,000 pointless re-drives and
 * then ages out anyway.
 *
 * `gave up:` was already the terminal marker, written by the sweeper itself
 * when a deferred event ages past the cap, and matched by a string literal in
 * its `where` clause with a comment asking whoever edits it to keep the two in
 * sync by hand. This makes the set a shared constant instead.
 *
 * The prefix is load-bearing; everything after it is for whoever reads the row.
 */
export const TERMINAL_ERROR_PREFIXES = [
  // Aged past the give-up window. Written by sweep-stuck-webhook-events.
  "gave up:",
  // Structurally impossible to process — schema mismatch. Written at dispatch.
  "permanent:",
] as const;

/** Build the prefix marker a permanently-unprocessable row should carry. */
export function permanentFailure(reason: string): string {
  return `permanent: ${reason}`;
}

/** True when this row must never be re-driven, whatever its age. */
export function isTerminalWebhookError(error: string | null): boolean {
  if (!error) return false;
  return TERMINAL_ERROR_PREFIXES.some((prefix) => error.startsWith(prefix));
}

export async function markWebhookEventProcessed(
  eventId: string,
  error?: string,
): Promise<void> {
  await prisma.webhookEvent.update({
    where: { eventId },
    data: {
      processed: true,
      processedAt: new Date(),
      error: error === undefined ? null : error || "unknown handler error",
    },
  });
}
