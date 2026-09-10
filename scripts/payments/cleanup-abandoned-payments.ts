#!/usr/bin/env node

/**
 * Abandoned Payment Cleanup Script
 *
 * Core library for cleaning up abandoned payments and appointments
 * that have exceeded their timeout periods.
 *
 * This module exports functions that can be used by:
 * - Local development: `npm run scripts:cleanup-abandoned-payments`
 * - GitHub Actions: `jobs/cleanup-abandoned-payments.ts`
 * - API routes: Can import and call functions directly
 *
 * Contains race condition fixes:
 * - Issue #6: 35 min buffer (5 min over 30 min expiry) for legacy payments
 * - Issue #10: Re-check payment status before cleanup to handle webhooks
 */

import {
  PaymentStatus,
  PaymentGateway,
  AppointmentStatus,
  SlotCompletionStatus,
} from "@prisma/client";
import type Stripe from "stripe";
import { cancelRazorpayOrder } from "../../lib/payments/core/razorpay";
import { reverseCreditsForPayment } from "@/lib/referrals/service";
import {
  transitionConsultationRequest,
  transitionSlotCompletion,
  transitionSubscriptionRequest,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import prisma, { type Tx } from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";

/**
 * Result structure for cleanup operations
 */
export interface CleanupResult {
  success: boolean;
  cleanedCount: number;
  /** Rows whose status moved since the cohort read; left alone, not failures. */
  skippedCount: number;
  errorCount: number;
  totalProcessed: number;
  errors: string[];
}

export interface CleanupAbandonedOptions {
  /** #1356 — caps the cohort for the Netlify ticker; undefined keeps the
   * unbounded GitHub Actions behaviour. */
  limit?: number;
}

/**
 * #1386 — the same fence every money path reads, in the same shape
 * `assertGatewayUsable` and the disputes sweep use: an env read at call time,
 * because the gateway cores load lazily and jest flips the flag between cases.
 */
function isStripeEnabled(): boolean {
  return process.env.STRIPE_ENABLED === "true";
}

/**
 * #1464 — the fence is a property of the deployment, not of a payment, so one
 * line per run says everything an operator needs; one line per fenced row
 * would bury the rest of the summary. Reset at the top of each sweep so a
 * later run still explains itself.
 */
let stripeFenceLogged = false;

function logStripeFenceOnce(): void {
  if (stripeFenceLogged) return;
  stripeFenceLogged = true;
  console.log(
    '⏭️ Leaving Stripe intents alone — STRIPE_ENABLED is not "true" (#1386). ' +
      "There is nothing to cancel on a gateway this deployment never charged.",
  );
}

/** The two intent states that mean the hold this cancel was for is gone. */
const TERMINAL_INTENT_STATUSES = new Set(["canceled", "succeeded"]);

/**
 * #1461 — `payment_intent_unexpected_state` does not mean "already gone". It
 * means "the intent's current state forbids a cancel", which covers a
 * `canceled` or `succeeded` intent (genuinely nothing to do) and equally a
 * `processing` or `requires_capture` one, where the gateway is still holding
 * the buyer's money. Stripe attaches the offending intent to the error, so the
 * two can be told apart without spending a `retrieve` round trip out of this
 * sweep's 4 s per-cancel budget. Read defensively off both the top level and
 * `raw`, because which one carries it depends on the SDK's error wrapping.
 */
function unexpectedStateIsTerminal(error: unknown): boolean {
  const err = error as
    | {
        payment_intent?: { status?: unknown };
        raw?: { payment_intent?: { status?: unknown } };
      }
    | null
    | undefined;
  const status =
    err?.payment_intent?.status ?? err?.raw?.payment_intent?.status;
  return typeof status === "string" && TERMINAL_INTENT_STATUSES.has(status);
}

/**
 * #1464 — an intent Stripe cannot find, or one that is already in a terminal
 * state, is nothing to cancel rather than a failure: the hold it represented
 * is gone, which is exactly what the cancel was for. Matched on the error's
 * own fields instead of `instanceof Stripe.errors.StripeError` so the check
 * does not depend on the lazily-imported SDK's class identity.
 *
 * #1461 — the row is expired either way (that is #1464's point), so what this
 * decides is only whether an operator is told. A live intent we could not
 * cancel, sitting behind a locally EXPIRED payment, is exactly the state
 * someone has to look at, even though #1439 heals a capture that lands late.
 */
function isNothingToCancel(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === "resource_missing") return true;
  // Terminal by the payload's own account, or a failure. An absent status is
  // a failure too: unproven is not the same as safe.
  if (code === "payment_intent_unexpected_state")
    return unexpectedStateIsTerminal(error);
  return error instanceof Error && error.message.includes("already");
}

