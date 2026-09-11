"use server";

/**
 * Discount Code Pause/Restore — companion to maintenance freeze/recovery.
 *
 * Before OFFLINE: snapshots active discount code IDs to Redis, deactivates all.
 * After recovery: restores active state from snapshot, skipping codes that
 * expired during maintenance.
 */

import * as Sentry from "@sentry/nextjs";

import prisma from "@/lib/prisma";
import redis from "@/lib/redis";

const REDIS_KEY = "maintenance:discount_snapshot";

interface PauseResult {
  paused: number;
}

interface RestoreResult {
  restored: number;
  expiredDuringMaintenance: number;
}

/**
 * Snapshot active discount codes to Redis and deactivate them.
 */
export async function pauseDiscountCodes(): Promise<PauseResult> {
  const activeCodes = await prisma.discountCode.findMany({
    where: { isActive: true },
    select: { id: true },
  });

  if (activeCodes.length === 0) {
    return { paused: 0 };
  }

  const ids = activeCodes.map((c) => c.id);

  // Store snapshot in Redis before deactivating
  await redis.set(REDIS_KEY, JSON.stringify(ids));

  // Bulk deactivate
  const { count } = await prisma.discountCode.updateMany({
    where: { id: { in: ids } },
    data: { isActive: false },
  });

  console.log(
    JSON.stringify({
      event: "maintenance_discount_codes_paused",
      paused: count,
      timestamp: new Date().toISOString(),
    }),
  );

  return { paused: count };
}

/**
 * Restore discount codes from Redis snapshot after maintenance ends.
 * Codes that expired during maintenance are skipped.
 */
export async function restoreDiscountCodes(): Promise<RestoreResult> {
  const raw = await redis.get<string>(REDIS_KEY);
  if (!raw) {
    return { restored: 0, expiredDuringMaintenance: 0 };
  }

  let ids: string[];
  try {
    ids = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "maintenance" } });
    await redis.del(REDIS_KEY);
    return { restored: 0, expiredDuringMaintenance: 0 };
  }

  if (!Array.isArray(ids) || ids.length === 0) {
    await redis.del(REDIS_KEY);
    return { restored: 0, expiredDuringMaintenance: 0 };
  }

  const now = new Date();

  // Find codes that expired during maintenance
  const expiredCodes = await prisma.discountCode.findMany({
    where: {
      id: { in: ids },
      expiresAt: { lt: now, not: null },
    },
    select: { id: true },
  });
  const expiredIds = new Set(expiredCodes.map((c) => c.id));

  // Re-activate codes that haven't expired
  const validIds = ids.filter((id) => !expiredIds.has(id));

  let restored = 0;
  if (validIds.length > 0) {
    const { count } = await prisma.discountCode.updateMany({
      where: { id: { in: validIds } },
      data: { isActive: true },
    });
    restored = count;
  }

  // Clean up Redis snapshot
  await redis.del(REDIS_KEY);

  console.log(
    JSON.stringify({
      event: "maintenance_discount_codes_restored",
      restored,
      expiredDuringMaintenance: expiredIds.size,
      timestamp: new Date().toISOString(),
    }),
  );

  return { restored, expiredDuringMaintenance: expiredIds.size };
}
