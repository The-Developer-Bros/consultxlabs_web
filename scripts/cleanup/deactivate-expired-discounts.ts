/**
 * Deactivate Expired Discounts - Core Logic
 *
 * Deactivates discount codes that have expired or reached max usage.
 * - Codes past their expiresAt date
 * - Codes that have reached maxUses limit
 *
 * This ensures:
 * - Expired promotions are automatically disabled
 * - Max usage limits are enforced
 * - Clean discount code management
 *
 * This module exports the core deactivation function.
 * It is imported by:
 * - jobs/deactivate-expired-discounts.ts (GitHub Actions)
 * - app/api/cleanup/deactivate-expired-discounts/route.ts (API endpoint)
 *
 * Schedule: Daily at midnight
 */

import prisma from "../../lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";

export interface ExpiredDiscountsResult {
  success: boolean;
  expiredByDateCount: number;
  maxUsesReachedCount: number;
  totalDeactivated: number;
  deactivatedCodes: string[];
  errors: string[];
  timestamp: string;
}

/**
 * Deactivate discount codes that have expired by date
 */
async function deactivateExpiredByDate(): Promise<{
  count: number;
  codes: string[];
  errors: string[];
}> {
  const errors: string[] = [];
  const codes: string[] = [];

  console.log("🔍 Finding discount codes past expiration date...");

  try {
    const now = new Date();

    // Find active codes with expiresAt in the past
    const expiredCodes = await prisma.discountCode.findMany({
      where: {
        isActive: true,
        expiresAt: {
          lt: now,
          not: null,
        },
      },
      select: {
        id: true,
        code: true,
        description: true,
        expiresAt: true,
      },
    });

    console.log(`   Found ${expiredCodes.length} expired codes`);

    for (const code of expiredCodes) {
      console.log(`\n   Deactivating: ${code.code}`);
      console.log(`      Description: ${code.description}`);
      console.log(`      Expired: ${code.expiresAt?.toISOString()}`);
      codes.push(code.code);
    }

    if (expiredCodes.length > 0) {
      // Bulk deactivate
      const result = await prisma.discountCode.updateMany({
        where: {
          isActive: true,
          expiresAt: {
            lt: now,
            not: null,
          },
        },
        data: { isActive: false },
      });

      console.log(`\n   ✅ Deactivated ${result.count} expired codes`);
      return { count: result.count, codes, errors };
    }

    return { count: 0, codes, errors };
  } catch (error) {
    const msg = `Failed to deactivate expired codes: ${error}`;
    console.error(`   ❌ ${msg}`);
    errors.push(msg);
    return { count: 0, codes, errors };
  }
}

/**
 * Deactivate discount codes that have reached max uses
 */
async function deactivateMaxUsesReached(): Promise<{
  count: number;
  codes: string[];
  errors: string[];
}> {
  const errors: string[] = [];
  const codes: string[] = [];

  console.log("\n🔍 Finding discount codes that have reached max uses...");

  try {
    // Find active codes where currentUses >= maxUses
    const maxedCodes = await prisma.discountCode.findMany({
      where: {
        isActive: true,
        maxUses: { not: null },
      },
      select: {
        id: true,
        code: true,
        description: true,
        maxUses: true,
        currentUses: true,
      },
    });

    // Filter in memory since Prisma doesn't support field comparison
    const codesToDeactivate = maxedCodes.filter(
      (c) => c.maxUses !== null && c.currentUses >= c.maxUses,
    );

    console.log(`   Found ${codesToDeactivate.length} codes at max uses`);

    for (const code of codesToDeactivate) {
      console.log(`\n   Deactivating: ${code.code}`);
      console.log(`      Description: ${code.description}`);
      console.log(`      Usage: ${code.currentUses}/${code.maxUses}`);
      codes.push(code.code);
    }

    if (codesToDeactivate.length > 0) {
      // Deactivate individually since we filtered in memory
      const idsToDeactivate = codesToDeactivate.map((c) => c.id);

      const result = await prisma.discountCode.updateMany({
        where: {
          id: { in: idsToDeactivate },
        },
        data: { isActive: false },
      });

      console.log(`\n   ✅ Deactivated ${result.count} maxed-out codes`);
      return { count: result.count, codes, errors };
    }

    return { count: 0, codes, errors };
  } catch (error) {
    const msg = `Failed to deactivate maxed-out codes: ${error}`;
    console.error(`   ❌ ${msg}`);
    errors.push(msg);
    return { count: 0, codes, errors };
  }
}

/**
 * Main function to deactivate expired discount codes
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
export async function deactivateExpiredDiscounts(): Promise<ExpiredDiscountsResult> {
  return withCronLock("deactivate-expired-discounts", { failMode: "open" }, () =>
    deactivateExpiredDiscountsUnlocked(),
  );
}

async function deactivateExpiredDiscountsUnlocked(): Promise<ExpiredDiscountsResult> {
  const allErrors: string[] = [];
  const allCodes: string[] = [];

  console.log("🏷️ Starting expired discount code deactivation...");

  // Get current stats
  const activeCount = await prisma.discountCode.count({
    where: { isActive: true },
  });
  const totalCount = await prisma.discountCode.count();
  console.log(`   Active codes: ${activeCount}/${totalCount}`);

  // Deactivate expired by date
  const expiredResult = await deactivateExpiredByDate();
  allErrors.push(...expiredResult.errors);
  allCodes.push(...expiredResult.codes);

  // Deactivate max uses reached
  const maxUsesResult = await deactivateMaxUsesReached();
  allErrors.push(...maxUsesResult.errors);
  allCodes.push(...maxUsesResult.codes);

  const totalDeactivated = expiredResult.count + maxUsesResult.count;

  // Summary
  console.log("\n📊 Expired Discount Codes Summary:");
  console.log(`   Expired by date: ${expiredResult.count}`);
  console.log(`   Max uses reached: ${maxUsesResult.count}`);
  console.log(`   Total deactivated: ${totalDeactivated}`);

  if (allCodes.length > 0) {
    console.log("\n   Deactivated codes:");
    allCodes.forEach((c) => console.log(`      - ${c}`));
  }

  return {
    success: allErrors.length === 0,
    expiredByDateCount: expiredResult.count,
    maxUsesReachedCount: maxUsesResult.count,
    totalDeactivated,
    deactivatedCodes: allCodes,
    errors: allErrors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
