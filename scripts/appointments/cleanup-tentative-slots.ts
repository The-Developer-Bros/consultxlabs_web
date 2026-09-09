/**
 * Tentative Slot Cleanup - Core Logic
 *
 * Releases slots marked as isTentative=true that are associated with
 * abandoned booking flows (no successful payment after 24 hours, #833).
 *
 * This happens when:
 * - User started booking but never completed payment
 * - Payment failed and user abandoned checkout
 * - System error prevented slot release after payment failure
 *
 * This module exports the core cleanup function.
 * It is imported by:
 * - jobs/cleanup-tentative-slots.ts (GitHub Actions)
 * - app/api/cleanup/tentative-slots/route.ts (API endpoint)
 *
 * Schedule: Every 2 hours
 */

import prisma from "../../lib/prisma";
import { PaymentStatus, SlotCompletionStatus } from "@prisma/client";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { transitionSlotsInChunks } from "@/lib/booking/slot-release";

// #833 — hours, not days: gateway orders expire well inside a day, so a
// 7-day hold locked users out of rebooking for most of a week. 24h keeps
// margin over Payment.expiresAt and the 2-hourly cron cadence; the parent
// status guard below still protects requests under consultant review.
const TENTATIVE_EXPIRATION_HOURS = 24;

export interface TentativeSlotCleanupResult {
  success: boolean;
  slotsReleased: number;
  appointmentsAffected: number;
  errors: string[];
  timestamp: string;
}

