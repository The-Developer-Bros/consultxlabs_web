#!/usr/bin/env node

/**
 * Create Payout Batch Script
 *
 * Creates weekly payout batches for eligible consultants.
 * Aggregates READY earnings into payout records for admin approval.
 *
 * This module exports functions that can be used by:
 * - Local development: `npm run scripts:create-payout-batch`
 * - GitHub Actions: `jobs/create-payout-batch.ts`
 * - API routes: Can import and call functions directly
 *
 * Schedule: Runs weekly on Mondays at 1:30 AM IST (8:00 PM UTC Sunday)
 */

import { EarningStatus, PayoutStatus, PayoutMethod } from "@prisma/client";
import { randomUUID, createHash } from "crypto";
import prisma from "@/lib/prisma";
import { getActiveOrgMaintenanceWindow } from "@/lib/maintenance";
import {
  createOrgPayoutBatch,
  PayoutLockError,
  PayoutValidationError,
} from "@/lib/payments/payouts/org-payout-service";
import { sumPaise } from "@/lib/payments/utils/money";

// Configuration
const MINIMUM_PAYOUT_AMOUNT = 50000; // ₹500 in paise
const AUTO_APPROVE_THRESHOLD = 500000; // ₹5000 in paise

/**
 * Result structure for batch creation
 */
export interface BatchResult {
  success: boolean;
  batchId: string;
  payoutsCreated: number;
  totalAmount: number;
  autoApproved: number;
  pendingApproval: number;
  skippedNoAccount: number;
  errors: string[];
}

/**
 * Create a payout batch for all eligible consultants
 *
 * Finds consultants with:
 * - READY earnings >= minimum payout amount
 * - Verified payout account
 *
 * Creates payout records and links earnings.
 * Auto-approves payouts under the threshold.
 *
 * @param consultantProfileIds Optional list to limit to specific consultants
 * @returns BatchResult with details
 */