/**
 * Cancel one Stripe intent through the fenced client.
 *
 * The id shape decides the call, as in `cancelStripePayment`: checkout
 * sessions (`cs_…`) are expired and payment intents (`pi_…`) are cancelled.
 * Anything the gateway genuinely refused is rethrown, because the caller
 * counts it.
 */
async function cancelStripeIntent(
  stripe: Stripe,
  paymentIntent: string,
): Promise<void> {
  try {
    if (paymentIntent.startsWith("cs_")) {
      await stripe.checkout.sessions.expire(paymentIntent);
    } else {
      await stripe.paymentIntents.cancel(paymentIntent);
    }
    console.log(`✅ Cancelled Stripe payment intent: ${paymentIntent}`);
  } catch (error) {
    if (!isNothingToCancel(error)) throw error;
    console.log(
      `✅ Stripe intent ${paymentIntent} was already gone — nothing to cancel`,
    );
  }
}

/**
 * Cancel payment intent with the appropriate payment gateway
 */
export async function cancelPaymentIntent(
  paymentIntent: string,
  gateway: PaymentGateway,
): Promise<void> {
  try {
    switch (gateway) {
      case PaymentGateway.STRIPE: {
        // #1464 — respect the #1386 fence. This arm used to build a raw client
        // around STRIPE_SECRET_KEY, so it bypassed both the fence and the
        // test-key guard: with Stripe off, the key is absent or a test key and
        // the call can only fail, which then blocked the expiry below.
        if (!isStripeEnabled()) {
          logStripeFenceOnce();
          break;
        }
        // #1376 — gateway cores load at call time, and this module is reached
        // from the cleanup route's graph.
        const { getStripeClient } = await import("@/lib/payments/core/stripe");
        const stripe = getStripeClient();
        if (!stripe) {
          console.warn("⚠️ STRIPE_SECRET_KEY not configured");
          break;
        }
        await cancelStripeIntent(stripe, paymentIntent);
        break;
      }

      case PaymentGateway.RAZORPAY:
        await cancelRazorpayOrder(paymentIntent);
        break;

      default:
        console.warn(`⚠️ Unknown payment gateway: ${gateway}`);
    }
  } catch (error) {
    console.error(
      `❌ Failed to cancel ${gateway} payment intent ${paymentIntent}:`,
      describeError(error),
    );
    throw error;
  }
}

/** Every catch in this sweep reports a failure the same way. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/** Both sweeps below report the same shape, so one printer keeps them in step. */
function logCleanupSummary(
  title: string,
  noun: string,
  result: CleanupResult,
): void {
  console.log(`\n📈 ${title}:`);
  console.log(`   ✅ Successfully cleaned: ${result.cleanedCount} ${noun}`);
  console.log(
    `   ⏭️ Skipped (status moved since the read): ${result.skippedCount} ${noun}`,
  );
  console.log(`   ❌ Failed to clean: ${result.errorCount} ${noun}`);
  console.log(`   📊 Total processed: ${result.totalProcessed} ${noun}`);

  if (result.totalProcessed > 0) {
    console.log(
      `   🎯 Success rate: ${((result.cleanedCount / result.totalProcessed) * 100).toFixed(1)}%`,
    );
  }

  if (result.errorCount > 0) {
    console.warn(
      `⚠️ ${result.errorCount} ${noun} failed to clean up - manual intervention may be required`,
    );
    result.errors.forEach((error, index) => {
      console.warn(`   ${index + 1}. ${error}`);
    });
  }
}

