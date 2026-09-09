/**
 * Payment-Earning Sync - Core Logic
 *
 * Syncs ConsultantEarnings records with Payment records.
 * Finds all payments where status = SUCCEEDED but no corresponding earnings exists.
 *
 * This catches cases where:
 * - App crash after payment succeeded but before earnings created
 * - Webhook was missed or delayed
 * - Manual payment processing at gateway
 *
 * This module exports the core sync function.
 * It is imported by:
 * - jobs/sync-payment-earnings.ts (GitHub Actions)
 * - app/api/cleanup/sync-payment-earnings/route.ts (API endpoint)
 *
 * GitHub Issue: #303
 * Schedule: Hourly
 */

import prisma from "../../lib/prisma";
import { PaymentStatus, AppointmentsType } from "@prisma/client";
import { AppointmentType } from "../../lib/payments/payouts/constants";
import { createEarningsFromPayment } from "../../lib/payments/payouts/earnings-service";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import { recordSystemError } from "@/lib/enterprise/system-events";

// Batch size for processing payments to prevent memory issues
const BATCH_SIZE = 100;

/**
 * #1319 — the cohort has no age window any more, so the run needs a ceiling.
 *
 * Settlement for an org-funded checkout runs after the checkout transaction
 * commits, and a failure there is recorded and moved past. This sweep is the
 * only thing that repairs it — and it used to look back thirty days, so a
 * payment that stayed unaccrued for a month left the cohort silently and the
 * consultant was never paid for a session they had already delivered. There is
 * no age at which money stops being owed, so there is no window here now. The
 * ceiling bounds the runtime instead, and the ordering is oldest-first because
 * the payments that have gone unaccrued longest are the ones somebody has been
 * waiting on.
 */
const MAX_PAYMENTS_PER_RUN = 500;

/**
 * How long a SUCCEEDED payment may sit without earnings before the sweep pages
 * a human about it. Under this the settlement may simply still be in flight.
 */
const UNACCRUED_ALERT_AFTER_HOURS = 24;

export interface PaymentEarningSyncResult {
  success: boolean;
  totalProcessed: number;
  createdCount: number;
  skippedCount: number;
  errorCount: number;
  /** #1319 — payments escalated as permanently unaccruable this run. */
  pagedCount: number;
  errors: string[];
  timestamp: string;
}

export interface SyncPaymentEarningsOptions {
  /** #1356 — overrides MAX_PAYMENTS_PER_RUN for the Netlify ticker; undefined
   * keeps the 500-row GitHub Actions ceiling. */
  limit?: number;
}

/** A payment that has a booking but no consultant anyone could ever pay. */
type UnaccruablePayment = {
  id: string;
  appointmentId: string | null;
  organizationId: string | null;
  amountPaise: string;
  createdAt: Date;
};

/**
 * One alert per payment per UTC day. `SystemEvent.correlationId` is indexed and
 * carries no meaning of its own for this category, so folding the date into it
 * makes "have we already paged for this today?" a single indexed read for the
 * whole batch instead of a per-payment round trip.
 */
function unaccruedAlertKey(paymentId: string, now: Date): string {
  return `earnings-unaccrued:${paymentId}:${now.toISOString().slice(0, 10)}`;
}

/**
 * Escalate the payments this sweep can never heal (#1319).
 *
 * `createEarningsFromPayment` returns null with a `console.warn` when it cannot
 * resolve a consultant, and the sweep counted that as "skipped" — so a payment
 * that no run will ever accrue was re-read every hour, forever, and said so
 * only into a log nobody reads. A booking that exists but resolves no
 * consultant is unambiguous: nobody can be paid for it, and the data needs a
 * human.
 *
 * A payment with no appointment AT ALL is deliberately not paged here. That
 * cohort belongs to `scripts/alerts/alert-orphaned-payments.ts`, and it legally
 * contains rows that will never accrue by design — the overage side-charge is
 * created with `appointmentId: null` precisely to dodge the
 * `@@unique([userId, appointmentId])` clash.
 */