export async function createPayoutBatch(
  consultantProfileIds?: string[],
): Promise<BatchResult> {
  console.log("📦 Starting payout batch creation...");

  const batchId = `batch_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const result: BatchResult = {
    success: false,
    batchId,
    payoutsCreated: 0,
    totalAmount: 0,
    autoApproved: 0,
    pendingApproval: 0,
    skippedNoAccount: 0,
    errors: [],
  };

  try {
    // Get eligible consultants with ready earnings >= minimum payout
    const eligibleConsultants = await prisma.consultantEarnings.groupBy({
      by: ["consultantProfileId"],
      where: {
        status: EarningStatus.READY,
        payoutId: null,
        ...(consultantProfileIds?.length
          ? { consultantProfileId: { in: consultantProfileIds } }
          : {}),
      },
      _sum: { consultantSharePaise: true },
      having: {
        consultantSharePaise: {
          _sum: { gte: MINIMUM_PAYOUT_AMOUNT },
        },
      },
    });

    console.log(`📊 Found ${eligibleConsultants.length} eligible consultants`);

    if (eligibleConsultants.length === 0) {
      console.log("✅ No consultants eligible for payout at this time");
      result.success = true;
      return result;
    }

    // Process each eligible consultant
    // FIX #617: The groupBy _sum.consultantSharePaise is only used for candidate selection.
    // The actual payable amount is re-computed inside the transaction to subtract refundedShareAmount.
    for (const consultant of eligibleConsultants) {
      const { consultantProfileId } = consultant;

      try {
        // Get consultant's default payout account
        const account = await prisma.payoutAccount.findFirst({
          where: {
            consultantProfileId,
            isDefault: true,
            isVerified: true,
          },
        });

        if (!account) {
          console.warn(
            `⚠️ No verified payout account for consultant ${consultantProfileId}`,
          );
          result.skippedNoAccount++;
          continue;
        }

        // Determine payout method based on account type
        let method: PayoutMethod;
        switch (account.accountType) {
          case "UPI":
            method = PayoutMethod.UPI;
            break;
          case "STRIPE_CONNECT":
            method = PayoutMethod.STRIPE_TRANSFER;
            break;
          default:
            method = PayoutMethod.BANK_TRANSFER;
        }

        // FIX #617: Re-query earnings inside transaction and compute payable amount
        // that subtracts refundedShareAmount from partial refunds.
        const txResult = await prisma.$transaction(async (tx) => {
          const readyEarnings = await tx.consultantEarnings.findMany({
            where: {
              consultantProfileId,
              status: EarningStatus.READY,
              payoutId: null,
            },
            select: {
              id: true,
              consultantSharePaise: true,
              refundedShareAmount: true,
            },
          });

          if (readyEarnings.length === 0) return null;

          const amount = readyEarnings.reduce(
            (sum, e) =>
              sum + Math.max(e.consultantSharePaise - e.refundedShareAmount, 0),
            0,
          );

          if (amount < MINIMUM_PAYOUT_AMOUNT) return null;

          const shouldAutoApprove = amount < AUTO_APPROVE_THRESHOLD;

          const payout = await tx.consultantPayout.create({
            data: {
              consultantProfileId,
              provider: account.provider,
              amount,
              currency: "INR",
              status: shouldAutoApprove
                ? PayoutStatus.APPROVED
                : PayoutStatus.PENDING,
              method,
              batchId,
              idempotencyKey: `payout_${consultantProfileId}_${batchId}`,
              approvedAt: shouldAutoApprove ? new Date() : undefined,
              approvedBy: shouldAutoApprove ? "SYSTEM_AUTO_APPROVE" : undefined,
            },
          });

          // Link the exact earnings by ID (not broad filter).
          // #993 parity — mark BATCHED (not left READY): the earning is now
          // in a batch and must not be re-picked, but cash hasn't moved yet.
          // Leaving it READY meant the canonical handlers — which filter on
          // BATCHED — never saw these rows: earnings stayed welded to their
          // payout forever (never PAID on completion, permanently orphaned on
          // pre-gateway failure), and refundEarnings treated them as un-paid.
          const linkResult = await tx.consultantEarnings.updateMany({
            where: {
              id: { in: readyEarnings.map((e) => e.id) },
              status: EarningStatus.READY,
              payoutId: null,
            },
            data: {
              payoutId: payout.id,
              status: EarningStatus.BATCHED,
            },
          });

          if (linkResult.count !== readyEarnings.length) {
            throw new Error(
              `Payout linking race: expected ${readyEarnings.length}, linked ${linkResult.count} for ${consultantProfileId}`,
            );
          }

          console.log(
            `✅ Created payout for consultant ${consultantProfileId}: ₹${(amount / 100).toFixed(2)} [${shouldAutoApprove ? "AUTO-APPROVED" : "PENDING"}]`,
          );

          return { amount, shouldAutoApprove };
        });

        if (!txResult) continue;
        result.payoutsCreated++;
        result.totalAmount += txResult.amount;
        if (txResult.shouldAutoApprove) {
          result.autoApproved++;
        } else {
          result.pendingApproval++;
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        console.error(
          `❌ Failed to create payout for consultant ${consultantProfileId}:`,
          errorMessage,
        );
        result.errors.push(
          `Payout creation failed for ${consultantProfileId}: ${errorMessage}`,
        );
      }
    }

    result.success = result.errors.length === 0;

    // Summary
    console.log(`\n📈 Batch Creation Summary:`);
    console.log(`   📦 Batch ID: ${batchId}`);
    console.log(`   ✅ Payouts created: ${result.payoutsCreated}`);
    console.log(
      `   💰 Total amount: ₹${(result.totalAmount / 100).toFixed(2)}`,
    );
    console.log(`   🤖 Auto-approved: ${result.autoApproved}`);
    console.log(`   ⏳ Pending approval: ${result.pendingApproval}`);
    console.log(`   ⚠️ Skipped (no account): ${result.skippedNoAccount}`);

    if (result.errors.length > 0) {
      console.warn(`   ❌ Errors: ${result.errors.length}`);
      result.errors.forEach((error, index) => {
        console.warn(`      ${index + 1}. ${error}`);
      });
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Batch creation failed:", errorMessage);
    result.errors.push(`Job failed: ${errorMessage}`);
    result.success = false;
  }

  return result;
}

/**
 * Org-side payout batch creation (#713-2 / #700 LED-4).
 *
 * Walks every canHost org with READY OrganizationEarnings older than the
 * cycle window and calls the org-payout-service to roll them into one
 * OrganizationPayout per org. Idempotent via a SHA-256-derived key from
 * (orgId, periodStart) — re-running the cron in the same window is a
 * no-op. Errors against a single org do not abort the rest of the run.
 *
 * Period semantics: the cron is weekly-Monday; the natural window is
 * "everything in the prior 7 days". Callers may pass an explicit
 * (periodStart, periodEnd); default is now()-7d → now().
 */
export interface OrgBatchResult {
  success: boolean;
  orgsScanned: number;
  payoutsCreated: number;
  payoutsAlreadyExisted: number;
  totalAmount: number;
  skippedNotEligible: number;
  errors: string[];
}

export async function createOrgPayoutBatches(opts?: {
  periodStart?: Date;
  periodEnd?: Date;
}): Promise<OrgBatchResult> {
  const periodEnd = opts?.periodEnd ?? new Date();
  const periodStart =
    opts?.periodStart ??
    new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

  const result: OrgBatchResult = {
    success: false,
    orgsScanned: 0,
    payoutsCreated: 0,
    payoutsAlreadyExisted: 0,
    totalAmount: 0,
    skippedNotEligible: 0,
    errors: [],
  };

  // Eligible = canHost orgs with at least one unbatched READY earning in
  // the window. groupBy is cheaper than scanning every canHost org and
  // probing each.
  const eligible = await prisma.organizationEarnings.groupBy({
    by: ["organizationId"],
    where: {
      status: EarningStatus.READY,
      orgPayoutId: null,
      createdAt: { gte: periodStart, lt: periodEnd },
    },
    _count: true,
  });
  result.orgsScanned = eligible.length;

  for (const row of eligible) {
    const orgId = row.organizationId;

    // Per-org maintenance gate. The platform-wide check ran at job
    // entry via `abortIfMaintenance`; this one skips a single tenant
    // during a planned tenant-scoped downtime so the other orgs in the
    // batch still get paid. Only OFFLINE blocks payouts — DEGRADED
    // implies read-only product surfaces, not paused payouts.
    const orgMaint = await getActiveOrgMaintenanceWindow(orgId);
    if (orgMaint && orgMaint.phase === "OFFLINE") {
      result.skippedNotEligible++;
      result.errors.push(
        `${orgId}: org-specific OFFLINE maintenance active (${orgMaint.reason ?? "no reason"}); skipped`,
      );
      continue;
    }

    // Deterministic per-(org, periodStart) key — re-running the cron in
    // the same window is a no-op via the unique constraint.
    const idempotencyKey = createHash("sha256")
      .update(`${orgId}:${periodStart.toISOString()}`)
      .digest("hex");

    try {
      const out = await createOrgPayoutBatch(orgId, periodStart, periodEnd, {
        idempotencyKey,
        notes: `Weekly cron batch ${periodStart.toISOString()} → ${periodEnd.toISOString()}`,
      });
      if (out.alreadyExisted) {
        result.payoutsAlreadyExisted++;
      } else {
        result.payoutsCreated++;
        result.totalAmount += out.amountPaise;
      }
    } catch (err) {
      if (err instanceof PayoutLockError) {
        // Another worker holds the lock; safe to skip — they'll
        // produce the same payout we would have.
        result.errors.push(`${orgId}: payout lock held; skipped`);
        continue;
      }
      if (err instanceof PayoutValidationError) {
        // 4xx semantics — eligibility check failed (no account, refunds
        // exceed earnings, etc.). Not an error worth aborting the run.
        result.skippedNotEligible++;
        result.errors.push(`${orgId}: ${err.message}`);
        continue;
      }
      // Anything else is a real error; record but continue with the
      // remaining orgs.
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`${orgId}: ${message}`);
    }
  }

  result.success = true;
  return result;
}

/**
 * Get statistics about pending payouts
 */
export async function getPayoutStats(): Promise<{
  pending: { count: number; amount: number };
  approved: { count: number; amount: number };
  processing: { count: number; amount: number };
  completed: { count: number; amount: number };
}> {
  const [pending, approved, processing, completed] = await Promise.all([
    prisma.consultantPayout.aggregate({
      where: { status: PayoutStatus.PENDING },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.consultantPayout.aggregate({
      where: { status: PayoutStatus.APPROVED },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.consultantPayout.aggregate({
      where: { status: PayoutStatus.PROCESSING },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.consultantPayout.aggregate({
      where: { status: PayoutStatus.COMPLETED },
      _sum: { amount: true },
      _count: true,
    }),
  ]);

  return {
    pending: { count: pending._count, amount: sumPaise(pending._sum.amount) },
    approved: {
      count: approved._count,
      amount: sumPaise(approved._sum.amount),
    },
    processing: {
      count: processing._count,
      amount: sumPaise(processing._sum.amount),
    },
    completed: {
      count: completed._count,
      amount: sumPaise(completed._sum.amount),
    },
  };
}

/**
 * Run the batch creation task
 */
export async function runBatchCreationTask(): Promise<BatchResult> {
  const startTime = Date.now();
  console.log(
    `🚀 Starting payout batch creation at ${new Date().toISOString()}`,
  );

  try {
    // Get pre-batch stats
    const preStats = await getPayoutStats();
    console.log(`\n📊 Pre-batch Stats:`);
    console.log(
      `   ⏳ Pending: ${preStats.pending.count} (₹${(preStats.pending.amount / 100).toFixed(2)})`,
    );
    console.log(
      `   ✅ Approved: ${preStats.approved.count} (₹${(preStats.approved.amount / 100).toFixed(2)})`,
    );

    // Create batch
    const result = await createPayoutBatch();

    // Org-side batches: independent pass for canHost orgs. Errors on
    // either side don't abort the other — the consultant flow is the
    // primary v1 path and must keep running even if the org pipeline
    // surfaces an issue.
    try {
      const orgBatch = await createOrgPayoutBatches();
      console.log(`\n🏢 Org Payout Batch:`);
      console.log(`   Orgs scanned: ${orgBatch.orgsScanned}`);
      console.log(`   Created: ${orgBatch.payoutsCreated}`);
      console.log(
        `   Already existed (idempotent): ${orgBatch.payoutsAlreadyExisted}`,
      );
      console.log(`   Skipped (ineligible): ${orgBatch.skippedNotEligible}`);
      console.log(
        `   Total amount: ₹${(orgBatch.totalAmount / 100).toFixed(2)}`,
      );
      if (orgBatch.errors.length > 0) {
        console.warn(`   ⚠️ Org batch issues (non-fatal):`);
        orgBatch.errors.forEach((e) => console.warn(`      - ${e}`));
      }
    } catch (err) {
      console.error(
        "❌ Org payout batch creation threw — consultant batch was unaffected:",
        err,
      );
    }

    // Get post-batch stats
    const postStats = await getPayoutStats();
    console.log(`\n📊 Post-batch Stats:`);
    console.log(
      `   ⏳ Pending: ${postStats.pending.count} (₹${(postStats.pending.amount / 100).toFixed(2)})`,
    );
    console.log(
      `   ✅ Approved: ${postStats.approved.count} (₹${(postStats.approved.amount / 100).toFixed(2)})`,
    );

    const duration = (Date.now() - startTime) / 1000;
    console.log(`\n⏱️ Job completed in ${duration.toFixed(2)} seconds`);

    return result;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Disconnect from the database
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

// Run the batch creation if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runBatchCreationTask()
    .then((result) => {
      if (result.success) {
        console.log("🎉 Payout batch creation completed successfully");
        process.exit(0);
      } else {
        console.error("❌ Payout batch creation completed with errors");
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error("💥 Payout batch creation failed:", error);
      process.exit(1);
    });
}
