/**
 * Stale PENDING Request Expiration - Core Logic
 *
 * Auto-expires consultations and subscriptions stuck in PENDING state for too long.
 * This happens when:
 * - Consultant never responded to a request
 * - Consultee abandoned the request
 * - System error prevented status update
 *
 * This module exports the core expiration function.
 * It is imported by:
 * - jobs/expire-stale-requests.ts (GitHub Actions)
 * - app/api/cleanup/expire-stale-requests/route.ts (API endpoint)
 *
 * Schedule: Hourly (booking-journey audit B1 — a PENDING consultation holds
 * a tentative slot, so the old daily cadence plus a 30-day threshold let a
 * single account pin a consultant's calendar for a month).
 */

import prisma from "../../lib/prisma";
import {
  AppointmentStatus,
  PaymentStatus,
  SlotCompletionStatus,
} from "@prisma/client";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import {
  RESCHEDULE_OPEN_STATUSES,
  transitionConsultationRequest,
  transitionSlotCompletion,
  transitionSubscriptionRequest,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import {
  SLOT_TRANSITION_TX_OPTIONS,
  transitionSlotsInChunks,
} from "@/lib/booking/slot-release";

// The per-cohort WHERE guards below (PENDING by requestedAt,
// APPROVED_PENDING_PAYMENT by updatedAt) are deliberate subsets of
// REQUEST_ALLOWED_FROM.EXPIRED in lib/booking/transitions.ts (#836) —
// each cohort has its own cutoff, so they are not merged into one sweep.
//
// Belt-and-braces on top of the requestedAt refresh in the reschedule route:
// a booking with a LIVE reschedule proposal (PENDING_REVIEW / COUNTERED) is
// excluded from the PENDING cohorts entirely. The proposal system budgets its
// own lifetime (72h); the expiry sweep must never race it — an unanswered
// reschedule used to be auto-EXPIRED and fully refunded within the hour while
// its proposal was still open.

// Expire PENDING consultations after 48 hours. A PENDING consultation is not
// just paperwork — its request-for-approval tentative slots block the
// consultant's calendar, so the threshold is measured in hours, not days.
// Subscriptions hold no slots at request time (lazy allocation), so they
// keep the generous window below.
const PENDING_CONSULTATION_EXPIRATION_HOURS = 48;

// Expire requests in PENDING state for more than 30 days (subscriptions).
const PENDING_EXPIRATION_DAYS = 30;

// Also expire APPROVED_PENDING_PAYMENT after 7 days
const PAYMENT_PENDING_EXPIRATION_DAYS = 7;

// Per-run cap, same shape as cleanup-tentative-slots' MAX_SLOTS_PER_RUN:
// every arm now expires one request per transaction instead of one bulk
// statement, so an unbounded cohort times the function out before it pages.
// Oldest-first, so consecutive hourly runs drain a backlog.
const MAX_REQUESTS_PER_RUN = 500;
// Slot rows released per run by the stale-RESCHEDULED pass; the next run continues.
const MAX_SLOT_RELEASES_PER_RUN = 2000;

export interface ExpireStaleRequestsResult {
  success: boolean;
  consultationsExpired: number;
  subscriptionsExpired: number;
  paymentPendingExpired: number;
  /** Tentative slots freed by the consultation expiry (B1). */
  consultationSlotsReleased: number;
  /**
   * PR 2c money fix — SUCCEEDED payments refunded because their booking
   * expired unallocated/unanswered. Money must never leave without a
   * session AND silently: every refund routes through the booking front door.
   */
  refundsIssued: number;
  refundFailures: number;
  errors: string[];
  timestamp: string;
}

/**
 * Refund every SUCCEEDED payment attached to the given expired engagement's
 * appointments. Booking-journey audit gap #1: the sweep used to flip PAID
 * rows to EXPIRED with no money movement and no trace — buyer paid, got
 * nothing, silence. Every refund goes through the booking front door
 * (doctrine rule 3); failures are counted + logged, never thrown (a cron
 * must drain the cohort even when one gateway call fails).
 */
async function refundPaymentsForExpired(
  kind: "consultation" | "subscription",
  expiredIds: string[],
): Promise<{ issued: number; failures: number; failureMsgs: string[] }> {
  if (expiredIds.length === 0)
    return { issued: 0, failures: 0, failureMsgs: [] };
  const rel = kind === "consultation" ? "consultationId" : "subscriptionId";
  const appointments = await prisma.appointment.findMany({
    where: { [rel]: { in: expiredIds } },
    select: {
      id: true,
      payment: { select: { id: true, paymentStatus: true } },
    },
  });

  let issued = 0;
  let failures = 0;
  const failureMsgs: string[] = [];
  for (const appt of appointments) {
    for (const pay of appt.payment ?? []) {
      if (pay.paymentStatus !== "SUCCEEDED") continue;
      try {
        await refundBookingPayment({
          paymentId: pay.id,
          reason: `${kind} expired unallocated/unanswered — automatic full refund`,
          initiatedByUserId: null,
        });
        issued += 1;
      } catch (err) {
        failures += 1;
        const msg = `Refund failed for payment ${pay.id} (${kind} ${rel}): ${err}`;
        console.error(`❌ ${msg}`);
        failureMsgs.push(msg);
      }
    }
  }
  return { issued, failures, failureMsgs };
}

/**
 * Expire stale PENDING consultations and release the tentative slots they
 * pinned. The slot release happens HERE rather than waiting for the
 * tentative-slot sweeper: that sweep's parent guard skips PENDING
 * consultations by design (a consultant may legitimately be reviewing), so
 * before B1 a slot pinned by a stale request waited for the status flip and
 * then another sweeper cycle — 30+ days in the worst case.
 */
async function expirePendingConsultations(): Promise<{
  expired: number;
  slotsReleased: number;
  issued: number;
  failures: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const expirationDate = new Date(
    Date.now() - PENDING_CONSULTATION_EXPIRATION_HOURS * 60 * 60 * 1000,
  );

  try {
    // Find stale PENDING consultations (with their appointment ids so the
    // slot release below can target exactly the expired rows).
    const staleConsultations = await prisma.consultation.findMany({
      where: {
        status: AppointmentStatus.PENDING,
        requestedAt: { lt: expirationDate },
        // Never reap a booking whose reschedule proposal is still live.
        appointment: {
          rescheduleRequests: {
            none: { status: { in: [...RESCHEDULE_OPEN_STATUSES] } },
          },
        },
      },
      select: { id: true, appointment: { select: { id: true } } },
      orderBy: { requestedAt: "asc" },
      take: MAX_REQUESTS_PER_RUN,
    });
    warnIfCapped("consultation", staleConsultations.length);

    console.log(
      `Found ${staleConsultations.length} consultations in PENDING for >${PENDING_CONSULTATION_EXPIRATION_HOURS}h`,
    );

    if (staleConsultations.length === 0) {
      return { expired: 0, slotsReleased: 0, issued: 0, failures: 0, errors };
    }

    // One transaction per consultation: the EXPIRED transition and the release
    // of its tentative holds commit together, so a failed release can never
    // leave an EXPIRED request still holding the consultant's calendar. A
    // lost CAS (approved between the read and the write) is skipped, not fatal.
    const expiredIds: string[] = [];
    let slotsReleased = 0;
    let skipped = 0;
    for (const stale of staleConsultations) {
      try {
        const releasedForOne = await prisma.$transaction(async (tx) => {
          await transitionConsultationRequest(tx, {
            where: {
              id: stale.id,
              appointment: {
                rescheduleRequests: {
                  none: { status: { in: [...RESCHEDULE_OPEN_STATUSES] } },
                },
              },
            },
            to: AppointmentStatus.EXPIRED,
            fromIn: [AppointmentStatus.PENDING],
          });
          if (!stale.appointment) return 0;
          return transitionSlotCompletion(tx, {
            where: {
              appointmentId: stale.appointment.id,
              isTentative: true,
              deletedAt: null,
            },
            to: SlotCompletionStatus.CANCELLED,
            data: { deletedAt: new Date() },
            allowZero: true,
          });
        }, SLOT_TRANSITION_TX_OPTIONS);
        expiredIds.push(stale.id);
        slotsReleased += releasedForOne;
      } catch (error) {
        if (!(error instanceof IllegalTransitionError)) throw error;
        skipped++;
      }
    }
    console.log(
      `✅ Expired ${expiredIds.length} PENDING consultations (${skipped} moved on before the write)`,
    );
    console.log(`✅ Released ${slotsReleased} tentative slots from them`);
    const refunds = await refundPaymentsForExpired("consultation", expiredIds);
    errors.push(...refunds.failureMsgs);

    return { expired: expiredIds.length, slotsReleased, ...refunds, errors };
  } catch (error) {
    const msg = `Failed to expire consultations: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
    return { expired: 0, slotsReleased: 0, issued: 0, failures: 0, errors };
  }
}

/**
 * Expire stale PENDING subscriptions
 */
async function expirePendingSubscriptions(): Promise<{
  expired: number;
  issued: number;
  failures: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const expirationDate = new Date(
    Date.now() - PENDING_EXPIRATION_DAYS * 24 * 60 * 60 * 1000,
  );

  // Same live-proposal exclusion as consultations: a full-subscription
  // reschedule re-enters PENDING, and its open proposal must resolve through
  // the reschedule machine (accept/decline/withdraw/expire), not be swept out
  // from under it. Hoisted because the condition has to hold at WRITE time,
  // so it rides the CAS WHERE below as well as the cohort read.
  const NO_LIVE_PROPOSAL = {
    appointments: {
      none: {
        rescheduleRequests: {
          some: { status: { in: [...RESCHEDULE_OPEN_STATUSES] } },
        },
      },
    },
  };

  try {
    // Find stale PENDING subscriptions
    const staleSubscriptions = await prisma.subscription.findMany({
      where: {
        status: AppointmentStatus.PENDING,
        requestedAt: { lt: expirationDate },
        ...NO_LIVE_PROPOSAL,
      },
      include: {
        requestedBy: {
          include: { user: { select: { email: true, name: true } } },
        },
        subscriptionPlan: {
          include: {
            consultantProfile: {
              include: { user: { select: { email: true, name: true } } },
            },
          },
        },
      },
      // #1423 — this arm is now one transaction per subscription rather than a
      // single bulk statement, so it takes the same per-run cap and
      // oldest-first drain as every other cohort in this file.
      orderBy: { requestedAt: "asc" },
      take: MAX_REQUESTS_PER_RUN,
    });
    warnIfCapped("subscription", staleSubscriptions.length);

    console.log(
      `Found ${staleSubscriptions.length} subscriptions in PENDING for >${PENDING_EXPIRATION_DAYS} days`,
    );

    for (const subscription of staleSubscriptions) {
      console.log(`\nExpiring subscription ${subscription.id}`);
      console.log(
        `   Requested by: ${subscription.requestedBy.user.name || "Unknown"}`,
      );
      console.log(
        `   Consultant: ${subscription.subscriptionPlan.consultantProfile.user.name || "Unknown"}`,
      );
      console.log(`   Requested at: ${subscription.requestedAt.toISOString()}`);
    }

    // #1423 — the write used to re-run the 30-day predicate instead of naming
    // the rows the read returned, so the expired set and the refunded set were
    // different sets: a subscription that crossed the cutoff between the read
    // and the write was expired here, left out of refundPaymentsForExpired
    // below, and never seen again (the next run reads PENDING only) — paid,
    // expired, silently unrefunded. It also bypassed
    // transitionSubscriptionRequest, so no bookingStatusHistory row was
    // written for the expiry. Each row now moves through the CAS helper by id,
    // and only the ids the helper actually transitioned are refunded.
    const expiredIds: string[] = [];
    let skipped = 0;
    for (const subscription of staleSubscriptions) {
      try {
        await prisma.$transaction((tx) =>
          transitionSubscriptionRequest(tx, {
            // The cutoff and the proposal guard are repeated here because both
            // must still hold at write time (doctrine rule 1).
            where: {
              id: subscription.id,
              requestedAt: { lt: expirationDate },
              ...NO_LIVE_PROPOSAL,
            },
            to: AppointmentStatus.EXPIRED,
            // Deliberate subset of REQUEST_ALLOWED_FROM.EXPIRED: this cohort
            // owns the PENDING cutoff only.
            fromIn: [AppointmentStatus.PENDING],
            actorUserId: null,
            reason: `Auto-expired: PENDING for more than ${PENDING_EXPIRATION_DAYS} days`,
          }),
        );
        expiredIds.push(subscription.id);
      } catch (error) {
        if (!(error instanceof IllegalTransitionError)) throw error;
        skipped++;
      }
    }

    console.log(
      `✅ Expired ${expiredIds.length} PENDING subscriptions` +
        (skipped > 0 ? ` (${skipped} moved on before the write)` : ""),
    );

    const refunds = await refundPaymentsForExpired("subscription", expiredIds);
    errors.push(...refunds.failureMsgs);

    return {
      expired: expiredIds.length,
      issued: refunds.issued,
      failures: refunds.failures,
      errors,
    };
  } catch (error) {
    const msg = `Failed to expire subscriptions: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
    return { expired: 0, issued: 0, failures: 0, errors };
  }
}

/**
 * PR 2c money fix — the IMMORTAL cohort (audit gap #3): PAID subscriptions
 * whose consultant never allocated a single session. APPROVED was not in
 * EXPIRED's allowed-from and no sweep covered it, so a buyer could stay paid-
 * with-nothing forever. Cohort narrowed to APPROVED with ZERO live confirmed
 * slots (a booking mid-allocation is untouched); expiry refunds via the
 * front door. REQUEST_ALLOWED_FROM.EXPIRED was widened to APPROVED to make
 * this transition legal (lib/booking/transitions.ts).
 */
/**
 * PR 2e (#1192) — release tentative-RESCHEDULED slots on APPROVED
 * subscriptions past the same 30-day window as PENDING expiry. A partial
 * reschedule flips released slots to tentative+RESCHEDULED but leaves the
 * parent APPROVED with no transition edge back — so without this cleanup,
 * those ghost holds block availability forever.
 *
 * Scoped to isTentative AND completionStatus RESCHEDULED so confirmed and
 * SCHEDULED rows are never touched. The parent subscription is NOT expired
 * (it has live confirmed sessions).
 */
const STALE_RESCHEDULED_HOURS = PENDING_EXPIRATION_DAYS * 24;

async function releaseStaleRescheduledSlots(): Promise<{
  released: number;
  errors: string[];
}> {
  try {
    const cutoff = new Date(
      Date.now() - STALE_RESCHEDULED_HOURS * 60 * 60 * 1000,
    );
    const staleRescheduled = {
      isTentative: true as const,
      deletedAt: null,
      updatedAt: { lt: cutoff },
      appointment: {
        subscriptionId: { not: null },
        subscription: { status: AppointmentStatus.APPROVED },
      },
    };
    // Bounded, oldest first, released in chunked transactions; the CAS
    // re-states the cohort's guards on every chunk.
    const stale = await prisma.slotOfAppointment.findMany({
      where: {
        ...staleRescheduled,
        completionStatus: SlotCompletionStatus.RESCHEDULED,
      },
      select: { id: true },
      orderBy: { updatedAt: "asc" },
      take: MAX_SLOT_RELEASES_PER_RUN,
    });
    const released = await transitionSlotsInChunks(
      stale.map((s) => s.id),
      (idChunk) => ({
        where: { id: { in: idChunk }, ...staleRescheduled },
        to: SlotCompletionStatus.CANCELLED,
        data: { deletedAt: new Date() },
        fromIn: [SlotCompletionStatus.RESCHEDULED],
        allowZero: true,
      }),
    );
    console.log(
      `✅ Released ${released} stale RESCHEDULED tentative slots from APPROVED subscriptions`,
    );
    return { released, errors: [] };
  } catch (error) {
    const msg = `Failed to release stale rescheduled slots: ${error}`;
    console.error(`❌ ${msg}`);
    return { released: 0, errors: [msg] };
  }
}

async function expireApprovedUnallocatedSubscriptions(): Promise<{
  expired: number;
  issued: number;
  failures: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const cutoff = new Date(
    Date.now() - PENDING_EXPIRATION_DAYS * 24 * 60 * 60 * 1000,
  );

  // Zero live confirmed sessions anywhere on the booking. Hoisted so the CAS
  // WHERE below re-states it: a session allocated between the read and the
  // write must take its subscription out of this cohort (#1423).
  const NO_LIVE_SESSION = {
    NOT: {
      appointments: {
        some: {
          slotsOfAppointment: {
            some: { isTentative: false, deletedAt: null },
          },
        },
      },
    },
  };

  try {
    const stale = await prisma.subscription.findMany({
      where: {
        status: AppointmentStatus.APPROVED,
        updatedAt: { lt: cutoff },
        ...NO_LIVE_SESSION,
      },
      select: { id: true },
      // Same per-run cap and oldest-first drain as the cohorts above, now that
      // this arm expires one subscription per transaction (#1423).
      orderBy: { updatedAt: "asc" },
      take: MAX_REQUESTS_PER_RUN,
    });
    warnIfCapped("subscription", stale.length);

    if (stale.length === 0)
      return { expired: 0, issued: 0, failures: 0, errors };

    console.log(
      `Found ${stale.length} APPROVED subscriptions with zero allocated sessions for >${PENDING_EXPIRATION_DAYS} days`,
    );

    // #1423 — the bulk write bypassed transitionSubscriptionRequest, so a
    // refunded expiry left no bookingStatusHistory row, and `result.count`
    // could fall short of `staleIds` while every read id was refunded anyway —
    // a refund against a subscription this run never expired. Each row now
    // moves through the CAS helper, and the refund is handed exactly the ids
    // the helper transitioned.
    const expiredIds: string[] = [];
    let skipped = 0;
    for (const subscription of stale) {
      try {
        await prisma.$transaction((tx) =>
          transitionSubscriptionRequest(tx, {
            where: {
              id: subscription.id,
              updatedAt: { lt: cutoff },
              ...NO_LIVE_SESSION,
            },
            to: AppointmentStatus.EXPIRED,
            // Deliberate subset of REQUEST_ALLOWED_FROM.EXPIRED: this cohort
            // is the abandoned-APPROVED shape only.
            fromIn: [AppointmentStatus.APPROVED],
            actorUserId: null,
            reason: `Auto-expired: APPROVED with zero allocated sessions for more than ${PENDING_EXPIRATION_DAYS} days`,
          }),
        );
        expiredIds.push(subscription.id);
      } catch (error) {
        if (!(error instanceof IllegalTransitionError)) throw error;
        skipped++;
      }
    }

    console.log(
      `✅ Expired ${expiredIds.length} APPROVED-unallocated subscriptions` +
        (skipped > 0 ? ` (${skipped} moved on before the write)` : ""),
    );

    const refunds = await refundPaymentsForExpired("subscription", expiredIds);
    errors.push(...refunds.failureMsgs);

    return {
      expired: expiredIds.length,
      issued: refunds.issued,
      failures: refunds.failures,
      errors,
    };
  } catch (error) {
    const msg = `Failed to expire APPROVED-unallocated subscriptions: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
    return { expired: 0, issued: 0, failures: 0, errors };
  }
}

function warnIfCapped(kind: "consultation" | "subscription", read: number) {
  if (read < MAX_REQUESTS_PER_RUN) return;
  console.warn(
    JSON.stringify({
      event: "expire_payment_pending_capped",
      kind,
      cap: MAX_REQUESTS_PER_RUN,
      note: "backlog exceeds one run; the next scheduled run continues",
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * Expire requests stuck in APPROVED_PENDING_PAYMENT.
 *
 * This was the counter-example to doctrine rule 1 rather than the pattern: a
 * bare bulk `updateMany` with neither the CAS from-set nor the money
 * predicate, so a capture recovered by `reconcile-payment-status` between the
 * scan and the write — which flips the Payment to SUCCEEDED without touching
 * the request — expired a booking the buyer had paid for, with no audit row
 * to show for it. Each request now moves through its guarded helper in its
 * own transaction; a raced capture matches zero rows and is skipped.
 */
async function expirePaymentPendingRequests(): Promise<{
  consultationsExpired: number;
  subscriptionsExpired: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const expirationDate = new Date(
    Date.now() - PAYMENT_PENDING_EXPIRATION_DAYS * 24 * 60 * 60 * 1000,
  );

  // The money predicate is repeated in each CAS WHERE below, so these read
  // filters are an optimisation rather than the guard.
  const UNPAID_CONSULTATION = {
    appointment: {
      payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
    },
  };
  // Subscription→Appointment is to-many (one per session), so the predicate
  // inverts: no appointment under this subscription carries a paid payment.
  const UNPAID_SUBSCRIPTION = {
    appointments: {
      none: { payment: { some: { paymentStatus: PaymentStatus.SUCCEEDED } } },
    },
  };

  try {
    const staleConsultations = await prisma.consultation.findMany({
      take: MAX_REQUESTS_PER_RUN,
      orderBy: { updatedAt: "asc" },
      where: {
        status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
        updatedAt: { lt: expirationDate },
        ...UNPAID_CONSULTATION,
      },
      select: { id: true },
    });
    warnIfCapped("consultation", staleConsultations.length);

    let consultationsExpired = 0;
    let consultationsSkipped = 0;
    for (const consultation of staleConsultations) {
      try {
        await prisma.$transaction((tx) =>
          transitionConsultationRequest(tx, {
            where: { id: consultation.id, ...UNPAID_CONSULTATION },
            to: AppointmentStatus.EXPIRED,
            fromIn: [AppointmentStatus.APPROVED_PENDING_PAYMENT],
            data: { pendingPaymentUrl: null }, // Clear payment link
          }),
        );
        consultationsExpired += 1;
      } catch (error) {
        if (!(error instanceof IllegalTransitionError)) throw error;
        consultationsSkipped += 1;
      }
    }

    console.log(
      `✅ Expired ${consultationsExpired} consultations awaiting payment` +
        (consultationsSkipped > 0
          ? ` (${consultationsSkipped} skipped — paid or moved on since the read)`
          : ""),
    );

    const staleSubscriptions = await prisma.subscription.findMany({
      take: MAX_REQUESTS_PER_RUN,
      orderBy: { updatedAt: "asc" },
      where: {
        status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
        updatedAt: { lt: expirationDate },
        ...UNPAID_SUBSCRIPTION,
      },
      select: { id: true },
    });
    warnIfCapped("subscription", staleSubscriptions.length);

    let subscriptionsExpired = 0;
    let subscriptionsSkipped = 0;
    for (const subscription of staleSubscriptions) {
      try {
        await prisma.$transaction((tx) =>
          transitionSubscriptionRequest(tx, {
            where: { id: subscription.id, ...UNPAID_SUBSCRIPTION },
            to: AppointmentStatus.EXPIRED,
            fromIn: [AppointmentStatus.APPROVED_PENDING_PAYMENT],
            data: { pendingPaymentUrl: null }, // Clear payment link
          }),
        );
        subscriptionsExpired += 1;
      } catch (error) {
        if (!(error instanceof IllegalTransitionError)) throw error;
        subscriptionsSkipped += 1;
      }
    }

    console.log(
      `✅ Expired ${subscriptionsExpired} subscriptions awaiting payment` +
        (subscriptionsSkipped > 0
          ? ` (${subscriptionsSkipped} skipped — paid or moved on since the read)`
          : ""),
    );

    return {
      consultationsExpired,
      subscriptionsExpired,
      errors,
    };
  } catch (error) {
    const msg = `Failed to expire payment pending requests: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
    return { consultationsExpired: 0, subscriptionsExpired: 0, errors };
  }
}

/**
 * Main function to expire all stale requests
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion. #1341 — fail-closed: this sweep refunds SUCCEEDED
// payments through the refund front door, so an unlocked double-run risks a
// double refund; a missed run pages instead.
export async function expireStaleRequests(): Promise<ExpireStaleRequestsResult> {
  return withCronLock("expire-stale-requests", { failMode: "closed" }, () =>
    expireStaleRequestsUnlocked(),
  );
}

async function expireStaleRequestsUnlocked(): Promise<ExpireStaleRequestsResult> {
  const allErrors: string[] = [];

  console.log("🕐 Starting stale request expiration...");
  console.log(
    `   Consultation PENDING expiration threshold: ${PENDING_CONSULTATION_EXPIRATION_HOURS}h`,
    `   Subscription PENDING expiration threshold: ${PENDING_EXPIRATION_DAYS} days`,
  );
  console.log(
    `   APPROVED_PENDING_PAYMENT expiration: ${PAYMENT_PENDING_EXPIRATION_DAYS} days`,
  );

  // Expire PENDING consultations
  const consultationResult = await expirePendingConsultations();
  allErrors.push(...consultationResult.errors);

  // Expire PENDING subscriptions
  const subscriptionResult = await expirePendingSubscriptions();
  allErrors.push(...subscriptionResult.errors);

  // Expire APPROVED-unallocated paid subscriptions (PR 2c money fix)
  const approvedUnallocated = await expireApprovedUnallocatedSubscriptions();
  allErrors.push(...approvedUnallocated.errors);

  // Release stale tentative-RESCHEDULED slots on APPROVED subscriptions
  // (PR 2e, #1192 — audit B-P2-02). A partial reschedule flips released
  // slots to tentative+RESCHEDULED but leaves the parent APPROVED; if the
  // consultant never allocates replacements those ghosts block the calendar
  // forever (no sweep cohort covered them). This pass deletes tentative-
  // RESCHEDULED slots past the threshold so the calendar frees up. The
  // parent stays APPROVED (it has confirmed sessions); only the ghosts go.
  const staleRescheduledReleased = await releaseStaleRescheduledSlots();
  allErrors.push(...staleRescheduledReleased.errors);

  // Expire APPROVED_PENDING_PAYMENT requests
  const paymentPendingResult = await expirePaymentPendingRequests();
  allErrors.push(...paymentPendingResult.errors);

  const totalPaymentPending =
    paymentPendingResult.consultationsExpired +
    paymentPendingResult.subscriptionsExpired;

  // Summary
  console.log("\n📊 Stale Request Expiration Summary:");
  console.log(
    `   Consultations expired (PENDING >${PENDING_CONSULTATION_EXPIRATION_HOURS}h): ${consultationResult.expired}`,
  );
  console.log(
    `   Tentative slots released with them: ${consultationResult.slotsReleased}`,
  );
  console.log(
    `   Subscriptions expired (PENDING): ${subscriptionResult.expired}`,
  );
  console.log(
    `   APPROVED-unallocated expired: ${approvedUnallocated.expired}`,
  );
  console.log(
    `   Refunds issued/failed: ${consultationResult.issued + subscriptionResult.issued + approvedUnallocated.issued}/${consultationResult.failures + subscriptionResult.failures + approvedUnallocated.failures}`,
  );
  console.log(`   Payment pending expired: ${totalPaymentPending}`);

  if (allErrors.length > 0) {
    console.log("\n⚠️ Errors encountered:");
    allErrors.forEach((e) => console.log(`   - ${e}`));
  }

  return {
    success: allErrors.length === 0,
    consultationsExpired: consultationResult.expired,
    // #1423 — both subscription arms count here. The APPROVED-unallocated arm
    // used to be invisible in this field: the PENDING arm's bulk statement ran
    // unconditionally and its `count` was reported as the whole total, so the
    // summary never matched what the run actually expired.
    subscriptionsExpired:
      subscriptionResult.expired + approvedUnallocated.expired,
    paymentPendingExpired: totalPaymentPending,
    consultationSlotsReleased: consultationResult.slotsReleased,
    refundsIssued:
      consultationResult.issued +
      subscriptionResult.issued +
      approvedUnallocated.issued,
    refundFailures:
      consultationResult.failures +
      subscriptionResult.failures +
      approvedUnallocated.failures,
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