/**
 * Find and release stale tentative slots
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
export async function cleanupTentativeSlots(): Promise<TentativeSlotCleanupResult> {
  return withCronLock("cleanup-tentative-slots", { failMode: "open" }, () =>
    cleanupTentativeSlotsUnlocked(),
  );
}

async function cleanupTentativeSlotsUnlocked(): Promise<TentativeSlotCleanupResult> {
  const errors: string[] = [];
  let slotsReleased = 0;
  const appointmentsAffected = new Set<string>();

  const expirationDate = new Date(
    Date.now() - TENTATIVE_EXPIRATION_HOURS * 60 * 60 * 1000,
  );

  console.log("🧹 Starting tentative slot cleanup...");
  console.log(`   Expiration threshold: ${TENTATIVE_EXPIRATION_HOURS} hours`);

  try {
    // Find tentative slots with no successful payment AND whose parent event
    // is not actively pending review (PENDING / APPROVED_PENDING_PAYMENT).
    // Without this check, we could release slots a consultant is reviewing.
    // #1169 PR 6 — per-run cap (expire-event-channels precedent): an
    // unbounded scan over every stale tentative row OOMs/times out the
    // function before it pages. Oldest-first so hourly runs drain a backlog.
    const MAX_SLOTS_PER_RUN = 5000;
    const staleTentativeSlots = await prisma.slotOfAppointment.findMany({
      take: MAX_SLOTS_PER_RUN,
      orderBy: { updatedAt: "asc" },
      where: {
        isTentative: true,
        // The release is a soft cancel, so the released rows stay in the
        // table. Without this the cohort read re-collects them every run and
        // a large backlog would fill the per-run cap with dead rows forever.
        deletedAt: null,
        // Grace runs from the LAST write, not creation: a reschedule flips
        // isTentative on an old row, and measuring from createdAt gave those
        // slots zero grace before release.
        updatedAt: { lt: expirationDate },
        appointment: {
          payment: {
            none: {
              paymentStatus: PaymentStatus.SUCCEEDED,
            },
          },
          // Skip tentative slots whose parent event is still being actively reviewed
          AND: [
            {
              OR: [
                { consultation: null },
                {
                  consultation: {
                    status: {
                      notIn: ["PENDING", "APPROVED_PENDING_PAYMENT"],
                    },
                  },
                },
              ],
            },
            {
              OR: [
                { subscription: null },
                {
                  subscription: {
                    status: {
                      notIn: ["PENDING", "APPROVED_PENDING_PAYMENT"],
                    },
                  },
                },
              ],
            },
            // Group events: a SCHEDULED/IN_PROGRESS webinar or class with
            // tentative slots is mid-reschedule awaiting a new time — the
            // guard set above only covered request-status event types, so
            // these were swept (dropping attendee links) within the grace
            // window of any unpaid event.
            {
              OR: [
                { webinar: null },
                {
                  webinar: {
                    status: { notIn: ["SCHEDULED", "IN_PROGRESS"] },
                  },
                },
              ],
            },
            {
              OR: [
                { class: null },
                {
                  class: {
                    status: { notIn: ["SCHEDULED", "IN_PROGRESS"] },
                  },
                },
              ],
            },
          ],
        },
      },
      include: {
        appointment: {
          include: {
            payment: { select: { id: true, paymentStatus: true } },
            consultation: {
              select: {
                id: true,
                status: true,
                requestedBy: {
                  include: { user: { select: { name: true, email: true } } },
                },
              },
            },
            subscription: {
              select: {
                id: true,
                status: true,
                requestedBy: {
                  include: { user: { select: { name: true, email: true } } },
                },
              },
            },
          },
        },
      },
    });

    if (staleTentativeSlots.length === MAX_SLOTS_PER_RUN) {
      console.warn(
        JSON.stringify({
          event: "cleanup_tentative_slots_capped",
          cap: MAX_SLOTS_PER_RUN,
          note: "backlog exceeds one run; the next scheduled run continues",
          timestamp: new Date().toISOString(),
        }),
      );
    }

    console.log(`Found ${staleTentativeSlots.length} stale tentative slots`);

    for (const slot of staleTentativeSlots) {
      console.log(`\nProcessing tentative slot ${slot.id}`);
      console.log(`   Appointment ID: ${slot.appointmentId}`);
      console.log(
        `   Created: ${slot.createdAt.toISOString()} (last write ${slot.updatedAt.toISOString()})`,
      );
      console.log(
        `   Slot time: ${slot.startsAt.toISOString()} - ${slot.endsAt.toISOString()}`,
      );

      // Get user info
      const consultation = slot.appointment.consultation;
      const subscription = slot.appointment.subscription;
      const user =
        consultation?.requestedBy?.user || subscription?.requestedBy?.user;
      console.log(
        `   User: ${user?.name || "Unknown"} (${user?.email || "N/A"})`,
      );

      // Log payment status
      const payments = slot.appointment.payment;
      if (payments.length === 0) {
        console.log(`   Payment: None`);
      } else {
        payments.forEach((p) => {
          console.log(`   Payment ${p.id}: ${p.paymentStatus}`);
        });
      }

      appointmentsAffected.add(slot.appointmentId);
    }

    // Release the stale tentative slots so the consultant's calendar frees
    // up. Doctrine rule 2: the slot is freed by status alone, so this is a
    // CAS soft-cancel — the row survives for support and disputes.
    // Only slots whose IDs we already confirmed are safe to release.
    if (staleTentativeSlots.length > 0) {
      // One transaction so the tombstone and its history rows land together.
      slotsReleased = await transitionSlotsInChunks(
        staleTentativeSlots.map((s) => s.id),
        (idChunk) => ({
          where: {
            id: { in: idChunk },
            // #829 — re-state the tentative + unpaid conditions so a slot whose
            // capture webhook confirmed it between the findMany above and this
            // write no longer matches (re-evaluated under the row lock). An
            // id-only release here destroyed paid bookings.
            isTentative: true,
            deletedAt: null,
            appointment: {
              payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
              // The cohort's parent-status guards ride the WHERE too, re-evaluated
              // under the row lock: a parent back under review or an event that
              // went live between the scan and this write keeps its hold.
              AND: [
                {
                  OR: [
                    { consultation: null },
                    {
                      consultation: {
                        status: {
                          notIn: ["PENDING", "APPROVED_PENDING_PAYMENT"],
                        },
                      },
                    },
                  ],
                },
                {
                  OR: [
                    { subscription: null },
                    {
                      subscription: {
                        status: {
                          notIn: ["PENDING", "APPROVED_PENDING_PAYMENT"],
                        },
                      },
                    },
                  ],
                },
                {
                  OR: [
                    { webinar: null },
                    {
                      webinar: {
                        status: { notIn: ["SCHEDULED", "IN_PROGRESS"] },
                      },
                    },
                  ],
                },
                {
                  OR: [
                    { class: null },
                    {
                      class: {
                        status: { notIn: ["SCHEDULED", "IN_PROGRESS"] },
                      },
                    },
                  ],
                },
              ],
            },
          },
          to: SlotCompletionStatus.CANCELLED,
          data: { deletedAt: new Date() },
          // Default from-set on purpose (SCHEDULED / UNVERIFIED / RESCHEDULED):
          // auto-complete stamps a past SCHEDULED slot UNVERIFIED an hour after
          // it ends and does not exclude tentative rows, so a 24h-old hold is
          // usually UNVERIFIED by now. Only COMPLETED is out of reach, which is
          // right — a session that actually happened is not a stale hold.
          allowZero: true,
        }),
      );

      console.log(`\n✅ Released ${slotsReleased} tentative slots`);
    }

    // Summary
    console.log("\n📊 Tentative Slot Cleanup Summary:");
    console.log(`   Slots released: ${slotsReleased}`);
    console.log(`   Appointments affected: ${appointmentsAffected.size}`);
  } catch (error) {
    const msg = `Failed to cleanup tentative slots: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
  }

  return {
    success: errors.length === 0,
    slotsReleased,
    appointmentsAffected: appointmentsAffected.size,
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
