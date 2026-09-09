#!/usr/bin/env node

/**
 * Invalid Appointment Cleanup Script
 *
 * Core library for cleaning up duplicate and invalid appointments.
 *
 * This module exports functions that can be used by:
 * - Local development: `npx tsx scripts/cleanup-invalid-appointments.ts`
 * - GitHub Actions: `jobs/cleanup-invalid-appointments.ts`
 * - API routes: Can import and call functions directly
 *
 * Cleanup Categories:
 * 1. Duplicate consultations (same user + plan + identical slot times + created within 30s)
 * 2. Duplicate subscriptions (overlapping scheduling periods)
 * 3. Invalid duration consultations (slot duration != plan duration)
 * 4. Invalid duration subscriptions (period != plan.durationInMonths)
 *
 * Action: Marks invalid records as CANCELLED (preserves audit trail)
 */

import { AppointmentStatus, SlotCompletionStatus } from "@prisma/client";
import {
  CANCELLABLE_FROM,
  transitionConsultationRequest,
  transitionSlotCompletion,
  transitionSubscriptionRequest,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import prisma from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";

/**
 * #1319 — per request, in one transaction: CAS the request to CANCELLED
 * first, then soft-cancel its slots. Cancelling every candidate's slots on the
 * raw client before the CAS decided left a booking that had moved to a
 * non-cancellable state with its status intact and its slots gone.
 */
async function cancelRequestsAndReleaseSlots(
  kind: "consultation" | "subscription",
  ids: string[],
): Promise<{ cancelled: number; skipped: number; slotsCancelled: number }> {
  const outcome = { cancelled: 0, skipped: 0, slotsCancelled: 0 };
  for (const id of ids) {
    // The counters are the caller's report of what is now true in the database,
    // so they are only moved once the transaction has committed — incrementing
    // them inside the callback would keep counting a rolled-back cancellation.
    const committed = await prisma.$transaction(async (tx) => {
      try {
        if (kind === "consultation") {
          await transitionConsultationRequest(tx, {
            where: { id },
            to: AppointmentStatus.CANCELLED,
            fromIn: CANCELLABLE_FROM,
          });
        } else {
          await transitionSubscriptionRequest(tx, {
            where: { id },
            to: AppointmentStatus.CANCELLED,
            fromIn: CANCELLABLE_FROM,
          });
        }
      } catch (error) {
        if (!(error instanceof IllegalTransitionError)) throw error;
        return { cancelled: false as const, slotsCancelled: 0 };
      }
      const slotsCancelled = await transitionSlotCompletion(tx, {
        where: {
          appointment:
            kind === "consultation"
              ? { consultation: { id } }
              : { subscription: { id } },
          deletedAt: null,
        },
        to: SlotCompletionStatus.CANCELLED,
        data: { deletedAt: new Date() },
        allowZero: true,
      });
      return { cancelled: true as const, slotsCancelled };
    });

    if (!committed.cancelled) {
      outcome.skipped++;
      continue;
    }
    outcome.cancelled++;
    outcome.slotsCancelled += committed.slotsCancelled;
  }
  return outcome;
}

/**
 * Result structure for cleanup operations
 */
export interface CleanupResult {
  duplicateConsultationsCancelled: number;
  duplicateSubscriptionsCancelled: number;
  invalidDurationConsultationsCancelled: number;
  invalidDurationSubscriptionsCancelled: number;
  totalCancelled: number;
  errors: string[];
  success: boolean;
}

// Statuses that should not be cleaned up (already terminal)
const TERMINAL_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.CANCELLED,
  AppointmentStatus.REJECTED,
  AppointmentStatus.EXPIRED,
];

/**
 * Calculate the difference in months between two dates
 */
function monthsDiff(start: Date, end: Date): number {
  return (
    (end.getFullYear() - start.getFullYear()) * 12 +
    (end.getMonth() - start.getMonth())
  );
}

