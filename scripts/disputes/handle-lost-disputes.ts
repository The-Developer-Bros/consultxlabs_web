/**
 * Lost Dispute Handler - Core Logic
 *
 * Handles lost Stripe disputes by cascading impact to consultant earnings.
 * When a dispute is lost, the consultant's earnings must be marked as REFUNDED
 * to prevent incorrect payouts.
 *
 * This catches cases where:
 * - Dispute webhook was missed or delayed
 * - DB update failed after Stripe API call
 * - Manual dispute resolution at gateway
 *
 * This module exports the core handler function.
 * It is imported by:
 * - jobs/handle-lost-disputes.ts (GitHub Actions)
 * - app/api/cleanup/handle-lost-disputes/route.ts (API endpoint)
 *
 * GitHub Issue: #304
 * Schedule: Every 6 hours
 */

import prisma from "../../lib/prisma";
import { DisputeStatus, EarningStatus } from "@prisma/client";
import { refundEarnings } from "../../lib/payments/payouts/earnings-service";
import { withCronLock } from "@/lib/cron/with-cron-lock";

export interface LostDisputeHandlerResult {
  success: boolean;
  totalProcessed: number;
  updatedCount: number;
  skippedCount: number;
  alreadyPaidCount: number;
  errorCount: number;
  errors: string[];
  timestamp: string;
}

/**
 * Find lost disputes with non-REFUNDED earnings and update them
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function handleLostDisputes(): Promise<LostDisputeHandlerResult> {
  return withCronLock("handle-lost-disputes", { failMode: "closed" }, () =>
    handleLostDisputesUnlocked(),
  );
}

async function handleLostDisputesUnlocked(): Promise<LostDisputeHandlerResult> {
  const errors: string[] = [];
  let updatedCount = 0;
  let skippedCount = 0;
  let alreadyPaidCount = 0;
  let errorCount = 0;

  // Find all LOST disputes where associated earnings haven't been updated
  const lostDisputes = await prisma.dispute.findMany({
    where: {
      status: DisputeStatus.LOST,
      payment: {
        earnings: {
          some: {
            status: {
              notIn: [EarningStatus.REFUNDED], // Not already refunded
            },
          },
        },
      },
    },
    include: {
      payment: {
        include: {
          earnings: {
            include: {
              consultantProfile: {
                include: {
                  user: { select: { name: true, email: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  console.log(
    `Found ${lostDisputes.length} lost disputes with non-REFUNDED earnings`,
  );

  for (const dispute of lostDisputes) {
    const earningsList = dispute.payment.earnings;

    if (!earningsList || earningsList.length === 0) {
      console.log(
        `⏭️ Skipping dispute ${dispute.disputeId} - no associated earnings record`,
      );
      skippedCount++;
      continue;
    }

    // FIX #567: Use the canonical refundEarnings() path instead of reimplementing.
    // This ensures TDS reversal for PAID earnings, correct revenue field
    // (totalRevenue for PAID, pendingRevenue for non-PAID), and refundedShareAmount tracking.
    const paymentId = dispute.payment?.id;
    if (!paymentId) {
      console.warn(
        `⏭️ Skipping dispute ${dispute.disputeId} - no payment linked`,
      );
      skippedCount++;
      continue;
    }

    // Count PAID earnings for summary reporting
    const paidEarningsCount = earningsList.filter(
      (e) => e.status === EarningStatus.PAID,
    ).length;
    if (paidEarningsCount > 0) {
      alreadyPaidCount += paidEarningsCount;
      console.warn(
        `⚠️ Dispute ${dispute.disputeId} has ${paidEarningsCount} PAID earnings — forceRefund will reverse revenue + TDS`,
      );
    }

    try {
      await refundEarnings(paymentId, { forceRefund: true });
      updatedCount += earningsList.length;
      console.log(
        `✅ Refunded earnings for dispute ${dispute.disputeId} (${earningsList.length} records via refundEarnings)`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      errors.push(`Dispute ${dispute.disputeId}: ${errorMessage}`);
      console.error(
        `❌ Error refunding earnings for dispute ${dispute.disputeId}:`,
        errorMessage,
      );
      errorCount++;
    }
  }

  // Log summary of critical cases
  if (alreadyPaidCount > 0) {
    console.log(
      `\n⚠️ ATTENTION: ${alreadyPaidCount} earnings were already PAID when dispute was lost - manual recovery required!`,
    );
  }

  return {
    success: errors.length === 0,
    totalProcessed: lostDisputes.length,
    updatedCount,
    skippedCount,
    alreadyPaidCount,
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
