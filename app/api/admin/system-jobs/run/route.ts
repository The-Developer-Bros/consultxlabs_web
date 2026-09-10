/**
 * System Jobs API - Secure Wrapper
 *
 * Provides authenticated access to system jobs for Admin users only.
 * This wrapper verifies user session server-side and calls cleanup routes internally.
 *
 * NO CRON_SECRET is exposed to the frontend.
 * Uses session-based authentication instead.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";

// Import job functions directly - organized by category
// Payments
import {
  cleanupAbandonedPayments,
  cleanupExpiredApprovalPendingPayments,
} from "@/scripts/payments/cleanup-abandoned-payments";
import { reconcilePaymentStatus } from "@/scripts/payments/reconcile-payment-status";

// Refunds
import { reconcilePendingRefunds } from "@/scripts/refunds/reconcile-pending-refunds";
import { cascadeRefundToEarnings } from "@/scripts/refunds/cascade-refund-earnings";

// Disputes
import { reconcileDisputes } from "@/scripts/disputes/reconcile-disputes";
import { handleLostDisputes } from "@/scripts/disputes/handle-lost-disputes";
import { alertDisputeDeadlines } from "@/scripts/disputes/alert-dispute-deadlines";

// Earnings
import { syncPaymentEarnings } from "@/scripts/earnings/sync-payment-earnings";
import { releaseEarningsFromHold } from "@/scripts/earnings/release-earnings";

// Appointments
import { runAllCleanupTasks as cleanupInvalidAppointments } from "@/scripts/appointments/cleanup-invalid-appointments";
import { autoCompleteAppointments } from "@/scripts/appointments/auto-complete-appointments";
import { cleanupStalePendingConsultations } from "@/scripts/appointments/cleanup-stale-pending-consultations";
import { expireStaleRequests } from "@/scripts/appointments/expire-stale-requests";
import { cleanupTentativeSlots } from "@/scripts/appointments/cleanup-tentative-slots";
import { reconcileSlotAvailability } from "@/scripts/appointments/reconcile-slot-availability";

// Payouts — FIX #620: Use canonical service for batch/process (has distributed locking).
// Keep handleStuckPayouts and reconcilePayoutStatus from scripts (no canonical lib equivalent yet).
import {
  createPayoutBatch as createPayoutBatchService,
  processApprovedPayouts as processApprovedPayoutsService,
} from "@/lib/payments/payouts";
import { handleStuckPayouts } from "@/scripts/payouts/handle-stuck-payouts";
import { reconcilePayoutStatus } from "@/scripts/payouts/reconcile-payout-status";

// Cleanup
import { cleanupAuthTokens } from "@/scripts/cleanup/cleanup-auth-tokens";
import { archiveWebhookEvents } from "@/scripts/cleanup/archive-webhook-events";
import { deactivateExpiredDiscounts } from "@/scripts/cleanup/deactivate-expired-discounts";
import { reconcileDocumentStorage } from "@/scripts/cleanup/reconcile-document-storage";

// Alerts
import { alertOrphanedPayments } from "@/scripts/alerts/alert-orphaned-payments";

// Stream — #1270. Six scheduled Stream jobs existed and not one of them was
// reachable from any operator surface: this map could execute twenty-five jobs
// and the staff catalogue listed nine, and no Stream job appeared in either.
// When recordings stop transferring or event channels stop expiring, the only
// way to run the repair was to dispatch a GitHub workflow.
import { performStreamUserSync } from "@/scripts/stream/stream-sync";
import { cleanupOldStreamRecordings } from "@/scripts/cleanup/cleanup-old-stream-recordings";
import { reconcileOrphanedRecordings } from "@/scripts/stream/reconcile-orphaned-recordings";
import { RecordingTransferService } from "@/lib/stream/recording-transfer-service";
import { expireEventChannels } from "@/jobs/stream/expire-event-channels";
import { reconcileOrphanedSessions } from "@/jobs/meetings/reconcile-orphaned-sessions";
import { withCronLock } from "@/lib/cron/with-cron-lock";

import { requireAdminAuth } from "@/lib/auth-helpers";
import { getMaintenanceState } from "@/lib/maintenance-edge";

// Financial job IDs that must not run during DEGRADED maintenance.
// These interact with payment gateways or mutate financial state.
const FINANCIAL_JOB_IDS = new Set([
  "cleanup-abandoned-payments",
  "cleanup-approval-payments",
  "reconcile-refunds",
  "cascade-refund-earnings",
  "handle-lost-disputes",
  "create-payout-batch",
  "process-payouts",
  "handle-stuck-payouts",
  "release-earnings",
  "reconcile-payment-status",
  "reconcile-payout-status",
]);

// Job ID to function mapping
type JobResult = {
  success: boolean;
  [key: string]: unknown;
};

type JobFunction = () => Promise<JobResult>;

const JOB_FUNCTIONS: Record<string, JobFunction> = {
  "cleanup-abandoned-payments": async () => {
    const result = await cleanupAbandonedPayments();
    return {
      success: result.success,
      cleanedCount: result.cleanedCount,
      errorCount: result.errorCount,
    };
  },
  "cleanup-approval-payments": async () => {
    const result = await cleanupExpiredApprovalPendingPayments();
    return {
      success: result.success,
      cleanedCount: result.cleanedCount,
      errorCount: result.errorCount,
    };
  },
  "reconcile-refunds": async () => {
    const result = await reconcilePendingRefunds();
    return {
      success: result.success,
      totalProcessed: result.totalProcessed,
      reconciledCount: result.reconciledCount,
      errorCount: result.failedCount,
    };
  },
  "reconcile-disputes": async () => {
    const result = await reconcileDisputes();
    return {
      success: result.success,
      totalProcessed: result.totalProcessed,
      reconciledCount: result.reconciledCount,
      urgentCount: result.urgentCount,
      errorCount: result.errors.length,
    };
  },
  "handle-lost-disputes": async () => {
    const result = await handleLostDisputes();
    return {
      success: result.success,
      totalProcessed: result.totalProcessed,
      updatedCount: result.updatedCount,
      alreadyPaidCount: result.alreadyPaidCount,
      errorCount: result.errorCount,
    };
  },
  "cascade-refund-earnings": async () => {
    const result = await cascadeRefundToEarnings();
    return {
      success: result.success,
      totalProcessed: result.totalProcessed,
      updatedCount: result.updatedCount,
      errorCount: result.errorCount,
    };
  },
  "sync-payment-earnings": async () => {
    const result = await syncPaymentEarnings();
    return {
      success: result.success,
      totalProcessed: result.totalProcessed,
      createdCount: result.createdCount,
      errorCount: result.errorCount,
    };
  },
  "release-earnings": async () => {
    const result = await releaseEarningsFromHold();
    return {
      success: result.success,
      releasedCount: result.releasedCount,
      // #1471 — the same run now also releases host-org earnings.
      organizationEarningsReleased: result.organizationEarningsReleased,
      errorCount: result.errorCount,
    };
  },
  "cleanup-invalid-appointments": async () => {
    const result = await cleanupInvalidAppointments();
    return {
      success: result.success,
      totalProcessed: result.totalCancelled,
      cleanedCount: result.totalCancelled,
      duplicateConsultations: result.duplicateConsultationsCancelled,
      duplicateSubscriptions: result.duplicateSubscriptionsCancelled,
      invalidDurationConsultations:
        result.invalidDurationConsultationsCancelled,
      invalidDurationSubscriptions:
        result.invalidDurationSubscriptionsCancelled,
      errorCount: result.errors.length,
    };
  },
  "create-payout-batch": async () => {
    const batchId = await createPayoutBatchService();
    return {
      success: true,
      batchId,
    };
  },
  "process-payouts": async () => {
    const results = await processApprovedPayoutsService();
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    return {
      success: failed === 0,
      totalProcessed: results.length,
      succeededCount: succeeded,
      failedCount: failed,
    };
  },
  // New jobs
  "alert-orphaned-payments": async () => {
    const result = await alertOrphanedPayments();
    return {
      success: result.success,
      totalProcessed: result.totalOrphaned,
      orphanedCount: result.totalOrphaned,
      criticalAlerts: result.criticalCount,
      totalAmount: result.totalAmount,
    };
  },
  "handle-stuck-payouts": async () => {
    const result = await handleStuckPayouts();
    return {
      success: result.success,
      totalProcessed: result.totalProcessed,
      reconciledCount: result.reconciledCount,
      retriedCount: result.retriedCount,
      failedCount: result.failedCount,
      errorCount: result.errors.length,
    };
  },
  "auth-tokens": async () => {
    const result = await cleanupAuthTokens();
    return {
      success: result.success,
      totalProcessed: result.totalCleaned,
      cleanedCount: result.totalCleaned,
      verificationTokensDeleted: result.verificationTokensDeleted,
      sessionsDeleted: result.sessionsDeleted,
      passwordResetTokensCleared: result.passwordResetTokensCleared,
    };
  },
  "reconcile-payment-status": async () => {
    const result = await reconcilePaymentStatus();
    return {
      success: result.success,
      totalProcessed: result.totalProcessed,
      reconciledCount: result.reconciledCount,
      succeededCount: result.succeededCount,
      failedCount: result.failedCount,
      errorCount: result.errors.length,
    };
  },
  "reconcile-payout-status": async () => {
    const result = await reconcilePayoutStatus();
    return {
      success: result.success,
      totalProcessed: result.totalProcessed,
      reconciledCount: result.reconciledCount,
      completedCount: result.completedCount,
      failedCount: result.failedCount,
      discrepanciesCount: result.discrepancies.length,
      errorCount: result.errors.length,
    };
  },
  "alert-dispute-deadlines": async () => {
    const result = await alertDisputeDeadlines();
    return {
      success: result.success,
      urgentCount: result.urgentCount,
      criticalCount: result.criticalCount,
      totalAlerts: result.urgentCount,
    };
  },
  "auto-complete-appointments": async () => {
    const result = await autoCompleteAppointments();
    return {
      success: result.success,
      webinarsCompleted: result.webinarsCompleted,
      classesCompleted: result.classesCompleted,
      totalProcessed: result.webinarsCompleted + result.classesCompleted,
      errorCount: result.errors.length,
    };
  },
  "expire-stale-requests": async () => {
    const result = await expireStaleRequests();
    return {
      success: result.success,
      consultationsExpired: result.consultationsExpired,
      subscriptionsExpired: result.subscriptionsExpired,
      paymentPendingExpired: result.paymentPendingExpired,
      totalProcessed:
        result.consultationsExpired +
        result.subscriptionsExpired +
        result.paymentPendingExpired,
      errorCount: result.errors.length,
    };
  },
  "tentative-slots": async () => {
    const result = await cleanupTentativeSlots();
    return {
      success: result.success,
      slotsReleased: result.slotsReleased,
      appointmentsAffected: result.appointmentsAffected,
      cleanedCount: result.slotsReleased,
      errorCount: result.errors.length,
    };
  },
  "stale-pending-consultations": async () => {
    const result = await cleanupStalePendingConsultations();
    return {
      success: result.success,
      consultationsCancelled: result.consultationsCancelled,
      slotsReleased: result.slotsReleased,
      cleanedCount: result.consultationsCancelled,
      errorCount: result.errors.length,
    };
  },
  "archive-webhook-events": async () => {
    const result = await archiveWebhookEvents();
    return {
      success: result.success,
      processedEventsDeleted: result.processedEventsDeleted,
      failedEventsDeleted: result.failedEventsDeleted,
      totalDeleted: result.totalDeleted,
      cleanedCount: result.totalDeleted,
      errorCount: result.errors.length,
    };
  },
  "reconcile-slot-availability": async () => {
    const result = await reconcileSlotAvailability();
    return {
      success: result.success,
      tentativeFlagsCleared: result.tentativeFlagsCleared,
      doubleBookingsDetected: result.doubleBookingsDetected,
      reconciledCount: result.tentativeFlagsCleared,
      errorCount: result.errors.length,
    };
  },
  "reconcile-document-storage": async () => {
    const result = await reconcileDocumentStorage();
    return {
      success: result.success,
      orphanedFilesFound: result.orphanedFilesFound,
      orphanedFilesDeleted: result.orphanedFilesDeleted,
      missingFilesFound: result.missingFilesFound,
      cleanedCount: result.orphanedFilesDeleted,
      errorCount: result.errors.length,
    };
  },
  "deactivate-expired-discounts": async () => {
    const result = await deactivateExpiredDiscounts();
    return {
      success: result.success,
      expiredByDateCount: result.expiredByDateCount,
      maxUsesReachedCount: result.maxUsesReachedCount,
      totalDeactivated: result.totalDeactivated,
      cleanedCount: result.totalDeactivated,
      errorCount: result.errors.length,
    };
  },
  // Stream (#1270). Each of these delegates to the SAME core the scheduled
  // workflow runs, so an operator-triggered run and a cron run cannot diverge.
  "stream-sync": async () => {
    const result = await performStreamUserSync();
    return {
      success: result.success,
      totalProcessed: result.totalStreamUsersProcessed,
      staleIdentified: result.totalStaleUsersIdentified,
      usersDeleted: result.totalStaleUsersDeleted,
      errorCount: result.totalFailedDeletions,
    };
  },
  "mark-expired-recordings": async () => {
    // The lock for this one lives in the workflow entrypoint rather than in a
    // shared core, so the operator path has to take it explicitly — otherwise
    // an admin click during the 03:20 run would race the cron, and neither run
    // would leave a `SystemJobExecution` row for the click.
    const expiredCount = await withCronLock(
      "mark-expired-recordings",
      { failMode: "open" },
      () => RecordingTransferService.markExpiredRecordings(),
    );
    return {
      success: true,
      totalProcessed: expiredCount,
      expiredCount,
    };
  },
  "transfer-expiring-recordings": async () => {
    // Same reasoning as above, and it matters more here: two concurrent runs
    // would upload the same recording to Supabase twice.
    const result = await withCronLock(
      "transfer-expiring-recordings",
      { failMode: "open" },
      () =>
        RecordingTransferService.processExpiringRecordings(
          14,
          10,
          "PERMANENT",
        ),
    );
    return {
      success: result.failed === 0,
      totalProcessed: result.processed,
      succeededCount: result.succeeded,
      failedCount: result.failed,
      errorCount: result.errors.length,
    };
  },
  "cleanup-old-stream-recordings": async () => {
    const result = await cleanupOldStreamRecordings();
    return {
      success: result.success,
      totalProcessed: result.scanned,
      expiredCount: result.expired,
      cleanedCount: result.expired,
      errorCount: result.errors.length,
    };
  },
  "expire-event-channels": async () => {
    const result = await expireEventChannels();
    return {
      success: result.success,
      totalProcessed: result.frozen + result.deleted,
      frozenCount: result.frozen,
      deletedCount: result.deleted,
      skippedAlreadyFrozen: result.skippedAlreadyFrozen,
      errorCount: result.errors.length,
    };
  },
  "reconcile-orphaned-sessions": async () => {
    const result = await reconcileOrphanedSessions();
    return {
      success: result.success,
      totalProcessed: result.processed,
      reconciledCount: result.reconciled,
      streamNotFoundCount: result.streamNotFound,
      errorCount: result.errors,
    };
  },
  "reconcile-orphaned-recordings": async () => {
    const result = await reconcileOrphanedRecordings();
    return {
      success: result.success,
      totalProcessed: result.scanned,
      recoveredCount: result.recovered,
      stillMissingCount: result.stillMissing,
      unrecoverableCount: result.unrecoverable,
      errorCount: result.errors.length,
    };
  },
};

/**
 * POST /api/admin/system-jobs/run
 * Run a system job by ID (requires ADMIN role)
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // 1. Verify admin auth
    const auth = await requireAdminAuth();
    if (auth.error) return auth.error;
    const session = auth.session;
    const user = session.user;

    // 2. Get job ID from body
    const { jobId } = await req.json();

    if (!jobId || typeof jobId !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid jobId" },
        { status: 400 },
      );
    }

    // 4. Find and execute the job
    const jobFunction = JOB_FUNCTIONS[jobId];

    if (!jobFunction) {
      return NextResponse.json(
        { error: `Unknown job ID: ${jobId}` },
        { status: 400 },
      );
    }

    // 5. Check maintenance mode — block financial jobs in DEGRADED
    const maintenanceState = await getMaintenanceState();
    if (maintenanceState.phase === "DEGRADED" && FINANCIAL_JOB_IDS.has(jobId)) {
      return NextResponse.json(
        {
          error: `Job "${jobId}" is blocked during DEGRADED maintenance to protect payment integrity. End maintenance mode first.`,
          phase: "DEGRADED",
        },
        { status: 503 },
      );
    }
    if (maintenanceState.phase === "OFFLINE") {
      return NextResponse.json(
        {
          error: `All system jobs are blocked during OFFLINE maintenance. End maintenance mode first.`,
          phase: "OFFLINE",
        },
        { status: 503 },
      );
    }

    console.log(
      `[System Jobs] ${user.name || user.email} (${user.role}) running job: ${jobId}`,
    );

    // 6. Execute the job
    const result = await jobFunction();

    console.log(`[System Jobs] Job ${jobId} completed:`, {
      success: result.success,
      user: user.email,
    });

    return NextResponse.json(result);
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "admin" } });
    console.error("[System Jobs] Error running job:", error);
    return NextResponse.json(
      {
        error: "Failed to run job",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
