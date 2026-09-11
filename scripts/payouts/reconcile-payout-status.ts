/**
 * Payout Status Reconciliation - Core Logic
 *
 * Reconciles payout status with payment gateways (Stripe/RazorpayX).
 * Finds PENDING/PROCESSING payouts older than 48h and queries gateways for actual status.
 *
 * This catches cases where:
 * - Payout webhook was missed or delayed
 * - DB update failed after gateway processed payout
 * - Gateway status changed without webhook
 *
 * This module exports the core reconciliation function.
 * It is imported by:
 * - jobs/reconcile-payout-status.ts (GitHub Actions)
 * - app/api/cleanup/reconcile-payout-status/route.ts (API endpoint)
 *
 * Schedule: Every 6 hours
 */

import prisma from "../../lib/prisma";
import { PayoutStatus, PaymentGateway } from "@prisma/client";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import { handlePayoutWebhook } from "@/lib/payments/payouts";
import { resolveRazorpayXCredentials } from "@/lib/payments/payouts/razorpay-payouts";

// #677 PM-15 — narrow PayoutStatus to the status union handlePayoutWebhook
// accepts. mapGatewayStatus only ever returns these four, so the rest map to
// undefined (treated as "no canonical transition" at the call site).
const WEBHOOK_STATUS_MAP: Partial<
  Record<
    PayoutStatus,
    "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED"
  >
> = {
  [PayoutStatus.COMPLETED]: "COMPLETED",
  [PayoutStatus.PROCESSING]: "PROCESSING",
  [PayoutStatus.FAILED]: "FAILED",
  [PayoutStatus.CANCELLED]: "CANCELLED",
};

// Only reconcile payouts older than 48 hours (give webhooks time)
const MIN_AGE_HOURS = 48;

// Don't reconcile payouts older than 30 days
const MAX_AGE_DAYS = 30;

export interface PayoutReconciliationResult {
  success: boolean;
  totalProcessed: number;
  reconciledCount: number;
  completedCount: number;
  failedCount: number;
  skippedCount: number;
  discrepancies: string[];
  errors: string[];
  timestamp: string;
}

/**
 * Query Stripe for payout/transfer status
 */
async function getStripePayoutStatus(
  providerPayoutId: string,
): Promise<{ status: string; failureMessage?: string } | null> {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    console.warn("Stripe credentials not configured");
    return null;
  }

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeSecretKey);

    // Check if it's a transfer (tr_) or payout (po_)
    if (providerPayoutId.startsWith("tr_")) {
      const transfer = await stripe.transfers.retrieve(providerPayoutId);
      return {
        status: transfer.reversed ? "reversed" : "paid",
      };
    } else if (providerPayoutId.startsWith("po_")) {
      const payout = await stripe.payouts.retrieve(providerPayoutId);
      return {
        status: payout.status,
        failureMessage: payout.failure_message || undefined,
      };
    }

    return null;
  } catch (error) {
    console.error(`Failed to get Stripe payout status: ${error}`);
    return null;
  }
}

/**
 * Query RazorpayX for payout status
 */