/**
 * The cohort: an appointment still holding a slot or a group seat against a
 * PENDING payment that has passed its expiry.
 */
function findAbandonedAppointments(limit?: number) {
  return prisma.appointment.findMany({
    take: limit,
    // Oldest-first with an id tie-break: a bounded run must not leave the
    // same stale holds behind every tick while newer ones get processed.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    where: {
      payment: {
        some: {
          AND: [
            { paymentStatus: PaymentStatus.PENDING },
            {
              OR: [
                { expiresAt: { lt: new Date() } }, // Explicitly expired
                {
                  AND: [
                    { expiresAt: null }, // No expiration set (legacy)
                    {
                      createdAt: {
                        // FIX Issue #6: 35 min buffer (5 min over 30 min expiry)
                        // Prevents race condition at payment expiration boundary
                        lt: new Date(Date.now() - 35 * 60 * 1000),
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      // Group-event seats are held by connecting the buyer to shared,
      // non-tentative slots, so a tentative-slot filter would never see an
      // abandoned webinar or class checkout.
      OR: [
        { slotsOfAppointment: { some: { isTentative: true } } },
        { webinar: { isNot: null } },
        { class: { isNot: null } },
      ],
    },
    include: {
      payment: {
        where: { paymentStatus: PaymentStatus.PENDING },
      },
      consultation: true,
      subscription: true,
      webinar: true,
      class: true,
      slotsOfAppointment: true,
    },
  });
}

type AbandonedAppointment = Awaited<
  ReturnType<typeof findAbandonedAppointments>
>[number];
type AbandonedPayment = AbandonedAppointment["payment"][number];

/**
 * FIX Issue #10 — a capture webhook can land between the cohort read and this
 * transaction, so the payment status is re-read inside it before anything is
 * touched.
 */
async function anyPaymentSucceeded(
  tx: Pick<Tx, "payment">,
  appointment: AbandonedAppointment,
): Promise<boolean> {
  for (const payment of appointment.payment) {
    const freshPayment = await tx.payment.findUnique({
      where: { id: payment.id },
    });

    if (freshPayment?.paymentStatus === PaymentStatus.SUCCEEDED) {
      console.log(
        JSON.stringify({
          event: "cleanup_skipped_payment_succeeded",
          paymentId: payment.id,
          appointmentId: appointment.id,
          reason: "Payment completed during cleanup processing",
          timestamp: new Date().toISOString(),
        }),
      );
      return true;
    }
  }
  return false;
}

/**
 * #1464 — where one appointment's failures are collected. `count` is mutated
 * in place rather than returned, because a gateway cancel is an external call
 * the caller's transaction cannot roll back: it must still reach `errorCount`
 * when the unit around it is rolled back and reported as skipped.
 */
interface FailureSink {
  /** Appended to `CleanupResult.errors`. */
  messages: string[];
  /** Added to `CleanupResult.errorCount` by the caller. */
  count: number;
}

/**
 * Cancel the gateway intent and mark the row EXPIRED (timed out, not a gateway
 * rejection).
 *
 * #1464 — the expiry does not depend on the cancel succeeding. Skipping the CAS
 * on a failed cancel desynchronised the unit: the credits were handed back and
 * the slot released around a payment left PENDING, which no later sweep could
 * see, because nothing about it still looked abandoned. Expiring anyway is also
 * what the Razorpay arm has always done — an order cannot be cancelled, so that
 * cancel is a no-op — and a capture landing after the row is EXPIRED is the
 * terminal race #1439 owns. The failure is recorded AND counted, so the run
 * reports `success: false` and the HTTP twin answers non-2xx.
 */
async function expirePendingPayments(
  tx: Pick<Tx, "payment">,
  payments: AbandonedPayment[],
  failures: FailureSink,
): Promise<void> {
  // #1459 — the gateway round trips run first and in parallel; the status
  // writes below stay one-at-a-time and in cohort order, because they are the
  // part that has to be a deterministic sequence inside the caller's
  // transaction.
  const cancelFailures = await cancelGatewayIntents(payments);

  for (const payment of payments) {
    const failure = cancelFailures.get(payment.id);
    if (failure !== undefined) {
      console.warn(
        `⚠️ Failed to cancel payment intent ${payment.paymentIntent}:`,
        failure,
      );
      failures.messages.push(
        `Payment cancellation failed for ${payment.paymentIntent}: ${failure}`,
      );
      failures.count++;
    }

    // Conditional on PENDING: a capture racing this sweep keeps SUCCEEDED.
    await tx.payment.updateMany({
      where: { id: payment.id, paymentStatus: PaymentStatus.PENDING },
      data: { paymentStatus: PaymentStatus.EXPIRED },
    });
  }
}

/**
 * #1459 — how many gateway cancels are in flight at once. The Netlify ticker
 * gives this sweep a 6 s budget (ADR 27) and one sequential round trip per
 * payment spent all of it on five stuck rows, so every tick aborted mid-sweep.
 * Five is enough to hide the latency without opening a burst the gateway would
 * rate-limit.
 */
const GATEWAY_CANCEL_CONCURRENCY = 5;

/**
 * #1459 — ceiling on a single cancel. Neither gateway client sets one, so a
 * hung connection would hold the whole batch past the ticker's timeout and the
 * payment would never be marked EXPIRED. A timed-out cancel is recorded like
 * any other gateway failure and retried on the next run.
 */
const GATEWAY_CANCEL_TIMEOUT_MS = 4_000;

async function cancelWithTimeout(
  paymentIntent: string,
  gateway: PaymentGateway,
): Promise<void> {
  // AbortSignal.timeout's timer does not hold the event loop open, so a cancel
  // that wins the race leaves nothing behind to keep the function alive.
  const signal = AbortSignal.timeout(GATEWAY_CANCEL_TIMEOUT_MS);
  await Promise.race([
    cancelPaymentIntent(paymentIntent, gateway),
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () =>
        reject(
          new Error(
            `Gateway cancel timed out after ${GATEWAY_CANCEL_TIMEOUT_MS} ms`,
          ),
        ),
      );
    }),
  ]);
}

/**
 * Cancel every payment's gateway intent with bounded concurrency.
 *
 * Exported for the concurrency pin: the ceiling is the whole point of the
 * function, and it is invisible from the outside of the sweep.
 *
 * @returns The failures only, keyed by payment id — a payment absent from the
 *   map was cancelled and is safe to mark EXPIRED.
 */
export async function cancelGatewayIntents(
  payments: readonly Pick<
    AbandonedPayment,
    "id" | "paymentIntent" | "paymentGateway"
  >[],
): Promise<Map<string, string>> {
  const failures = new Map<string, string>();

  for (let i = 0; i < payments.length; i += GATEWAY_CANCEL_CONCURRENCY) {
    const chunk = payments.slice(i, i + GATEWAY_CANCEL_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((payment) =>
        cancelWithTimeout(payment.paymentIntent, payment.paymentGateway),
      ),
    );
    settled.forEach((outcome, j) => {
      if (outcome.status === "rejected") {
        failures.set(chunk[j].id, describeError(outcome.reason));
      }
    });
  }

  return failures;
}

/**
 * Restore referral credits consumed by these payments. The rows now survive
 * (soft-cancel below), so this is the whole point rather than an ordering trick
 * against a cascade.
 */
async function restoreReferralCredits(
  tx: Tx,
  payments: AbandonedPayment[],
): Promise<void> {
  for (const payment of payments) {
    try {
      const restored = await reverseCreditsForPayment(payment.id, tx);
      if (restored > 0) {
        console.log(
          `🔄 Restored ${restored} paise of referral credits from abandoned payment ${payment.id}`,
        );
      }
    } catch (creditError) {
      console.warn(
        `⚠️ Failed to restore credits for payment ${payment.id}:`,
        describeError(creditError),
      );
    }
  }
}

/**
 * Group events: disconnect only the abandoning buyers. The session slots are
 * shared by everyone who registered, so deleting them would strand every other
 * attendee.
 */
async function releaseGroupSeats(
  tx: Pick<Tx, "slotOfAppointment">,
  appointment: AbandonedAppointment,
): Promise<void> {
  const kind = appointment.webinar ? "webinar" : "class";
  const abandonedUserIds = Array.from(
    new Set(appointment.payment.map((p) => p.userId)),
  );
  const seatFilter = appointment.class
    ? { appointment: { classId: appointment.class.id } }
    : { appointmentId: appointment.id };

  for (const abandonedUserId of abandonedUserIds) {
    const seatSlots = await tx.slotOfAppointment.findMany({
      where: {
        ...seatFilter,
        user: { some: { id: abandonedUserId } },
      },
      select: { id: true },
    });
    for (const slot of seatSlots) {
      await tx.slotOfAppointment.update({
        where: { id: slot.id },
        data: { user: { disconnect: { id: abandonedUserId } } },
      });
    }
    console.log(
      `🗑️ Released ${seatSlots.length} seat slot(s) for user ${abandonedUserId} on ${kind} appointment ${appointment.id}`,
    );
  }
}

/**
 * Consultation / subscription: with no confirmed slot left, the request is
 * EXPIRED through the CAS and everything under it is tombstoned; with one, only
 * the tentative holds are released and the confirmed history stays.
 *
 * #1074 / #1319 — never delete an Appointment a Payment row points at. Deleting
 * the request cascaded the Appointment and with it every Payment (EXPIRED
 * intents, credit usage, a late capture's target). The slot is freed by status,
 * not absence.
 *
 * A CAS miss throws out of the caller's transaction on purpose: the payment
 * expiry and the credit restoration that ran ahead of it must roll back with it.
 */
async function expireRequestAndReleaseSlots(
  tx: Pick<
    Tx,
    | "slotOfAppointment"
    | "appointment"
    | "consultation"
    | "subscription"
    | "bookingStatusHistory"
  >,
  appointment: AbandonedAppointment,
): Promise<void> {
  const kind = appointment.consultation ? "consultation" : "subscription";
  const confirmedSlots = await tx.slotOfAppointment.count({
    where: {
      appointmentId: appointment.id,
      isTentative: false,
    },
  });
  const now = new Date();

  if (confirmedSlots > 0) {
    // Only release the tentative slots; confirmed history stays.
    const released = await transitionSlotCompletion(tx, {
      where: {
        appointmentId: appointment.id,
        isTentative: true,
        deletedAt: null,
      },
      to: SlotCompletionStatus.CANCELLED,
      data: { deletedAt: now },
      allowZero: true,
    });
    console.log(
      `🗑️ Released ${released} tentative slot(s) for ${kind} appointment: ${appointment.id}`,
    );
    return;
  }

  // The cohort's money predicate is repeated in the CAS WHERE, like the
  // approval and stale-pending arms. Status alone is not enough: the include
  // above only carries PENDING rows, and `reconcile-payment-status` flips a
  // recovered capture to SUCCEEDED without moving the request — so a sibling
  // or freshly-succeeded payment is invisible to a read-then-write. Re-checked
  // by the UPDATE itself, a paid booking matches zero rows and is skipped.
  if (appointment.consultation) {
    await transitionConsultationRequest(tx, {
      where: {
        id: appointment.consultation.id,
        appointment: {
          payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
        },
      },
      to: AppointmentStatus.EXPIRED,
    });
  } else if (appointment.subscription) {
    // Subscription→Appointment is to-many (one per session), so the predicate
    // is "no appointment under this subscription carries a succeeded payment".
    await transitionSubscriptionRequest(tx, {
      where: {
        id: appointment.subscription.id,
        appointments: {
          none: {
            payment: { some: { paymentStatus: PaymentStatus.SUCCEEDED } },
          },
        },
      },
      to: AppointmentStatus.EXPIRED,
    });
  }

  await transitionSlotCompletion(tx, {
    where: { appointmentId: appointment.id, deletedAt: null },
    to: SlotCompletionStatus.CANCELLED,
    data: { deletedAt: now },
    allowZero: true,
  });
  await tx.appointment.updateMany({
    where: { id: appointment.id, deletedAt: null },
    data: { deletedAt: now },
  });

  console.log(
    `🗑️ Expired abandoned ${kind} appointment (soft): ${appointment.id}`,
  );
}

/**
 * One appointment, one transaction: skip a capture that landed mid-sweep,
 * expire its payments, hand back the referral credits, then release the hold —
 * group seats for an event, request slots for a consultation or subscription.
 *
 * The CAS miss is caught OUTSIDE the transaction (the stale-pending sweep's
 * shape). Swallowing it inside would resolve the callback and commit the
 * payment expiry and credit restoration that ran before it, handing credits
 * back on a booking whose capture landed mid-transaction. Letting it escape
 * makes Prisma roll the whole unit back; only then is it counted as skipped.
 */
async function cleanupAbandonedAppointment(
  appointment: AbandonedAppointment,
  failures: FailureSink,
): Promise<"cleaned" | "skipped"> {
  try {
    return await prisma.$transaction(async (tx) => {
      if (await anyPaymentSucceeded(tx, appointment)) return "skipped" as const;

      await expirePendingPayments(tx, appointment.payment, failures);
      await restoreReferralCredits(tx, appointment.payment);

      if (appointment.webinar || appointment.class) {
        await releaseGroupSeats(tx, appointment);
        return "cleaned" as const;
      }
      if (appointment.consultation || appointment.subscription) {
        await expireRequestAndReleaseSlots(tx, appointment);
      }
      return "cleaned" as const;
    });
  } catch (error) {
    // Raced a capture or an approval: the row moved out of the expirable set,
    // or its payment succeeded, since the cohort read. The transaction is
    // rolled back by the time this runs — nothing above it was committed.
    if (!(error instanceof IllegalTransitionError)) throw error;
    console.log(
      `⏭️ Skipped appointment ${appointment.id} — status changed, or the payment succeeded, since the sweep read`,
    );
    return "skipped";
  }
}

/**
 * Clean up abandoned payments and appointments
 *
 * Finds appointments with:
 * - Pending payments that have expired (or legacy payments older than 35 min)
 * - Tentative slots that need to be released
 *
 * @returns CleanupResult with counts and error details
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function cleanupAbandonedPayments(
  opts: CleanupAbandonedOptions = {},
): Promise<CleanupResult> {
  return withCronLock(
    "cleanup-abandoned-payments",
    { failMode: "closed" },
    () => cleanupAbandonedPaymentsUnlocked(opts),
  );
}

async function cleanupAbandonedPaymentsUnlocked(
  opts: CleanupAbandonedOptions = {},
): Promise<CleanupResult> {
  console.log("🧹 Starting abandoned payment cleanup...");
  stripeFenceLogged = false;

  const result: CleanupResult = {
    success: false,
    cleanedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    totalProcessed: 0,
    errors: [],
  };

  try {
    const abandonedAppointments = await findAbandonedAppointments(opts.limit);

    result.totalProcessed = abandonedAppointments.length;
    console.log(
      `📊 Found ${abandonedAppointments.length} abandoned appointments to clean up`,
    );

    for (const appointment of abandonedAppointments) {
      // #1464 — per appointment, so the gateway failures counted below belong
      // to this one and are not added again for the next.
      const failures: FailureSink = { messages: result.errors, count: 0 };
      try {
        const outcome = await cleanupAbandonedAppointment(
          appointment,
          failures,
        );

        // A gateway cancel that failed fails the run even though the row was
        // still expired and its hold released: the intent may still be live at
        // the gateway, which is something an operator has to see.
        result.errorCount += failures.count;

        if (outcome === "skipped") {
          result.skippedCount++;
        } else {
          result.cleanedCount++;
          console.log(
            `✅ Successfully cleaned up appointment: ${appointment.id}`,
          );
        }
      } catch (error) {
        // Both: a gateway cancel that failed pushed its own line into
        // `errors`, so the count has to match or the summary contradicts the
        // list it prints.
        result.errorCount += failures.count + 1;
        const errorMessage = describeError(error);
        console.error(
          `❌ Failed to clean up appointment ${appointment.id}:`,
          errorMessage,
        );
        result.errors.push(
          `Appointment cleanup failed for ${appointment.id}: ${errorMessage}`,
        );
      }
    }

    result.success = result.errorCount === 0;
    logCleanupSummary("Cleanup Summary", "appointments", result);
  } catch (error) {
    const errorMessage = describeError(error);
    console.error("❌ Cleanup job failed:", errorMessage);
    result.errors.push(`Job failed: ${errorMessage}`);
    result.success = false;
  }

  return result;
}

/**
 * Cleanup expired APPROVED_PENDING_PAYMENT consultations
 *
 * FIX for orphaned payment bug:
 * When a consultant approves a consultation and payment expires,
 * the consultation status remains APPROVED_PENDING_PAYMENT forever,
 * blocking the slot permanently. This function resets those consultations.
 *
 * @returns CleanupResult with counts and error details
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function cleanupExpiredApprovalPendingPayments(
  opts: CleanupAbandonedOptions = {},
): Promise<CleanupResult> {
  return withCronLock(
    "cleanup-abandoned-payments",
    { failMode: "closed" },
    () => cleanupExpiredApprovalPendingPaymentsUnlocked(opts),
  );
}

async function cleanupExpiredApprovalPendingPaymentsUnlocked(
  opts: CleanupAbandonedOptions = {},
): Promise<CleanupResult> {
  console.log(
    "🧹 Starting cleanup of expired APPROVED_PENDING_PAYMENT consultations...",
  );

  const result: CleanupResult = {
    success: false,
    cleanedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    totalProcessed: 0,
    errors: [],
  };

  try {
    // Find consultations stuck in APPROVED_PENDING_PAYMENT with expired payments
    const expiredConsultations = await prisma.consultation.findMany({
      take: opts.limit,
      // Oldest-first with an id tie-break: see findAbandonedAppointments above.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      where: {
        status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
        appointment: {
          payment: {
            some: {
              AND: [
                { paymentStatus: PaymentStatus.PENDING },
                { expiresAt: { lt: new Date() } },
              ],
            },
          },
        },
      },
      include: {
        appointment: {
          include: {
            payment: {
              where: { paymentStatus: PaymentStatus.PENDING },
            },
            slotsOfAppointment: true,
          },
        },
      },
    });

    result.totalProcessed = expiredConsultations.length;
    console.log(
      `📊 Found ${expiredConsultations.length} expired APPROVED_PENDING_PAYMENT consultations`,
    );

    // Process each expired consultation
    for (const consultation of expiredConsultations) {
      try {
        const outcome = await prisma.$transaction(async (tx) => {
          // #1319 — the pay-link lapsed, so this is EXPIRED, not REJECTED:
          // REJECTED reads as "the consultant declined" on every surface, and
          // the CAS keeps a capture that raced this sweep from being clobbered.
          try {
            // The cohort read's payment filter is repeated in the UPDATE's
            // WHERE: a capture that landed since the read (Stripe reconcile
            // flips the payment without touching the request) makes this
            // match zero rows instead of expiring a paid booking.
            await transitionConsultationRequest(tx, {
              where: {
                id: consultation.id,
                appointment: {
                  payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
                },
              },
              to: AppointmentStatus.EXPIRED,
              fromIn: [AppointmentStatus.APPROVED_PENDING_PAYMENT],
            });
          } catch (error) {
            if (!(error instanceof IllegalTransitionError)) throw error;
            console.log(
              `⏭️ Skipped consultation ${consultation.id} — status changed since the sweep read`,
            );
            return "skipped" as const;
          }

          // Release the tentative hold by status; the rows stay for support.
          if (consultation.appointment) {
            const released = await transitionSlotCompletion(tx, {
              where: {
                appointmentId: consultation.appointment.id,
                isTentative: true,
                deletedAt: null,
              },
              to: SlotCompletionStatus.CANCELLED,
              data: { deletedAt: new Date() },
              allowZero: true,
            });
            console.log(
              `🗑️ Released ${released} tentative slot(s) for consultation ${consultation.id}`,
            );
          }

          // Mark expired payments as EXPIRED (timed out, not a gateway rejection)
          if (consultation.appointment?.payment) {
            for (const payment of consultation.appointment.payment) {
              // Conditional: only a still-PENDING row expires; a capture that
              // raced this write keeps its SUCCEEDED status.
              await tx.payment.updateMany({
                where: { id: payment.id, paymentStatus: PaymentStatus.PENDING },
                data: { paymentStatus: PaymentStatus.EXPIRED },
              });
            }
          }

          console.log(
            `✅ Reset consultation ${consultation.id} from APPROVED_PENDING_PAYMENT to EXPIRED`,
          );
          return "cleaned" as const;
        });

        if (outcome === "skipped") {
          result.skippedCount++;
        } else {
          result.cleanedCount++;
        }
      } catch (error) {
        result.errorCount++;
        const errorMessage = describeError(error);
        console.error(
          `❌ Failed to clean up consultation ${consultation.id}:`,
          errorMessage,
        );
        result.errors.push(
          `Consultation cleanup failed for ${consultation.id}: ${errorMessage}`,
        );
      }
    }

    result.success = result.errorCount === 0;
    logCleanupSummary(
      "Expired Consultation Cleanup Summary",
      "consultations",
      result,
    );
  } catch (error) {
    const errorMessage = describeError(error);
    console.error("❌ Expired consultation cleanup failed:", errorMessage);
    result.errors.push(`Job failed: ${errorMessage}`);
    result.success = false;
  }

  return result;
}

/**
 * Run all cleanup tasks
 *
 * Executes both abandoned payment cleanup and expired consultation cleanup.
 * Disconnects from database when complete.
 *
 * @returns Combined results from both cleanup operations
 */
export async function runAllCleanupTasks(): Promise<{
  paymentResult: CleanupResult;
  consultationResult: CleanupResult;
  overallSuccess: boolean;
}> {
  const startTime = Date.now();
  console.log(`🚀 Starting cleanup job at ${new Date().toISOString()}`);

  try {
    // Run abandoned payment cleanup
    const paymentResult = await cleanupAbandonedPayments();

    // Run expired consultation cleanup
    const consultationResult = await cleanupExpiredApprovalPendingPayments();

    const duration = (Date.now() - startTime) / 1000;
    console.log(`⏱️ Job completed in ${duration.toFixed(2)} seconds`);

    // Combined summary
    console.log(`\n📊 Overall Cleanup Summary:`);
    console.log(
      `   🧹 Abandoned payments cleaned: ${paymentResult.cleanedCount}`,
    );
    console.log(
      `   🧹 Expired consultations reset: ${consultationResult.cleanedCount}`,
    );
    console.log(
      `   ❌ Total errors: ${paymentResult.errorCount + consultationResult.errorCount}`,
    );

    const overallSuccess = paymentResult.success && consultationResult.success;

    return {
      paymentResult,
      consultationResult,
      overallSuccess,
    };
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
    .then(({ overallSuccess }) => {
      if (overallSuccess) {
        console.log("🎉 Cleanup job completed successfully");
        process.exit(0);
      } else {
        console.error("❌ Cleanup job completed with errors");
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error("💥 Cleanup job failed:", error);
      process.exit(1);
    });
}
