#!/usr/bin/env node

/**
 * Release Earnings Script
 *
 * Releases both consultant AND host-organization earnings from their hold
 * period to READY status. Earnings are held for a period after payment so a
 * refund or dispute lands before the money is payable.
 *
 * #1471 — the organization arm used to be missing here, and because every
 * scheduled entry point (the GitHub Actions job, the cleanup HTTP twin, the
 * admin system-jobs runner) imports THIS module, `OrganizationEarnings` rows
 * never left PENDING and a host org's retained share could never be picked up
 * by `createOrgPayoutBatch`, which only selects READY rows.
 *
 * This module exports functions that can be used by:
 * - Local development: `npm run scripts:release-earnings`
 * - GitHub Actions: `jobs/release-earnings.ts`
 * - API routes: Can import and call functions directly
 *
 * Schedule: Runs hourly via GitHub Actions
 */

import { EarningStatus, Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { sumPaise } from "@/lib/payments/utils/money";
import { withCronLock } from "@/lib/cron/with-cron-lock";

/**
 * Result structure for release operations
 */
export interface ReleaseResult {
  success: boolean;
  /** Consultant earnings moved PENDING → READY. Unchanged in meaning (#1471). */
  releasedCount: number;
  /**
   * #1471 — host-organization earnings moved PENDING → READY. A separate
   * field rather than a widened `releasedCount`, so every existing consumer
   * (GitHub Actions outputs, the cleanup summary, the admin runner) keeps
   * reporting the number it always reported.
   */
  organizationEarningsReleased: number;
  errorCount: number;
  errors: string[];
}

export interface ReleaseEarningsOptions {
  /** #1356 — caps the batch for the Netlify ticker; undefined releases the
   * whole PENDING/past-hold set, as today.
   *
   * #1471 — the cap applies to EACH table independently, matching the #1390
   * decision for the ticker: a run bounded at 200 may release up to 200
   * consultant rows and up to 200 organization rows. */
  limit?: number;
}

/**
 * Release earnings that have passed their hold period
 *
 * Finds earnings with:
 * - Status: PENDING
 * - holdUntil: Past current time
 *
 * Updates them to READY status for payout processing.
 *
 * @returns ReleaseResult with counts and error details
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function releaseEarningsFromHold(
  opts: ReleaseEarningsOptions = {},
): Promise<ReleaseResult> {
  return withCronLock("release-earnings", { failMode: "closed" }, () =>
    releaseEarningsFromHoldUnlocked(opts),
  );
}

async function releaseEarningsFromHoldUnlocked(
  opts: ReleaseEarningsOptions = {},
): Promise<ReleaseResult> {
  console.log("💰 Starting earnings release from hold...");

  const result: ReleaseResult = {
    success: false,
    releasedCount: 0,
    organizationEarningsReleased: 0,
    errorCount: 0,
    errors: [],
  };

  try {
    const now = new Date();

    // #776 — read the snapshot and claim the rows inside one Serializable tx so an
    // overlapping cron run can't observe the same PENDING set and double-count the
    // release in logs/metrics. The updateMany predicate is the real money guard
    // (already-READY rows are skipped); the transaction keeps the logged snapshot
    // equal to what was actually transitioned. A serialization conflict aborts this
    // run; the next hourly run reaps the rows.
    //
    // #1356 — the read is capped with `take: opts.limit` for the Netlify
    // ticker, so the claim below updates by the same id set the read
    // returned rather than repeating the open-ended predicate; otherwise a
    // capped read would under-report a release that actually touched every
    // matching row.
    const { earningsToRelease, releasedCount } = await prisma.$transaction(
      async (tx) => {
        const rows = await tx.consultantEarnings.findMany({
          where: {
            status: EarningStatus.PENDING,
            holdUntil: { lte: now },
          },
          include: {
            consultantProfile: {
              include: {
                user: { select: { name: true, email: true } },
              },
            },
            payment: { select: { id: true, amount: true } },
          },
          take: opts.limit,
        });

        const updated = await tx.consultantEarnings.updateMany({
          where: {
            id: { in: rows.map((r) => r.id) },
            status: EarningStatus.PENDING,
          },
          data: {
            status: EarningStatus.READY,
          },
        });

        return { earningsToRelease: rows, releasedCount: updated.count };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 15_000,
      },
    );

    console.log(
      `📊 Found ${earningsToRelease.length} consultant earnings ready for release`,
    );
    result.releasedCount = releasedCount;

    for (const earning of earningsToRelease) {
      console.log(
        `✅ Released consultant earning ${earning.id}: ₹${(earning.consultantSharePaise / 100).toFixed(2)} for ${earning.consultantProfile.user.name || "Unknown"}`,
      );
    }

    // #1471 — the host-organization arm, deliberately a SEPARATE Serializable
    // transaction rather than a widened one. The two tables share nothing but
    // the predicate, and a serialization conflict on one should not throw away
    // a release the other already claimed. The `limit` is applied again here so
    // each table gets its own full budget (#1390).
    const { orgEarningsToRelease, orgReleasedCount } =
      await prisma.$transaction(
        async (tx) => {
          const rows = await tx.organizationEarnings.findMany({
            where: {
              status: EarningStatus.PENDING,
              holdUntil: { lte: now },
            },
            select: {
              id: true,
              orgSharePaise: true,
              organization: { select: { name: true } },
            },
            orderBy: { holdUntil: "asc" },
            take: opts.limit,
          });

          // CAS-in-WHERE: `status: PENDING` is re-stated on the claim so a row
          // another writer moved (a dispute freeze, a refund cascade) between
          // the read and the update is skipped rather than dragged to READY.
          const updated = await tx.organizationEarnings.updateMany({
            where: {
              id: { in: rows.map((r) => r.id) },
              status: EarningStatus.PENDING,
            },
            data: {
              status: EarningStatus.READY,
            },
          });

          return {
            orgEarningsToRelease: rows,
            orgReleasedCount: updated.count,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 15_000,
        },
      );

    console.log(
      `📊 Found ${orgEarningsToRelease.length} organization earnings ready for release`,
    );
    result.organizationEarningsReleased = orgReleasedCount;

    for (const earning of orgEarningsToRelease) {
      console.log(
        `✅ Released organization earning ${earning.id}: ₹${(earning.orgSharePaise / 100).toFixed(2)} for ${earning.organization.name}`,
      );
    }

    result.success = true;

    // Summary
    console.log(`\n📈 Release Summary:`);
    console.log(`   ✅ Released: ${result.releasedCount} consultant earnings`);
    console.log(
      `   💰 Consultant total: ₹${(earningsToRelease.reduce((sum, e) => sum + e.consultantSharePaise, 0) / 100).toFixed(2)}`,
    );
    console.log(
      `   ✅ Released: ${result.organizationEarningsReleased} organization earnings`,
    );
    console.log(
      `   💰 Organization total: ₹${(orgEarningsToRelease.reduce((sum, e) => sum + e.orgSharePaise, 0) / 100).toFixed(2)}`,
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Release job failed:", errorMessage);
    result.errors.push(`Job failed: ${errorMessage}`);
    result.success = false;
    result.errorCount++;
  }

  return result;
}

/**
 * Get statistics about pending earnings
 */
export async function getPendingEarningsStats(): Promise<{
  pendingCount: number;
  pendingAmount: number;
  readyCount: number;
  readyAmount: number;
}> {
  const [pending, ready] = await Promise.all([
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.PENDING },
      _sum: { consultantSharePaise: true },
      _count: true,
    }),
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.READY },
      _sum: { consultantSharePaise: true },
      _count: true,
    }),
  ]);

  return {
    pendingCount: pending._count,
    pendingAmount: sumPaise(pending._sum.consultantSharePaise),
    readyCount: ready._count,
    readyAmount: sumPaise(ready._sum.consultantSharePaise),
  };
}

