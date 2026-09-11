/**
 * Stale PENDING Consultations Cleanup - Core Logic
 *
 * Cleans up consultations stuck in PENDING state with no recent activity.
 * Different from expire-stale-requests.ts - this focuses on consultations
 * that have been approved but have no payment activity within 7 days.
 *
 * This handles edge cases where:
 * - Request was approved but user never initiated payment
 * - Appointment was created but payment link was never used
 * - System state became inconsistent
 *
 * This module exports the core cleanup function.
 * It is imported by:
 * - jobs/cleanup-stale-pending-consultations.ts (GitHub Actions)
 * - app/api/cleanup/stale-pending-consultations/route.ts (API endpoint)
 *
 * Schedule: Hourly
 */

import prisma from "../../lib/prisma";
import {
  AppointmentStatus,
  PaymentStatus,
  SlotCompletionStatus,
} from "@prisma/client";
import {
  transitionConsultationRequest,
  transitionSlotCompletion,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { withCronLock } from "@/lib/cron/with-cron-lock";

// Cancel consultations with APPROVED/APPROVED_PENDING_PAYMENT but no payment after 7 days
const STALE_THRESHOLD_DAYS = 7;

export interface StalePendingConsultationsResult {
  success: boolean;
  consultationsCancelled: number;
  slotsReleased: number;
  errors: string[];
  timestamp: string;
}

/**
 * Cleanup stale pending consultations
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
export async function cleanupStalePendingConsultations(): Promise<StalePendingConsultationsResult> {
  return withCronLock(
    "cleanup-stale-pending-consultations",
    { failMode: "open" },
    () => cleanupStalePendingConsultationsUnlocked(),
  );
}

async function cleanupStalePendingConsultationsUnlocked(): Promise<StalePendingConsultationsResult> {
  const errors: string[] = [];
  let consultationsCancelled = 0;
  let slotsReleased = 0;

  const staleDate = new Date(
    Date.now() - STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000,
  );

  console.log("🧹 Starting stale pending consultations cleanup...");
  console.log(`   Stale threshold: ${STALE_THRESHOLD_DAYS} days`);

  try {
    // Find consultations in APPROVED or APPROVED_PENDING_PAYMENT with no recent activity
    // and no successful payment
    const staleConsultations = await prisma.consultation.findMany({
      where: {
        status: {
          in: [
            AppointmentStatus.APPROVED,
            AppointmentStatus.APPROVED_PENDING_PAYMENT,
          ],
        },
        updatedAt: { lt: staleDate },
        appointment: {
          OR: [
            { payment: { none: {} } }, // No payment records
            {
              payment: {
                every: {
                  paymentStatus: { not: PaymentStatus.SUCCEEDED },
                },
              },
            },
          ],
        },
      },
      include: {
        requestedBy: {
          include: { user: { select: { name: true, email: true } } },
        },
        consultationPlan: {
          include: {
            consultantProfile: {
              include: { user: { select: { name: true, email: true } } },
            },
          },
        },
        appointment: {
          include: {
            slotsOfAppointment: true,
            payment: { select: { id: true, paymentStatus: true } },
          },
        },
      },
    });

    console.log(
      `Found ${staleConsultations.length} stale pending consultations`,
    );

    for (const consultation of staleConsultations) {
      console.log(`\nProcessing consultation ${consultation.id}`);
      console.log(`   Status: ${consultation.status}`);
      console.log(
        `   Consultee: ${consultation.requestedBy.user.name || "Unknown"}`,
      );
      console.log(
        `   Consultant: ${consultation.consultationPlan.consultantProfile.user.name || "Unknown"}`,
      );
      console.log(`   Last updated: ${consultation.updatedAt.toISOString()}`);

      const appointment = consultation.appointment;
      const tentativeSlotsCount =
        appointment?.slotsOfAppointment.filter((s) => s.isTentative).length ||
        0;

      if (appointment) {
        console.log(`   Appointment ID: ${appointment.id}`);
        console.log(`   Slots: ${appointment.slotsOfAppointment.length}`);
        console.log(`   Payments: ${appointment.payment.length}`);
        console.log(`   Tentative slots to release: ${tentativeSlotsCount}`);
      }

      try {
        // Cancel the consultation and release tentative slots
        const released = await prisma.$transaction(async (tx) => {
          // CAS (#1319): the cohort is APPROVED / APPROVED_PENDING_PAYMENT; a
          // request that was paid or scheduled since the read matches zero
          // rows and is skipped, never cancelled.
          //
          // Status alone is not enough. `reconcile-payment-status` flips a
          // stale Stripe payment to SUCCEEDED without touching the request, so
          // a capture recovered between the cohort read and this write leaves
          // the status at APPROVED_PENDING_PAYMENT — cancelling it would take
          // the money and release the slots. The read's payment filter is
          // repeated here so it is re-evaluated by the UPDATE itself.
          await transitionConsultationRequest(tx, {
            where: {
              id: consultation.id,
              appointment: {
                payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
              },
            },
            to: AppointmentStatus.CANCELLED,
            fromIn: [
              AppointmentStatus.APPROVED,
              AppointmentStatus.APPROVED_PENDING_PAYMENT,
            ],
            data: {
              cancellationNotes: `Auto-cancelled: No payment activity for ${STALE_THRESHOLD_DAYS} days`,
              cancelledAt: new Date(),
            },
          });

          // Release tentative slots by status (rule 2: nothing is deleted).
          if (!appointment) return 0;
          return transitionSlotCompletion(tx, {
            where: {
              appointmentId: appointment.id,
              isTentative: true,
              deletedAt: null,
            },
            to: SlotCompletionStatus.CANCELLED,
            data: { deletedAt: new Date() },
            allowZero: true,
          });
        });

        slotsReleased += released;
        console.log(`   ✅ Cancelled consultation`);
        consultationsCancelled++;
      } catch (error) {
        if (error instanceof IllegalTransitionError) {
          console.log(
            `   ⏭️ Skipped — status changed, or the payment succeeded, since the sweep read`,
          );
          continue;
        }
        const msg = `Failed to cancel consultation ${consultation.id}: ${error}`;
        console.error(`   ❌ ${msg}`);
        errors.push(msg);
      }
    }

    // Summary
    console.log("\n📊 Stale Pending Consultations Summary:");
    console.log(`   Consultations cancelled: ${consultationsCancelled}`);
    console.log(`   Slots released: ${slotsReleased}`);
  } catch (error) {
    const msg = `Failed to cleanup stale consultations: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
  }

  return {
    success: errors.length === 0,
    consultationsCancelled,
    slotsReleased,
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