async function getRazorpayPayoutStatus(
  providerPayoutId: string,
): Promise<{ status: string; failureReason?: string; utr?: string } | null> {
  // #1407 — the same resolver the disbursement path uses. Reading
  // RAZORPAY_KEY_ID/RAZORPAY_SECRET here authenticated as the checkout
  // merchant, not the RazorpayX one, so on an account with distinct X keys
  // every lookup 401s and this reconciliation is silently dead while it
  // looks green. (#677 PM-1 kept the RAZORPAY_SECRET fallback, inside the
  // resolver now.)
  const { keyId, keySecret } = resolveRazorpayXCredentials();

  if (!keyId || !keySecret) {
    console.warn("RazorpayX credentials not configured");
    return null;
  }

  try {
    const response = await fetch(
      `https://api.razorpay.com/v1/payouts/${providerPayoutId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
        },
      },
    );

    if (!response.ok) {
      console.error(`RazorpayX API error: ${response.status}`);
      return null;
    }

    const payout = await response.json();
    return {
      status: payout.status,
      failureReason: payout.failure_reason,
      // #677 PM-15 — RazorpayX returns the bank UTR on a processed payout;
      // capture it so the COMPLETED delegation can persist the reference.
      utr: payout.utr,
    };
  } catch (error) {
    console.error(`Failed to get RazorpayX payout status: ${error}`);
    return null;
  }
}

/**
 * Map gateway payout status to our PayoutStatus
 */
function mapGatewayStatus(
  gateway: PaymentGateway,
  status: string,
): PayoutStatus | null {
  if (gateway === PaymentGateway.STRIPE) {
    switch (status.toLowerCase()) {
      case "paid":
        return PayoutStatus.COMPLETED;
      case "pending":
        return PayoutStatus.PROCESSING;
      case "in_transit":
        return PayoutStatus.PROCESSING;
      case "canceled":
        return PayoutStatus.CANCELLED;
      case "failed":
        return PayoutStatus.FAILED;
      // This poller only walks PENDING/PROCESSING payouts, where the PAYOUT
      // ledger txn was never posted — a gateway "reversed" here is a net-zero
      // round trip, so FAILED handling (unlink earnings, reverse TDS) is the
      // correct accounting. Post-COMPLETED reversals arrive via the
      // payout.reversed webhook → markConsultantPayoutReversed (#812), which
      // does post the counter-txn. The failureReason records the distinction.
      case "reversed":
        return PayoutStatus.FAILED;
      default:
        return null;
    }
  } else if (gateway === PaymentGateway.RAZORPAY) {
    switch (status.toLowerCase()) {
      case "processed":
        return PayoutStatus.COMPLETED;
      case "processing":
        return PayoutStatus.PROCESSING;
      case "queued":
        return PayoutStatus.PROCESSING;
      case "pending":
        return PayoutStatus.PROCESSING;
      case "rejected":
        return PayoutStatus.FAILED;
      // #1407 — RazorpayX returns `failed` for a payout the bank refused after
      // it was queued, and the arm had only `rejected`. That is precisely the
      // cohort this sweep walks, so the payout fell through as an unknown
      // status and was skipped: PENDING/PROCESSING forever, earnings still
      // batched against money that never left. The Stripe arm has always
      // mapped it. FAILED delegation un-batches the earnings and reverses TDS.
      case "failed":
        return PayoutStatus.FAILED;
      case "reversed":
        return PayoutStatus.FAILED;
      case "cancelled":
        return PayoutStatus.CANCELLED;
      default:
        return null;
    }
  }

  return null;
}

/**
 * Reconcile stale PENDING/PROCESSING payouts with gateway status
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function reconcilePayoutStatus(): Promise<PayoutReconciliationResult> {
  return withCronLock("reconcile-payout-status", { failMode: "closed", ttlMs: LONG_JOB_TTL_MS }, () =>
    reconcilePayoutStatusUnlocked(),
  );
}

async function reconcilePayoutStatusUnlocked(): Promise<PayoutReconciliationResult> {
  const errors: string[] = [];
  const discrepancies: string[] = [];
  let reconciledCount = 0;
  let completedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  const minAge = new Date(Date.now() - MIN_AGE_HOURS * 60 * 60 * 1000);
  const maxAge = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

  // Find stale PENDING or PROCESSING payouts
  const stalePayouts = await prisma.consultantPayout.findMany({
    where: {
      status: { in: [PayoutStatus.PENDING, PayoutStatus.PROCESSING] },
      updatedAt: {
        lt: minAge,
        gte: maxAge,
      },
      // Only payouts with gateway reference
      providerPayoutId: { not: null },
    },
    include: {
      consultantProfile: {
        include: {
          user: { select: { email: true, name: true } },
        },
      },
    },
    orderBy: { updatedAt: "asc" },
  });

  // #1407 — the pre-flight gate has to test the credentials the lookup will
  // actually send, or it reports "configured" and every lookup still 401s.
  const razorpayXCredentials = resolveRazorpayXCredentials();
  const razorpayConfigured = !!(
    razorpayXCredentials.keyId && razorpayXCredentials.keySecret
  );
  if (!razorpayConfigured) {
    console.warn(
      "⚠️ Razorpay credentials not configured — Razorpay records will be skipped",
    );
  }

  console.log(
    `Found ${stalePayouts.length} stale PENDING/PROCESSING payouts to reconcile`,
  );

  for (const payout of stalePayouts) {
    console.log(`\nReconciling payout ${payout.id}`);
    console.log(`   Provider: ${payout.provider}`);
    console.log(`   Provider Payout ID: ${payout.providerPayoutId}`);
    console.log(`   Current Status: ${payout.status}`);
    console.log(
      `   Consultant: ${payout.consultantProfile.user.name || "Unknown"}`,
    );
    console.log(
      `   Amount: ${payout.currency} ${(payout.amount / 100).toFixed(2)}`,
    );
    console.log(`   Last updated: ${payout.updatedAt.toISOString()}`);

    // Skip if no provider payout ID
    if (!payout.providerPayoutId) {
      console.log(`   Skipping - no provider payout ID`);
      skippedCount++;
      continue;
    }

    // Query gateway for actual status
    let gatewayStatus: {
      status: string;
      failureMessage?: string;
      failureReason?: string;
      utr?: string;
    } | null = null;

    if (payout.provider === PaymentGateway.STRIPE) {
      gatewayStatus = await getStripePayoutStatus(payout.providerPayoutId);
    } else if (payout.provider === PaymentGateway.RAZORPAY) {
      if (!razorpayConfigured) {
        console.log(`   Skipping - Razorpay credentials not configured`);
        skippedCount++;
        continue;
      }
      gatewayStatus = await getRazorpayPayoutStatus(payout.providerPayoutId);
    } else {
      console.log(`   Skipping - unsupported gateway: ${payout.provider}`);
      skippedCount++;
      continue;
    }

    if (!gatewayStatus) {
      console.log(`   Could not get status from gateway - skipping`);
      errors.push(`Payout ${payout.id}: Could not query gateway status`);
      skippedCount++;
      continue;
    }

    console.log(`   Gateway status: ${gatewayStatus.status}`);

    // Map gateway status to our status
    const mappedStatus = mapGatewayStatus(
      payout.provider,
      gatewayStatus.status,
    );

    if (!mappedStatus) {
      console.log(`   Unknown gateway status - skipping`);
      skippedCount++;
      continue;
    }

    // Update if status changed
    if (mappedStatus !== payout.status) {
      const discrepancy = `Payout ${payout.id}: DB shows ${payout.status}, gateway shows ${gatewayStatus.status} (${mappedStatus})`;
      discrepancies.push(discrepancy);
      console.log(`   ⚠️ DISCREPANCY: ${discrepancy}`);

      // #677 PM-15 — the old inline `status=COMPLETED` + `earnings PAID` flip
      // bypassed the canonical webhook handler, so on this reconcile path TDS
      // was never recorded, the payout ledger postings (revenue/payable
      // counters) never ran, and the gateway UTR was dropped. Delegate the
      // full money recording to handlePayoutWebhook, the same engine the live
      // webhook uses. It claims `status notIn [COMPLETED, CANCELLED]`, so it is
      // idempotent against a live webhook racing this reconcile — whichever
      // fires first wins and the other no-ops.
      const webhookStatus = WEBHOOK_STATUS_MAP[mappedStatus];
      if (!webhookStatus) {
        // mapGatewayStatus only yields COMPLETED/PROCESSING/FAILED/CANCELLED,
        // so this is unreachable; keep it explicit rather than silently drop.
        console.log(`   No webhook mapping for ${mappedStatus} - skipping`);
        skippedCount++;
        continue;
      }

      await handlePayoutWebhook(
        payout.provider,
        payout.providerPayoutId,
        webhookStatus,
        mappedStatus === PayoutStatus.FAILED
          ? (gatewayStatus.status.toLowerCase() === "reversed"
              ? "gateway reversed pre-completion (net-zero round trip): "
              : "") +
              (gatewayStatus.failureMessage ||
                gatewayStatus.failureReason ||
                gatewayStatus.status)
          : undefined,
        // UTR persists only on the COMPLETED branch inside the handler.
        gatewayStatus.utr,
      );

      console.log(
        `   Reconciled via webhook handler: ${payout.status} → ${mappedStatus}`,
      );
      reconciledCount++;

      if (mappedStatus === PayoutStatus.COMPLETED) {
        completedCount++;
      } else if (mappedStatus === PayoutStatus.FAILED) {
        failedCount++;
        console.log(`   ⚠️ Payout failed - consultant may need notification!`);
      }
    } else {
      console.log(`   Status unchanged (${mappedStatus})`);
    }
  }

  // Summary
  console.log("\n📊 Payout Reconciliation Summary:");
  console.log(`   Total processed: ${stalePayouts.length}`);
  console.log(`   Reconciled (status changed): ${reconciledCount}`);
  console.log(`   Completed payouts found: ${completedCount}`);
  console.log(`   Failed payouts found: ${failedCount}`);
  console.log(`   Skipped: ${skippedCount}`);
  console.log(`   Discrepancies found: ${discrepancies.length}`);

  if (discrepancies.length > 0) {
    console.log("\n⚠️ DISCREPANCIES DETECTED:");
    discrepancies.forEach((d) => console.log(`   - ${d}`));
  }

  return {
    success: errors.length === 0,
    totalProcessed: stalePayouts.length,
    reconciledCount,
    completedCount,
    failedCount,
    skippedCount,
    discrepancies,
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
