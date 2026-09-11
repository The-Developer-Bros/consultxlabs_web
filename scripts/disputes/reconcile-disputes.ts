/**
 * Dispute Reconciliation - Core Logic
 *
 * Reconciles dispute status with payment gateways to ensure data consistency.
 * Handles cases where:
 * - DB update failed after Stripe API call succeeded
 * - Webhooks were missed or delayed
 * - Dispute status changed but webhook wasn't received
 *
 * This module exports the core reconciliation function.
 * It is imported by:
 * - jobs/reconcile-disputes.ts (GitHub Actions)
 * - app/api/cleanup/reconcile-disputes/route.ts (API endpoint)
 */

import prisma from "../../lib/prisma";
import { DisputeStatus, PaymentGateway, Prisma } from "@prisma/client";
import { getDispute } from "../../lib/payments";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";

// Prioritize disputes with approaching deadlines (7 days)
const APPROACHING_DEADLINE_MS = 7 * 24 * 60 * 60 * 1000;

// Flag disputes not updated in 24 hours as potentially stale
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface DisputeReconciliationResult {
  success: boolean;
  totalProcessed: number;
  reconciledCount: number;
  urgentCount: number;
  razorpayManualReviewCount: number;
  /** #1459 — Stripe disputes left untouched because the gateway fence is shut. */
  skippedFenced: number;
  errors: string[];
  timestamp: string;
}

/**
 * Map gateway dispute status to Prisma DisputeStatus
 */
function mapGatewayDisputeStatus(status: string): DisputeStatus {
  switch (status.toLowerCase()) {
    case "warning_needs_response":
      return DisputeStatus.WARNING_NEEDS_RESPONSE;
    case "warning_under_review":
      return DisputeStatus.WARNING_UNDER_REVIEW;
    case "warning_closed":
      return DisputeStatus.WARNING_CLOSED;
    case "needs_response":
      return DisputeStatus.NEEDS_RESPONSE;
    case "under_review":
      return DisputeStatus.UNDER_REVIEW;
    case "charge_refunded":
      return DisputeStatus.CHARGE_REFUNDED;
    case "won":
      return DisputeStatus.WON;
    case "lost":
      return DisputeStatus.LOST;
    default:
      console.warn(
        `Unknown dispute status: ${status}, defaulting to NEEDS_RESPONSE`,
      );
      return DisputeStatus.NEEDS_RESPONSE;
  }
}

