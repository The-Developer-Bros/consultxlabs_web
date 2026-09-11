/**
 * Abandoned Organization Wallet Top-Up Cleanup — Core Logic
 *
 * Reaps pending `WalletTopUp` rows that never received a
 * webhook confirmation within the grace window. These occur when:
 *   - The user closes the Razorpay popup without completing payment.
 *   - The webhook never fires (gateway outage, our webhook endpoint
 *     returning 5xx past retry budget).
 *   - The top-up route created the placeholder but the Razorpay order
 *     failed afterwards and the rollback DELETE didn't commit.
 *
 * Invariant for a pending top-up:
 *   - `status = PENDING` (never confirmed by the webhook)
 *   - `providerPaymentId IS NULL`
 *   - `createdAt < now - GRACE_HOURS`
 *
 * We hard-delete (not soft-delete) because `WalletTopUp.providerOrderId`
 * is `@unique` — leaving a stale row would block a legitimate retry that
 * reuses the same client idempotency key.
 *
 * This module exports the core cleanup function. It is imported by:
 *   - jobs/cleanup/cleanup-abandoned-org-top-ups.ts (GitHub Actions wrapper)
 *   - app/api/cleanup/abandoned-org-top-ups/route.ts (HTTP endpoint)
 *
 * Schedule: Daily at 02:00 UTC (must NOT overlap generate-subscription-invoices at 01:00 UTC)
 */

import prisma from "../../lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";

const DEFAULT_GRACE_HOURS = 6; // gateway retry budget + user completion window

export interface AbandonedOrgTopUpCleanupResult {
  success: boolean;
  reaped: number;
  graceHours: number;
  cutoff: string;
  errors: string[];
  timestamp: string;
}

export interface AbandonedOrgTopUpCleanupOptions {
  /** Override the grace window (hours). Defaults to 6h. */
  graceHours?: number;
}

/**
 * Reap pending wallet top-up placeholders older than the grace window.
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function cleanupAbandonedOrgTopUps(
  options: AbandonedOrgTopUpCleanupOptions = {},
): Promise<AbandonedOrgTopUpCleanupResult> {
  return withCronLock("cleanup-abandoned-org-top-ups", { failMode: "closed" }, () =>
    cleanupAbandonedOrgTopUpsUnlocked(options),
  );
}

async function cleanupAbandonedOrgTopUpsUnlocked(
  options: AbandonedOrgTopUpCleanupOptions = {},
): Promise<AbandonedOrgTopUpCleanupResult> {
  const graceHours = options.graceHours ?? DEFAULT_GRACE_HOURS;
  const cutoff = new Date(Date.now() - graceHours * 60 * 60 * 1000);
  const errors: string[] = [];
  let reaped = 0;

  console.log("🧹 Starting abandoned org wallet top-up cleanup...");
  console.log(`   Cutoff: ${cutoff.toISOString()} (${graceHours}h grace window)`);

  try {
    // Identify candidates first so we can log per-row context for ops.
    const candidates = await prisma.walletTopUp.findMany({
      where: {
        status: "PENDING",
        providerPaymentId: null,
        // #785 — never reap a gateway-captured top-up whose confirm/ledger post
        // rolled back (capturedAt set, still PENDING); the
        // sweep-orphaned-topup-captures reconciler re-credits those.
        capturedAt: null,
        createdAt: { lt: cutoff },
      },
      select: {
        id: true,
        billingAccountId: true,
        providerOrderId: true,
        createdAt: true,
      },
    });

    if (candidates.length === 0) {
      console.log("   No pending top-ups to reap.");
      return {
        success: true,
        reaped: 0,
        graceHours,
        cutoff: cutoff.toISOString(),
        errors,
        timestamp: new Date().toISOString(),
      };
    }

    console.log(`   Found ${candidates.length} candidates to reap.`);

    // Delete in a single statement so the whole batch commits or none.
    // We cannot soft-delete — `providerOrderId @unique` would keep the slot
    // reserved and block a legitimate retry with the same client idempotency key.
    // #776 — re-assert the PENDING/unpaid predicate in the DELETE itself: a
    // webhook can confirm a candidate (PENDING→CONFIRMED, providerPaymentId set,
    // wallet credited + ledger posted) between the findMany and here. Filtering
    // by id alone would then hard-delete a CONFIRMED, paid top-up — losing the
    // org's money with no audit trail (deletion-policy: a confirmed top-up is
    // never reaped).
    const deleted = await prisma.walletTopUp.deleteMany({
      where: {
        id: { in: candidates.map((c) => c.id) },
        status: "PENDING",
        providerPaymentId: null,
        capturedAt: null,
      },
    });
    reaped = deleted.count;

    console.log(
      `   Reaped ${reaped} pending WalletTopUp rows older than ${graceHours}h`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`Cleanup failed: ${message}`);
    console.error(`   Error: ${message}`);
  }

  return {
    success: errors.length === 0,
    reaped,
    graceHours,
    cutoff: cutoff.toISOString(),
    errors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database — call this when running as a CLI/job script.
 * The HTTP route should NOT call this since Next.js manages the connection.
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