async function pageUnaccruablePayments(
  candidates: UnaccruablePayment[],
  now: Date,
): Promise<number> {
  if (candidates.length === 0) return 0;

  const keys = candidates.map((p) => unaccruedAlertKey(p.id, now));
  // Best-effort throughout: the sweep's money repair must never fail because
  // its alerting could not read or write.
  let seen: Set<string | null>;
  try {
    const alreadyPaged = await prisma.systemEvent.findMany({
      where: { correlationId: { in: keys } },
      select: { correlationId: true },
    });
    seen = new Set(alreadyPaged.map((e) => e.correlationId));
  } catch (err) {
    console.error(
      "[sync-payment-earnings] dedupe lookup failed; skipping paging this run:",
      err,
    );
    return 0;
  }

  let paged = 0;
  for (const payment of candidates) {
    const key = unaccruedAlertKey(payment.id, now);
    if (seen.has(key)) continue;

    const ageHours = Math.floor(
      (now.getTime() - payment.createdAt.getTime()) / 3_600_000,
    );
    await recordSystemError({
      organizationId: payment.organizationId,
      category: "PAYMENT",
      summary:
        `Payment ${payment.id} has been SUCCEEDED for ${ageHours}h with no ` +
        `consultant earnings and no consultant to accrue them to; the sync ` +
        `sweep cannot heal it`,
      err: new Error("EARNINGS_UNACCRUABLE_NO_CONSULTANT"),
      context: {
        paymentId: payment.id,
        appointmentId: payment.appointmentId,
        amountPaise: payment.amountPaise,
        paymentCreatedAt: payment.createdAt.toISOString(),
        ageHours,
      },
      correlationId: key,
    })
      .then(() => {
        paged++;
      })
      .catch((err) => {
        console.error(
          `[sync-payment-earnings] failed to page for ${payment.id}:`,
          err,
        );
      });
  }
  return paged;
}

/**
 * Map AppointmentsType enum to the payout constants key
 */
function mapAppointmentType(type: AppointmentsType): AppointmentType {
  switch (type) {
    case AppointmentsType.CONSULTATION:
      return "CONSULTATION";
    case AppointmentsType.WEBINAR:
      return "WEBINAR";
    case AppointmentsType.CLASS:
      return "CLASS";
    case AppointmentsType.SUBSCRIPTION:
      return "SUBSCRIPTION";
    default:
      return "CONSULTATION"; // Default to consultation hold period
  }
}

