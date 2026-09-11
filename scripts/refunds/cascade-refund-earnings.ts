/**
 * Refund-Earning Cascade — Cron Entry Point
 *
 * Picks up SUCCEEDED gateway-initiated `Refund` rows whose downstream
 * earnings (ConsultantEarnings + OrganizationEarnings) have NOT yet
 * been reversed and runs the canonical cascade.
 *
 * History: this script used to inline the ConsultantEarnings update
 * (only flipped status to REFUNDED, ignored OrganizationEarnings, the
 * wallet, BookingUtilization, and OrganizationPayout clawback). Since
 * C1 it delegates to `applyRefundCascade` in
 * `lib/payments/operations/refund.ts` so app-initiated and
 * gateway-initiated refunds share one code path.
 *
 * Two consumers:
 *   - `jobs/refunds/cascade-refund-earnings.ts` (GitHub Actions schedule)
 *   - `app/api/cleanup/cascade-refund-earnings/route.ts` (HTTP trigger)
 *
 * GitHub Issue: #305
 * Schedule: Every 15 minutes
 */

import { Prisma, RefundStatus } from "@prisma/client";

import prisma from "../../lib/prisma";
import { applyRefundCascade } from "../../lib/payments/operations/refund";
import { withCronLock } from "@/lib/cron/with-cron-lock";

export interface RefundEarningCascadeResult {
  success: boolean;
  totalProcessed: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  errors: string[];
  timestamp: string;
}

export interface CascadeRefundOptions {
  /** #1356 — caps the batch for the Netlify ticker's 6s per-target timeout;
   * undefined keeps the unbounded GitHub Actions behaviour. */
  limit?: number;
}

/**
 * Find SUCCEEDED refunds that have not yet been cascaded and run the canonical
 * cascade against each.
 *
 * #776 — filter on `cascadedAt IS NULL` (the cascade's idempotency stamp) rather
 * than the old `refundedShareAmount = 0` earnings heuristic. The heuristic raced
 * the gateway webhook (which also reverses earnings) and mis-handled zero-
 * consultant-share earnings; `cascadedAt` is the authoritative "not yet cascaded"
 * signal, and `applyRefundCascade` claims it atomically so this cron, the webhook
 * and the app path can never double-process the same refund.
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function cascadeRefundToEarnings(
  opts: CascadeRefundOptions = {},
): Promise<RefundEarningCascadeResult> {
  return withCronLock("cascade-refund-earnings", { failMode: "closed" }, () =>
    cascadeRefundToEarningsUnlocked(opts),
  );
}

async function cascadeRefundToEarningsUnlocked(
  opts: CascadeRefundOptions = {},
): Promise<RefundEarningCascadeResult> {
  const errors: string[] = [];
  let updatedCount = 0;
  let errorCount = 0;

  const refundsToProcess = await prisma.refund.findMany({
    where: {
      status: RefundStatus.SUCCEEDED,
      cascadedAt: null,
    },
    select: {
      id: true,
      amountPaise: true,
      reason: true,
      paymentId: true,
    },
    take: opts.limit,
  });

  console.log(
    `Found ${refundsToProcess.length} succeeded refunds with un-cascaded earnings`,
  );

  for (const refund of refundsToProcess) {
    try {
      await prisma.$transaction(
        async (tx) => {
          await applyRefundCascade(tx, {
            paymentId: refund.paymentId,
            refundId: refund.id,
            amountPaise: refund.amountPaise,
            reason: refund.reason ?? "Gateway refund cascade",
            initiatedByUserId: null, // gateway-initiated
          });
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 15_000,
        },
      );
      console.log(`Cascade applied for refund ${refund.id}`);
      updatedCount++;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      errors.push(`Refund ${refund.id}: ${errorMessage}`);
      console.error(`Cascade failed for refund ${refund.id}:`, errorMessage);
      errorCount++;
    }
  }

  const skippedCount = refundsToProcess.length - updatedCount - errorCount;

  return {
    success: errors.length === 0,
    totalProcessed: refundsToProcess.length,
    updatedCount,
    skippedCount,
    errorCount,
    errors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