/**
 * Run the release task and print stats
 */
export async function runReleaseTask(): Promise<ReleaseResult> {
  const startTime = Date.now();
  console.log(
    `🚀 Starting earnings release job at ${new Date().toISOString()}`,
  );

  try {
    // Get pre-release stats
    const preStats = await getPendingEarningsStats();
    console.log(`\n📊 Pre-release Stats:`);
    console.log(
      `   ⏳ Pending: ${preStats.pendingCount} earnings (₹${(preStats.pendingAmount / 100).toFixed(2)})`,
    );
    console.log(
      `   ✅ Ready: ${preStats.readyCount} earnings (₹${(preStats.readyAmount / 100).toFixed(2)})`,
    );

    // Run release
    const result = await releaseEarningsFromHold();

    // Get post-release stats
    const postStats = await getPendingEarningsStats();
    console.log(`\n📊 Post-release Stats:`);
    console.log(
      `   ⏳ Pending: ${postStats.pendingCount} earnings (₹${(postStats.pendingAmount / 100).toFixed(2)})`,
    );
    console.log(
      `   ✅ Ready: ${postStats.readyCount} earnings (₹${(postStats.readyAmount / 100).toFixed(2)})`,
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

// Run the release if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runReleaseTask()
    .then((result) => {
      if (result.success) {
        console.log("🎉 Earnings release job completed successfully");
        process.exit(0);
      } else {
        console.error("❌ Earnings release job completed with errors");
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error("💥 Earnings release job failed:", error);
      process.exit(1);
    });
}