/**
 * Clean up duplicate consultations
 *
 * Finds consultations where:
 * - Same requestedById (user)
 * - Same consultationPlanId (plan)
 * - Exact same slot times (startsAt/endsAt match) AND created within 30 seconds
 *
 * This tightened heuristic avoids cancelling legitimate multiple same-day
 * bookings (e.g., morning and afternoon sessions). Only true race-condition
 * duplicates with identical slot times and near-simultaneous creation are flagged.
 *
 * Keeps the oldest record, cancels the newer duplicates.
 */
export async function cleanupDuplicateConsultations(): Promise<{
  count: number;
  errors: string[];
}> {
  console.log("🔍 Finding duplicate consultations...");

  const errors: string[] = [];
  let cancelledCount = 0;

  // Race window: two consultations must be created within this many ms to be
  // considered duplicates (in addition to having identical slot times).
  const RACE_WINDOW_MS = 30_000; // 30 seconds

  try {
    // Fetch all non-terminal consultations with their slot data
    const consultations = await prisma.consultation.findMany({
      where: { status: { notIn: TERMINAL_STATUSES } },
      select: {
        id: true,
        requestedById: true,
        consultationPlanId: true,
        createdAt: true,
        appointment: {
          select: {
            slotsOfAppointment: {
              select: { startsAt: true, endsAt: true },
              orderBy: { startsAt: "asc" },
            },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    const duplicatesToCancel = new Set<string>();

    // Build a fingerprint for a consultation's slot times so we can compare
    // two consultations for exact slot overlap.
    const slotFingerprint = (
      c: (typeof consultations)[number],
    ): string | null => {
      const slots = c.appointment?.slotsOfAppointment;
      if (!slots || slots.length === 0) return null;
      return slots
        .map((s) => `${s.startsAt.getTime()}-${s.endsAt.getTime()}`)
        .join("|");
    };

    // Group by user + plan for efficient comparison
    const groupedByUserPlan = new Map<string, typeof consultations>();
    for (const c of consultations) {
      const key = `${c.requestedById}-${c.consultationPlanId}`;
      if (!groupedByUserPlan.has(key)) groupedByUserPlan.set(key, []);
      groupedByUserPlan.get(key)!.push(c);
    }

    // Check within each group for duplicates
    groupedByUserPlan.forEach((group) => {
      for (let i = 0; i < group.length; i++) {
        const c1 = group[i];
        const fp1 = slotFingerprint(c1);

        for (let j = i + 1; j < group.length; j++) {
          const c2 = group[j];

          // Since sorted by createdAt, once we exceed the race window we can
          // stop comparing against c1.
          const timeDiff = c2.createdAt.getTime() - c1.createdAt.getTime();
          if (timeDiff >= RACE_WINDOW_MS) break;

          const fp2 = slotFingerprint(c2);

          // Both must have slot data and identical slot fingerprints
          if (fp1 !== null && fp2 !== null && fp1 === fp2) {
            duplicatesToCancel.add(c2.id);
            console.log(
              `  [DUPLICATE] Consultation ${c2.id} is a duplicate of ${c1.id}` +
                ` | user=${c1.requestedById} plan=${c1.consultationPlanId}` +
                ` | created ${timeDiff}ms apart | slots=${fp1}`,
            );
          }
        }
      }
    });

    console.log(`📊 Found ${duplicatesToCancel.size} duplicate consultations`);

    // Batch cancel duplicates and release their slots
    if (duplicatesToCancel.size > 0) {
      const duplicateIds = Array.from(duplicatesToCancel);

      console.log(
        `[AUDIT] About to cancel ${duplicateIds.length} duplicate consultations: ${duplicateIds.join(", ")}`,
      );

      const outcome = await cancelRequestsAndReleaseSlots(
        "consultation",
        duplicateIds,
      );
      cancelledCount = outcome.cancelled;
      console.log(
        `🔓 Cancelled ${outcome.slotsCancelled} slots from duplicate consultations`,
      );
      if (outcome.skipped > 0) {
        console.log(
          `⏭️ ${outcome.skipped} skipped — moved out of a cancellable state since the sweep read`,
        );
      }
      console.log(`✅ Cancelled ${cancelledCount} duplicate consultations`);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    errors.push(`Duplicate consultation cleanup failed: ${errorMessage}`);
    console.error(
      "❌ Failed to cleanup duplicate consultations:",
      errorMessage,
    );
  }

  return { count: cancelledCount, errors };
}

/**
 * Clean up duplicate subscriptions
 *
 * Finds subscriptions where:
 * - Same requestedById (user)
 * - Same subscriptionPlanId (plan)
 * - Overlapping scheduling periods OR within 5 seconds of each other
 *
 * Keeps the oldest record, cancels the newer duplicates.
 */
export async function cleanupDuplicateSubscriptions(): Promise<{
  count: number;
  errors: string[];
}> {
  console.log("🔍 Finding duplicate subscriptions...");

  const errors: string[] = [];
  let cancelledCount = 0;

  try {
    // Fetch all non-terminal subscriptions
    const subscriptions = await prisma.subscription.findMany({
      where: { status: { notIn: TERMINAL_STATUSES } },
      select: {
        id: true,
        requestedById: true,
        subscriptionPlanId: true,
        schedulingPeriodStartsAt: true,
        schedulingPeriodEndsAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    const duplicatesToCancel = new Set<string>();
    const seenByUserPlan = new Map<string, typeof subscriptions>();

    // Group by user + plan
    for (const s of subscriptions) {
      const key = `${s.requestedById}-${s.subscriptionPlanId}`;
      if (!seenByUserPlan.has(key)) seenByUserPlan.set(key, []);
      seenByUserPlan.get(key)!.push(s);
    }

    // Check for overlaps within each group
    seenByUserPlan.forEach((group) => {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const s1 = group[i];
          const s2 = group[j];

          // Check overlap
          const overlaps =
            s1.schedulingPeriodStartsAt < s2.schedulingPeriodEndsAt &&
            s1.schedulingPeriodEndsAt > s2.schedulingPeriodStartsAt;

          // Check within 5 seconds
          const within5s =
            Math.abs(s1.createdAt.getTime() - s2.createdAt.getTime()) < 5000;

          if (overlaps) {
            duplicatesToCancel.add(s2.id); // Cancel newer one
            console.log(
              `  Found overlapping subscription: ${s2.id} (overlaps with: ${s1.id})`,
            );
          } else if (within5s) {
            duplicatesToCancel.add(s2.id); // Cancel newer one
            console.log(
              `  Found exact duplicate (within 5s): ${s2.id} (original: ${s1.id})`,
            );
          }
        }
      }
    });

    console.log(`📊 Found ${duplicatesToCancel.size} duplicate subscriptions`);

    // Batch cancel duplicates and release their slots
    if (duplicatesToCancel.size > 0) {
      const duplicateIds = Array.from(duplicatesToCancel);

      const outcome = await cancelRequestsAndReleaseSlots(
        "subscription",
        duplicateIds,
      );
      cancelledCount = outcome.cancelled;
      console.log(
        `🔓 Cancelled ${outcome.slotsCancelled} slots from duplicate subscriptions`,
      );
      if (outcome.skipped > 0) {
        console.log(
          `⏭️ ${outcome.skipped} skipped — moved out of a cancellable state since the sweep read`,
        );
      }
      console.log(`✅ Cancelled ${cancelledCount} duplicate subscriptions`);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    errors.push(`Duplicate subscription cleanup failed: ${errorMessage}`);
    console.error(
      "❌ Failed to cleanup duplicate subscriptions:",
      errorMessage,
    );
  }

  return { count: cancelledCount, errors };
}

/**
 * Clean up consultations with invalid slot durations
 *
 * Finds consultations where the total slot duration doesn't match
 * the plan's durationInHours (with 1% tolerance for floating point).
 */
export async function cleanupInvalidDurationConsultations(): Promise<{
  count: number;
  errors: string[];
}> {
  console.log("🔍 Finding consultations with invalid slot durations...");

  const errors: string[] = [];
  let cancelledCount = 0;

  try {
    // Fetch consultations with their plan and slots
    const consultations = await prisma.consultation.findMany({
      where: { status: { notIn: TERMINAL_STATUSES } },
      include: {
        consultationPlan: { select: { durationInHours: true } },
        appointment: {
          include: {
            slotsOfAppointment: { select: { startsAt: true, endsAt: true } },
          },
        },
      },
    });

    const invalidIds: string[] = [];

    for (const c of consultations) {
      if (!c.appointment?.slotsOfAppointment?.length) continue;

      const expectedHours = c.consultationPlan.durationInHours;
      // Sum duration of ALL slots (not just the first one)
      const totalSlotMillis = c.appointment.slotsOfAppointment.reduce(
        (total, slot) =>
          total + (slot.endsAt.getTime() - slot.startsAt.getTime()),
        0,
      );
      const actualHours = totalSlotMillis / (1000 * 60 * 60);

      if (Math.abs(expectedHours - actualHours) > 0.01) {
        invalidIds.push(c.id);
        console.log(
          `  Found invalid duration: ${c.id} (expected: ${expectedHours}h, actual: ${actualHours.toFixed(2)}h)`,
        );
      }
    }

    console.log(
      `📊 Found ${invalidIds.length} consultations with invalid durations`,
    );

    // Batch cancel invalid consultations and release their slots
    if (invalidIds.length > 0) {
      const outcome = await cancelRequestsAndReleaseSlots(
        "consultation",
        invalidIds,
      );
      cancelledCount = outcome.cancelled;
      console.log(
        `🔓 Cancelled ${outcome.slotsCancelled} slots from invalid duration consultations`,
      );
      if (outcome.skipped > 0) {
        console.log(
          `⏭️ ${outcome.skipped} skipped — moved out of a cancellable state since the sweep read`,
        );
      }
      console.log(
        `✅ Cancelled ${cancelledCount} invalid duration consultations`,
      );
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    errors.push(
      `Invalid duration consultation cleanup failed: ${errorMessage}`,
    );
    console.error(
      "❌ Failed to cleanup invalid duration consultations:",
      errorMessage,
    );
  }

  return { count: cancelledCount, errors };
}

/**
 * Clean up subscriptions with invalid scheduling periods
 *
 * Finds subscriptions where the scheduling period doesn't match
 * the plan's durationInMonths.
 */
export async function cleanupInvalidDurationSubscriptions(): Promise<{
  count: number;
  errors: string[];
}> {
  console.log("🔍 Finding subscriptions with invalid scheduling periods...");

  const errors: string[] = [];
  let cancelledCount = 0;

  try {
    // Fetch subscriptions with their plans
    const subscriptions = await prisma.subscription.findMany({
      where: { status: { notIn: TERMINAL_STATUSES } },
      include: {
        subscriptionPlan: { select: { durationInMonths: true } },
      },
    });

    const invalidIds: string[] = [];

    for (const s of subscriptions) {
      const expectedMonths = s.subscriptionPlan.durationInMonths;
      const actualMonths = monthsDiff(
        s.schedulingPeriodStartsAt,
        s.schedulingPeriodEndsAt,
      );

      if (actualMonths !== expectedMonths) {
        invalidIds.push(s.id);
        console.log(
          `  Found invalid period: ${s.id} (expected: ${expectedMonths} months, actual: ${actualMonths} months)`,
        );
      }
    }

    console.log(
      `📊 Found ${invalidIds.length} subscriptions with invalid periods`,
    );

    // Batch cancel invalid subscriptions and release their slots
    if (invalidIds.length > 0) {
      const outcome = await cancelRequestsAndReleaseSlots(
        "subscription",
        invalidIds,
      );
      cancelledCount = outcome.cancelled;
      console.log(
        `🔓 Cancelled ${outcome.slotsCancelled} slots from invalid duration subscriptions`,
      );
      if (outcome.skipped > 0) {
        console.log(
          `⏭️ ${outcome.skipped} skipped — moved out of a cancellable state since the sweep read`,
        );
      }
      console.log(
        `✅ Cancelled ${cancelledCount} invalid duration subscriptions`,
      );
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    errors.push(
      `Invalid duration subscription cleanup failed: ${errorMessage}`,
    );
    console.error(
      "❌ Failed to cleanup invalid duration subscriptions:",
      errorMessage,
    );
  }

  return { count: cancelledCount, errors };
}

/**
 * Run all cleanup tasks
 *
 * Executes all four cleanup operations:
 * 1. Duplicate consultations
 * 2. Duplicate subscriptions
 * 3. Invalid duration consultations
 * 4. Invalid duration subscriptions
 *
 * @returns Combined results from all cleanup operations
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
export async function runAllCleanupTasks(): Promise<CleanupResult> {
  return withCronLock(
    "cleanup-invalid-appointments",
    { failMode: "open" },
    () => runAllCleanupTasksUnlocked(),
  );
}

async function runAllCleanupTasksUnlocked(): Promise<CleanupResult> {
  const startTime = Date.now();
  console.log(
    `\n🚀 Starting invalid appointment cleanup at ${new Date().toISOString()}\n`,
  );

  const result: CleanupResult = {
    duplicateConsultationsCancelled: 0,
    duplicateSubscriptionsCancelled: 0,
    invalidDurationConsultationsCancelled: 0,
    invalidDurationSubscriptionsCancelled: 0,
    totalCancelled: 0,
    errors: [],
    success: false,
  };

  try {
    // 1. Cleanup duplicate consultations
    console.log("\n📋 Step 1/4: Duplicate Consultations");
    const dupConsultations = await cleanupDuplicateConsultations();
    result.duplicateConsultationsCancelled = dupConsultations.count;
    result.errors.push(...dupConsultations.errors);

    // 2. Cleanup duplicate subscriptions
    console.log("\n📋 Step 2/4: Duplicate Subscriptions");
    const dupSubscriptions = await cleanupDuplicateSubscriptions();
    result.duplicateSubscriptionsCancelled = dupSubscriptions.count;
    result.errors.push(...dupSubscriptions.errors);

    // 3. Cleanup invalid duration consultations
    console.log("\n📋 Step 3/4: Invalid Duration Consultations");
    const invalidConsultations = await cleanupInvalidDurationConsultations();
    result.invalidDurationConsultationsCancelled = invalidConsultations.count;
    result.errors.push(...invalidConsultations.errors);

    // 4. Cleanup invalid duration subscriptions
    console.log("\n📋 Step 4/4: Invalid Duration Subscriptions");
    const invalidSubscriptions = await cleanupInvalidDurationSubscriptions();
    result.invalidDurationSubscriptionsCancelled = invalidSubscriptions.count;
    result.errors.push(...invalidSubscriptions.errors);

    // Calculate totals
    result.totalCancelled =
      result.duplicateConsultationsCancelled +
      result.duplicateSubscriptionsCancelled +
      result.invalidDurationConsultationsCancelled +
      result.invalidDurationSubscriptionsCancelled;

    result.success = result.errors.length === 0;

    // Summary
    const duration = (Date.now() - startTime) / 1000;
    console.log(`\n📊 Cleanup Summary:`);
    console.log(
      `   🔄 Duplicate consultations cancelled: ${result.duplicateConsultationsCancelled}`,
    );
    console.log(
      `   🔄 Duplicate subscriptions cancelled: ${result.duplicateSubscriptionsCancelled}`,
    );
    console.log(
      `   ⏱️ Invalid duration consultations cancelled: ${result.invalidDurationConsultationsCancelled}`,
    );
    console.log(
      `   ⏱️ Invalid duration subscriptions cancelled: ${result.invalidDurationSubscriptionsCancelled}`,
    );
    console.log(`   📈 Total cancelled: ${result.totalCancelled}`);
    console.log(`   ⏱️ Duration: ${duration.toFixed(2)}s`);

    if (result.errors.length > 0) {
      console.log(`\n⚠️ Errors (${result.errors.length}):`);
      result.errors.forEach((error, i) => {
        console.log(`   ${i + 1}. ${error}`);
      });
    }

    return result;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Disconnect from the database
 * Call this when done using the cleanup functions if not using runAllCleanupTasks
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

// Run the cleanup if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllCleanupTasks()
    .then((result) => {
      if (result.success) {
        console.log("\n🎉 Cleanup job completed successfully");
        process.exit(0);
      } else {
        console.error("\n❌ Cleanup job completed with errors");
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error("\n💥 Cleanup job failed:", error);
      process.exit(1);
    });
}
