"use server";

/**
 * Post-Recovery Automation — called when ending maintenance mode.
 *
 * Verifies critical systems are operational:
 * - Database connectivity
 * - Redis connectivity
 * - Sends "we're back" broadcast notification
 */

import * as Sentry from "@sentry/nextjs";
import { notifyMaintenanceEnded } from "@/lib/novu/service";
import prisma from "@/lib/prisma";
import { checkRedisHealth } from "@/lib/redis";
import { restoreDiscountCodes } from "@/actions/maintenance/pause-discount-codes";
import { reconcilePaymentStatus } from "@/scripts/payments/reconcile-payment-status";
import { reconcilePendingRefunds } from "@/scripts/refunds/reconcile-pending-refunds";
import { reconcileDisputes } from "@/scripts/disputes/reconcile-disputes";
import { reconcilePayoutStatus } from "@/scripts/payouts/reconcile-payout-status";
import { reconcileSlotAvailability } from "@/scripts/appointments/reconcile-slot-availability";
import { reconcileDocumentStorage } from "@/scripts/cleanup/reconcile-document-storage";

interface RecoveryResult {
  database: boolean;
  redis: boolean;
  notification: boolean;
  reconciliation?: { job: string; success: boolean }[];
  errors: string[];
}

export async function runPostRecovery(): Promise<RecoveryResult> {
  const result: RecoveryResult = {
    database: false,
    redis: false,
    notification: false,
    errors: [],
  };

  // 1. Verify DB connectivity
  try {
    await prisma.$queryRaw`SELECT 1`;
    result.database = true;
  } catch (error) {
    Sentry.logger.warn("Post-recovery DB health check failed", { tags: { subsystem: "maintenance" } });
    result.errors.push(
      `Database: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 2. Check Redis health (independent of DB, runs in parallel with DB-dependent steps)
  const redisCheckPromise = (async () => {
    try {
      result.redis = await checkRedisHealth();
      if (!result.redis) {
        result.errors.push("Redis: PING failed");
      }
    } catch (error) {
      Sentry.logger.warn("Post-recovery Redis health check failed", { tags: { subsystem: "maintenance" } });
      result.errors.push(
        `Redis: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();

  // 3. Restore discount codes that were paused before maintenance
  if (result.database) {
    try {
      const discountResult = await restoreDiscountCodes();
      console.log(
        JSON.stringify({
          event: "maintenance_discount_codes_restored_in_recovery",
          ...discountResult,
          timestamp: new Date().toISOString(),
        }),
      );
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "maintenance" } });
      result.errors.push(
        `Discount restore: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // 4. Run reconciliation jobs to catch anything that drifted during maintenance
  if (result.database) {
    const JOB_NAMES = [
      "reconcile-payment-status",
      "reconcile-pending-refunds",
      "reconcile-disputes",
      "reconcile-payout-status",
      "reconcile-slot-availability",
      "reconcile-document-storage",
    ];
    const reconciliationRuns = await Promise.allSettled([
      reconcilePaymentStatus(),
      reconcilePendingRefunds(),
      reconcileDisputes(),
      reconcilePayoutStatus(),
      reconcileSlotAvailability(),
      reconcileDocumentStorage(),
    ]);
    result.reconciliation = reconciliationRuns.map((r, i) => ({
      job: JOB_NAMES[i],
      success:
        r.status === "fulfilled" &&
        (r.value as { success?: boolean })?.success === true,
    }));
    reconciliationRuns.forEach((r, i) => {
      if (r.status === "rejected") {
        Sentry.captureException(r.reason instanceof Error ? r.reason : new Error(String(r.reason)), { tags: { subsystem: "maintenance" }, extra: { job: JOB_NAMES[i] } });
        result.errors.push(`${JOB_NAMES[i]}: ${String(r.reason)}`);
      }
    });
  }

  // 5. Ensure Redis check completes before proceeding
  await redisCheckPromise;

  // 6. Send "we're back" broadcast notification
  try {
    const notifResult = await notifyMaintenanceEnded({
      phase: "OFF",
      reason: "Maintenance completed",
    });
    result.notification = notifResult.success;
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "maintenance" }, level: "warning" });
    result.errors.push(
      `Notification: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  console.log(
    JSON.stringify({
      event: "maintenance_post_recovery",
      result,
      timestamp: new Date().toISOString(),
    }),
  );

  return result;
}