/**
 * Find succeeded payments without earnings and create them
 * Uses batch processing to handle large datasets efficiently
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function syncPaymentEarnings(
  opts: SyncPaymentEarningsOptions = {},
): Promise<PaymentEarningSyncResult> {
  return withCronLock(
    "sync-payment-earnings",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => syncPaymentEarningsUnlocked(opts),
  );
}

async function syncPaymentEarningsUnlocked(
  opts: SyncPaymentEarningsOptions = {},
): Promise<PaymentEarningSyncResult> {
  const errors: string[] = [];
  let totalProcessed = 0;
  let createdCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  const maxPayments = opts.limit ?? MAX_PAYMENTS_PER_RUN;

  const now = new Date();
  const alertCutoff = new Date(
    now.getTime() - UNACCRUED_ALERT_AFTER_HOURS * 60 * 60 * 1000,
  );
  /** Collected across batches so the whole run pages in one indexed read. */
  const unaccruable: UnaccruablePayment[] = [];

  // FIX #571: Use cursor-based pagination instead of skip-based.
  // Skip-based pagination on a mutating result set (earnings: { none: {} })
  // can silently skip payments when items are removed from the set mid-iteration.
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore && totalProcessed < maxPayments) {
    const take = Math.min(BATCH_SIZE, maxPayments - totalProcessed);
    // Fetch batch with cursor-based pagination
    const payments = await prisma.payment.findMany({
      where: {
        paymentStatus: PaymentStatus.SUCCEEDED,
        earnings: { none: {} }, // No linked earnings
      },
      take,
      ...(cursor
        ? { cursor: { id: cursor }, skip: 1 } // skip the cursor item itself
        : {}),
      include: {
        appointment: {
          include: {
            consultation: {
              include: {
                consultationPlan: {
                  select: { consultantProfileId: true },
                },
              },
            },
            subscription: {
              include: {
                subscriptionPlan: {
                  select: { consultantProfileId: true },
                },
              },
            },
            webinar: {
              include: {
                webinarPlan: {
                  select: {
                    id: true,
                    consultantProfileId: true,
                  },
                },
              },
            },
            class: {
              include: {
                classPlan: {
                  select: {
                    id: true,
                    consultantProfileId: true,
                  },
                },
              },
            },
          },
        },
      },
      // Oldest first: the longest-unaccrued payment is the one somebody has
      // been waiting on. The id tie-break makes the ordering total, which is
      // what the cursor needs to be able to resume without repeating a row.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    if (payments.length < take) {
      hasMore = false;
    }
    if (payments.length > 0) {
      cursor = payments[payments.length - 1].id;
    }
    totalProcessed += payments.length;

    if (payments.length === 0) {
      break;
    }

    console.log(
      `Processing batch of ${payments.length} payments (total processed: ${totalProcessed})`,
    );

    // Batch check existing earnings (instead of N individual queries)
    const paymentIds = payments.map((p) => p.id);
    const existingEarnings = await prisma.consultantEarnings.findMany({
      where: { paymentId: { in: paymentIds } },
      select: { paymentId: true },
    });
    const existingPaymentIds = new Set(
      existingEarnings.map((e) => e.paymentId),
    );

    // #773 — delegate creation to createEarningsFromPayment, the single
    // source of truth: it resolves collaborator + HOST-org settlement, nets
    // shares, and posts the balanced booking:<paymentId> journal txn in the
    // same operation. The old local writer minted full-share collaborator
    // rows with NO journal — every synced multi-party payment was born as
    // EARNINGS_WITHOUT_BOOKING_TXN drift. Old payments get a fresh hold
    // window (the release cron flips them READY on schedule).
    for (const payment of payments) {
      if (existingPaymentIds.has(payment.id)) {
        skippedCount++;
        continue;
      }

      const appointment = payment.appointment;
      const consultantProfileId =
        appointment?.consultation?.consultationPlan?.consultantProfileId ||
        appointment?.subscription?.subscriptionPlan?.consultantProfileId ||
        appointment?.webinar?.webinarPlan?.consultantProfileId ||
        appointment?.class?.classPlan?.consultantProfileId;

      if (!appointment || !consultantProfileId) {
        // #1319 — a booking that resolves no consultant will not heal on the
        // next run either, so it is escalated rather than skipped in silence.
        // Fresh payments are left alone: settlement runs post-commit and may
        // still be in flight.
        if (appointment && payment.createdAt < alertCutoff) {
          unaccruable.push({
            id: payment.id,
            appointmentId: payment.appointmentId,
            organizationId: payment.organizationId,
            amountPaise: payment.amount.toString(),
            createdAt: payment.createdAt,
          });
        }
        console.log(
          `⏭️ Skipping payment ${payment.id} - no consultant profile found`,
        );
        skippedCount++;
        continue;
      }

      try {
        const earningsId = await createEarningsFromPayment({
          payment: {
            ...payment,
            appointment: {
              consultantProfile: { id: consultantProfileId },
              webinar: appointment.webinar
                ? { webinarPlanId: appointment.webinar.webinarPlanId }
                : null,
              class: appointment.class
                ? { classPlanId: appointment.class.classPlanId }
                : null,
            },
          },
          appointmentType: mapAppointmentType(appointment.appointmentType),
        });
        if (earningsId) {
          createdCount++;
        } else {
          skippedCount++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Payment ${payment.id}: ${msg}`);
        errorCount++;
      }
    }
  }

  const pagedCount = await pageUnaccruablePayments(unaccruable, now);

  console.log(
    `Sync complete: ${totalProcessed} total, ${createdCount} created, ${skippedCount} skipped, ${errorCount} errors, ${pagedCount} paged`,
  );

  return {
    success: errors.length === 0,
    totalProcessed,
    createdCount,
    skippedCount,
    errorCount,
    pagedCount,
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