/**
 * Find and reconcile disputes that may have stale status
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function reconcileDisputes(): Promise<DisputeReconciliationResult> {
  return withCronLock(
    "reconcile-disputes",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => reconcileDisputesUnlocked(),
  );
}

async function reconcileDisputesUnlocked(): Promise<DisputeReconciliationResult> {
  const approachingDeadline = new Date(Date.now() + APPROACHING_DEADLINE_MS);
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);
  const urgentThreshold = new Date(Date.now() + 48 * 60 * 60 * 1000);

  const errors: string[] = [];
  let reconciledCount = 0;
  let urgentCount = 0;
  let razorpayManualReviewCount = 0;
  let skippedFenced = 0;
  // #1351 — Stripe is a contingency rail that is off in production, so the
  // client has no usable credentials. Read once: the fence cannot change
  // mid-run, and a per-dispute read would suggest it could.
  const stripeEnabled = process.env.STRIPE_ENABLED === "true";

  // Find disputes needing reconciliation
  const disputesToReconcile = await prisma.dispute.findMany({
    where: {
      status: {
        in: [
          DisputeStatus.NEEDS_RESPONSE,
          DisputeStatus.WARNING_NEEDS_RESPONSE,
          DisputeStatus.UNDER_REVIEW,
          DisputeStatus.WARNING_UNDER_REVIEW,
        ],
      },
      OR: [
        { dueBy: { lte: approachingDeadline } },
        { updatedAt: { lt: staleThreshold } },
      ],
    },
    include: {
      payment: true,
    },
    orderBy: {
      dueBy: "asc",
    },
  });

  console.log(`Found ${disputesToReconcile.length} disputes to reconcile`);

  for (const dispute of disputesToReconcile) {
    try {
      // Check if dispute is urgent
      if (
        dispute.dueBy &&
        dispute.dueBy.getTime() < urgentThreshold.getTime()
      ) {
        urgentCount++;
        console.warn(
          `⚠️ URGENT: Dispute ${dispute.disputeId} due by ${dispute.dueBy.toISOString()}`,
        );
      }

      // #789 — Razorpay now exposes a dispute API (GET /v1/disputes/:id,
      // PATCH /v1/disputes/:id/contest, POST /v1/disputes/:id/accept), so
      // this gateway could be reconciled programmatically rather than routed
      // to manual dashboard review. Wiring that fetch is tracked separately;
      // until then we keep the manual-review fallback.
      if (dispute.paymentGateway === PaymentGateway.RAZORPAY) {
        razorpayManualReviewCount++;
        console.log(
          `📋 Razorpay dispute ${dispute.disputeId} requires manual dashboard review`,
        );
        continue;
      }

      // Skip non-Stripe gateways
      if (dispute.paymentGateway !== PaymentGateway.STRIPE) {
        console.log(
          `⏭️ Skipping dispute ${dispute.disputeId} - unsupported gateway: ${dispute.paymentGateway}`,
        );
        continue;
      }

      // #1459 — with the fence shut every getDispute call throws, so the run
      // reported success:false and the sweep looked broken when it was simply
      // asked to reconcile a gateway we deliberately turned off. Count the skip
      // instead: these disputes are still visible to an operator in the result.
      if (!stripeEnabled) {
        skippedFenced++;
        console.log(
          `⏭️ Skipping Stripe dispute ${dispute.disputeId} — STRIPE_ENABLED is not "true"`,
        );
        continue;
      }

      // Query Stripe for current dispute status
      const gatewayDispute = await getDispute(
        dispute.disputeId,
        PaymentGateway.STRIPE,
      );

      // Check if status has changed
      const newStatus = mapGatewayDisputeStatus(gatewayDispute.status);
      if (newStatus !== dispute.status) {
        await prisma.dispute.update({
          where: { disputeId: dispute.disputeId },
          data: {
            status: newStatus,
            evidence: gatewayDispute.evidence as Prisma.InputJsonValue,
            isChargeRefundable: gatewayDispute.isChargeRefundable,
            dueBy: gatewayDispute.dueBy,
          },
        });

        console.log(
          `✅ Reconciled dispute ${dispute.disputeId}: ${dispute.status} -> ${newStatus}`,
        );
        reconciledCount++;
      } else {
        // Update dueBy and evidence even if status unchanged
        await prisma.dispute.update({
          where: { disputeId: dispute.disputeId },
          data: {
            dueBy: gatewayDispute.dueBy,
            evidence: gatewayDispute.evidence as Prisma.InputJsonValue,
            isChargeRefundable: gatewayDispute.isChargeRefundable,
          },
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      // Also check error code as fallback for StripeError
      const errorCode = (error as { code?: string })?.code;

      // Handle "dispute not found" case - check both error code and message patterns.
      // FIX #566: Do NOT mark as WON — a missing dispute could be a transient
      // API error, a Stripe-side delay, or a dispute that was resolved outside
      // our system. Log it for manual review instead.
      if (
        errorCode === "resource_missing" ||
        errorMessage.includes("resource_missing") ||
        errorMessage.includes("not found") ||
        errorMessage.includes("No such") ||
        errorMessage.includes("does not exist")
      ) {
        const existingEvidence = (dispute.evidence ?? {}) as Record<
          string,
          unknown
        >;
        await prisma.dispute.update({
          where: { disputeId: dispute.disputeId },
          data: {
            evidence: {
              ...existingEvidence,
              reconciliation_note:
                "Dispute not found at gateway — flagged for manual review (not auto-resolved)",
              reconciled_at: new Date().toISOString(),
            } as Prisma.InputJsonValue,
          },
        });
        console.warn(
          `⚠️ Dispute ${dispute.disputeId} not found at gateway — flagged for manual review (status unchanged)`,
        );
      } else {
        errors.push(`Dispute ${dispute.disputeId}: ${errorMessage}`);
        console.error(
          `Error reconciling dispute ${dispute.disputeId}:`,
          errorMessage,
        );
      }
    }
  }

  return {
    success: errors.length === 0,
    totalProcessed: disputesToReconcile.length,
    reconciledCount,
    urgentCount,
    razorpayManualReviewCount,
    skippedFenced,
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
