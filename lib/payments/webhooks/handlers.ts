/**
 * Payment Webhook Handlers
 * Core business logic for processing payment events
 * Can be used by both webhook API routes and direct checkout flows
 */

import {
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";
import {
  recordParticipants,
  setParticipantStatus,
} from "@/lib/booking/participants";
import prisma, { type Tx } from "@/lib/prisma";
import {
  AppointmentsType,
  PaymentStatus,
  Prisma,
  AppointmentStatus,
  SlotCompletionStatus,
  TrialSessionStatus,
} from "@prisma/client";
import { calculateSubscriptionEndDate } from "@/utils/dateUtils";
import { buildOccupiedAppointmentFilter } from "@/utils/slotAllocation/occupancyPolicy";
import {
  REQUEST_ALLOWED_FROM,
  EVENT_ALLOWED_FROM,
  CLASS_EVENT_ALLOWED_FROM,
  transitionSlotCompletion,
} from "@/lib/booking/transitions";
import { isExclusionViolation } from "@/lib/db/pg-errors";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { resolveSchedulingTimezone } from "@/lib/scheduling/schedulingTimezone";
import {
  assertSingleContiguousLiveRun,
  buildContiguousSlotAtomsForWindow,
} from "@/lib/appointments/contiguous-slot-run";
import { connectAttendeeToEventSlots } from "@/lib/appointments/attendee-seats";
import { recordSystemError } from "@/lib/enterprise/system-events";
import { refundPayment } from "@/lib/payments/operations/refund";
import { mintConsumerInvoiceBestEffort } from "@/lib/payments/billing/consumer-invoice";
import {
  normalizeLegacySlotKeys,
  validateWebhookMetadata,
} from "@/schemas/webhooks/metadata";
import { ZodError } from "zod";
import { sendPaymentSuccessEmail, sendPaymentFailedEmail } from "@/lib/email";
import {
  createEarningsFromPayment,
  resolvePaymentForEarnings,
} from "@/lib/payments/payouts";
import {
  notifyPaymentSuccess,
  notifyPaymentFailed,
  notifyAppointmentBooked,
} from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import {
  processQualifyingAction,
  processConsultantBookingReferral,
} from "@/lib/referrals/service";
import { ensureChannelsForAppointment } from "@/lib/payments/webhooks/ensure-channels";
import { streamLogger } from "@/lib/stream-logger";
import { getAppUrl } from "@/lib/url";

/**
 * Sentence-case label for a raw AppointmentsType, used by buyer-facing copy
 * that has no plan title to name (#1484). Deliberately not exhaustive over the
 * enum via a Record: an appointment type added later should degrade to
 * "Appointment" rather than fail the build in a notification path.
 */
function humaniseAppointmentType(appointmentType: string): string {
  switch (appointmentType) {
    case AppointmentsType.CONSULTATION:
      return "Consultation";
    case AppointmentsType.SUBSCRIPTION:
      return "Subscription";
    case AppointmentsType.WEBINAR:
      return "Webinar";
    case AppointmentsType.CLASS:
      return "Class";
    case AppointmentsType.TRIAL:
      return "Trial session";
    default:
      return "Appointment";
  }
}

// ============================================================================
// Type Definitions
// ============================================================================

// #780/#781 — the extended client converts every BigInt column (and the FX
// Decimal snapshots) to number on read, but GetPayload (incl. nested
// includes) still says bigint/Decimal. Deep-map to match runtime;
// Date/Bytes pass through untouched.
type MoneyAsNumber<T> = T extends bigint
  ? number
  : T extends Prisma.Decimal
    ? number
    : T extends Date | Uint8Array
      ? T
      : T extends Array<infer U>
        ? Array<MoneyAsNumber<U>>
        : T extends object
          ? { [K in keyof T]: MoneyAsNumber<T[K]> }
          : T;

/**
 * Payment type with user and consultee profile included
 * Matches the Prisma query includes used in handlePaymentSuccess
 */
type PaymentWithUser = MoneyAsNumber<
  Prisma.PaymentGetPayload<{
    include: {
      user: {
        include: { consulteeProfile: true };
      };
    };
  }>
>;

/**
 * Data required to create a consultation appointment
 */
interface ConsultationData {
  planId: string;
  startsAt: string;
  endsAt: string;
  notes?: string;
  consulteeProfileId: string;
  userId: string;
}

/**
 * Data required to create a subscription appointment
 */
interface SubscriptionData {
  planId: string;
  startsAt?: string;
  endsAt?: string;
  schedulingPeriodStartsAt?: string;
  schedulingPeriodEndsAt?: string;
  notes?: string;
  consulteeProfileId: string;
  userId: string;
}

/**
 * Data required to create webinar/class appointments
 */
interface EventData {
  eventId: string;
  userId: string;
}

// ============================================================================
// Payment Success/Failure Handlers
// ============================================================================

/**
 * Handle successful payment - confirms or creates appointments
 *
 * TWO FLOWS SUPPORTED:
 * 1. NEW FLOW (Race Condition Fix): Appointment created during checkout (tentative)
 *    - payment.appointmentId exists
 *    - Just confirm appointment by setting isTentative = false
 *    - This prevents race conditions by making validation see tentative bookings
 *
 * 2. LEGACY FLOW: Appointment NOT created during checkout
 *    - payment.appointmentId is null
 *    - Create appointment from webhook metadata
 *    - Used for backwards compatibility and older payment flows
 *
 * Used by both webhook handlers and mock payment flows
 */
// #837 — discriminated Phase-1 outcomes so Phase 2 can auto-refund the two
// captured-but-blocked cases (amount mismatch, double-booking loser) instead of
// parking the funds on manual ops. `null` = already-processed / metadata-fail.
type PaymentSuccessTxResult =
  | {
      outcome: "amount_mismatch";
      paymentId: string;
      gatewayAmountPaise: number;
      expectedAmount: number;
    }
  | {
      outcome: "confirmed";
      paymentId: string;
      appointmentId: string;
      appointmentType: string;
      userId: string;
      userName: string | null;
      amount: number;
      currency: string;
      capturedAfterTerminal: boolean;
      doubleBookingBlocked: boolean;
    };

/**
 * #1446 — Phase 2 runs inside `after()`, on the same warm instance that is
 * already serving the next inbound request, and PG_POOL_MAX=1 means the two
 * share one Prisma connection. Two unawaited 39 s Novu triggers held the event
 * loop and the socket while the chat-channel step waited for that connection
 * and died at the 3 s connect timeout. So every outbound Phase-2 step is
 * bounded and the notifications are awaited before the channel read begins.
 * Money is committed by this point, so a step that runs out of time is dropped
 * rather than retried inline: the reconcile sweep re-drives what is durable.
 */
const PHASE_2_DEADLINE_MS = 5_000;

/**
 * Resolve to `undefined` when `work` outlives the deadline, never throwing for
 * the timeout itself. The underlying call is not cancelled — nothing here can
 * cancel a socket — it is simply no longer waited on, which is what keeps the
 * connection free for the step behind it.
 */
async function withPhase2Deadline<T>(
  work: Promise<T>,
  label: string,
  ms: number = PHASE_2_DEADLINE_MS,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      console.warn(
        `⚠️ Phase 2 step exceeded its ${ms}ms deadline and was abandoned: ${label}`,
      );
      resolve(undefined);
    }, ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Report a capture that landed on a payment which is no longer PENDING.
 *
 * Every status stamp below rides a CAS (`updateMany` with `paymentStatus` in
 * the WHERE), so a zero count means the row reached a terminal state — EXPIRED,
 * FAILED or SUCCEEDED — before this webhook arrived. The caller writes nothing
 * and still acknowledges the delivery; this records the evidence an operator
 * needs to reconcile the captured funds by hand.
 *
 * The status is re-read rather than taken from the caller's pre-read, following
 * the same doctrine confirmApprovalStatus already applies below (#844): the
 * pre-read can have raced the very transition that made the CAS miss, and the
 * state named in this report is what an operator reconciles against. Callers
 * pass their own client — `tx` inside the Serializable transaction, `prisma`
 * for the post-rollback GiST branch — because a global-client read inside a
 * transaction deadlocks on a single-connection pool (#1435).
 */
async function reportTerminalCaptureRace(params: {
  db: Tx | typeof prisma;
  paymentId: string;
  orderId: string;
  /** Pre-read status; used only when the re-read finds nothing. */
  observedStatus: PaymentStatus;
  reason: string;
}): Promise<void> {
  const fresh = await params.db.payment.findUnique({
    where: { id: params.paymentId },
    select: { paymentStatus: true },
  });
  const currentStatus = fresh?.paymentStatus ?? params.observedStatus;
  void recordSystemError({
    organizationId: null,
    category: "PAYMENT",
    summary: `Capture for order ${params.orderId} landed on a ${currentStatus} payment — status left alone, refund by hand`,
    err: new Error("CAPTURE_AFTER_TERMINAL_PAYMENT"),
    context: {
      paymentId: params.paymentId,
      orderId: params.orderId,
      currentStatus,
      reason: params.reason,
    },
  }).catch(() => {});
  reportSentryMessage(
    "Capture landed on a terminal payment — status not restamped",
    {
      subsystem: "payments",
      level: "warning",
      extra: {
        paymentId: params.paymentId,
        orderId: params.orderId,
        currentStatus,
        reason: params.reason,
      },
    },
  );
}

export async function handlePaymentSuccess(
  paymentIntentId: string,
  rawMetadata: Record<string, string>,
  gatewayAmountPaise?: number,
  gatewayPaymentId?: string,
): Promise<void> {
  // #679 transition dual-read (see normalizeLegacySlotKeys) — in-flight
  // Razorpay orders created pre-rename replay webhooks with legacy slot
  // keys; normalize ONCE here so validation AND the legacy create flow
  // read the same new-key shape.
  const metadata = normalizeLegacySlotKeys(rawMetadata);
  // #1353 — the gateway's `pay_…` id is persisted by THIS pipeline and nowhere
  // else, because Phase 1 is already the single writer of the Payment row's
  // capture truth (ADR 21) and the id is part of that truth. Spread rather than
  // assigned unconditionally: `order.paid` carries no payment id, and writing
  // `undefined` from that path would erase an id a `payment.captured` had
  // already recorded.
  const capturedGatewayId = gatewayPaymentId ? { gatewayPaymentId } : {};
  // C1 FIX: Split into two phases:
  //   Phase 1 (transaction): Critical payment + appointment processing
  //   Phase 2 (post-tx): Earnings, invoice, notifications
  //
  // Previously, earnings/invoice creation used the global `prisma` client
  // inside the transaction, meaning they ran outside isolation but errors
  // were swallowed. Now they run explicitly post-transaction with proper
  // error logging. The `sync-payment-earnings` background job serves as
  // a safety net for any failures in Phase 2.

  // Phase 1: Critical transaction — payment confirmation + appointment.
  // Serializable (#827 review): two concurrent capture webhooks for
  // overlapping slots both pass the confirm-time conflict findFirst at READ
  // COMMITTED (each sees the other's slots still tentative). Under SSI the
  // rw-antidependency aborts one side with P2034; the retry then sees the
  // winner confirmed and blocks. The SUCCEEDED early-return keeps the retry
  // idempotent.
  let txResult: PaymentSuccessTxResult | null;
  try {
    txResult = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx): Promise<PaymentSuccessTxResult | null> => {
          const payment = await tx.payment.findUnique({
            where: { paymentIntent: paymentIntentId },
            include: { user: { include: { consulteeProfile: true } } },
          });

          if (!payment) {
            const err = new Error(
              `Payment record not found for intent: ${paymentIntentId}`,
            );
            reportSentryError(err, { subsystem: "payments" });
            throw err;
          }

          if (payment.paymentStatus === PaymentStatus.SUCCEEDED) {
            console.log(
              `Payment ${paymentIntentId} has already been processed.`,
            );
            // Idempotency short-circuit — a redelivered webhook. The system
            // working as designed.
            reportSentryMessage("Payment webhook idempotency short-circuit", {
              subsystem: "payments",
              expected: true,
              extra: { paymentIntentId },
            });
            return null; // Signal: already processed, skip Phase 2
          }

          // #677 — defence-in-depth amount parity (mirrors handleOrgPaymentSuccess).
          // The gateway order is created at checkout for exactly Payment.amount and the
          // webhook is HMAC-verified, so a captured amount that differs is a gateway
          // anomaly or our-own bug — never silently confirm a booking for the wrong
          // money. Mark for manual recovery + page (like the metadata-failure path) and
          // skip confirmation; the captured funds are reconciled by hand.
          if (
            gatewayAmountPaise !== undefined &&
            gatewayAmountPaise !== payment.amount
          ) {
            reportSentryError(
              new Error(
                `Capture amount mismatch for ${paymentIntentId}: gateway=${gatewayAmountPaise} expected=${payment.amount}`,
              ),
              {
                subsystem: "payments",
                level: "fatal",
                contexts: {
                  payment: {
                    paymentIntentId,
                    paymentId: payment.id,
                    userId: payment.userId,
                  },
                },
              },
            );
            // #837 — mark SUCCEEDED (gateway truth) + stamp REQUIRES_MANUAL_RECOVERY as
            // the FALLBACK. Phase 2 auto-refunds the wrong-amount capture; the manual
            // marker only survives if that refund call itself throws.
            // #1439 — the stamp is a CAS: a late capture on an EXPIRED order
            // resurrected it to SUCCEEDED and its tentative hold leaked, so the
            // status rides the WHERE (ADR 21). Count 0 = already terminal:
            // write nothing, report, and still acknowledge the webhook.
            const stamped = await tx.payment.updateMany({
              where: { id: payment.id, paymentStatus: PaymentStatus.PENDING },
              data: {
                paymentStatus: PaymentStatus.SUCCEEDED,
                // #1353 — this branch auto-refunds in Phase 2, so it is the one
                // that MOST needs the id: the refund webhook that comes back
                // carries only `pay_…`, and without the column it cannot find
                // the Payment it is reversing.
                ...capturedGatewayId,
                description: `REQUIRES_MANUAL_RECOVERY: capture amount ${gatewayAmountPaise}p ≠ expected ${payment.amount}p. Booking NOT confirmed; auto-refund attempted.`,
              },
            });
            if (stamped.count === 0) {
              await reportTerminalCaptureRace({
                db: tx,
                paymentId: payment.id,
                orderId: paymentIntentId,
                observedStatus: payment.paymentStatus,
                reason: `capture amount ${gatewayAmountPaise}p ≠ expected ${payment.amount}p`,
              });
            }
            console.error(
              JSON.stringify({
                event: "CRITICAL_PAYMENT_AMOUNT_MISMATCH",
                alert_priority: "P1",
                payment_id: payment.id,
                payment_intent: paymentIntentId,
                user_id: payment.userId,
                gateway_amount_paise: gatewayAmountPaise,
                expected_amount_paise: payment.amount,
                action_required:
                  "auto-refund attempted; reconcile only if it failed",
                timestamp: new Date().toISOString(),
              }),
            );
            // Signal Phase 2 to auto-refund post-commit — the gateway refund call must
            // not run inside this Serializable tx.
            return {
              outcome: "amount_mismatch",
              paymentId: payment.id,
              gatewayAmountPaise,
              expectedAmount: payment.amount,
            };
          }

          // VALIDATION: Check metadata before processing
          try {
            validateWebhookMetadata(metadata);
          } catch (validationError) {
            const errorMessage =
              validationError instanceof ZodError
                ? validationError.errors
                    .map((e) => `${e.path.join(".")}: ${e.message}`)
                    .join("; ")
                : validationError instanceof Error
                  ? validationError.message
                  : String(validationError);

            reportSentryError(validationError, {
              subsystem: "payments",
              level: "fatal",
              contexts: {
                payment: {
                  paymentIntentId,
                  paymentId: payment.id,
                  userId: payment.userId,
                },
              },
            });
            console.error(
              `❌ Metadata validation failed for payment ${paymentIntentId}:`,
              errorMessage,
            );

            // FIX Issue #8: Enhanced alerting for metadata validation failures
            // This is a CRITICAL condition - customer charged but no appointment created!
            // #1439 — the stamp is a CAS: a late capture on an EXPIRED order
            // resurrected it to SUCCEEDED and its tentative hold leaked, so the
            // status rides the WHERE (ADR 21). Count 0 = already terminal:
            // write nothing, report, and still acknowledge the webhook.
            const recoveryStamped = await tx.payment.updateMany({
              where: { id: payment.id, paymentStatus: PaymentStatus.PENDING },
              data: {
                paymentStatus: PaymentStatus.SUCCEEDED,
                // #1353 — a manual recovery here usually ends in a refund; give
                // that refund's webhook the id it needs to match this row.
                ...capturedGatewayId,
                description: `REQUIRES_MANUAL_RECOVERY: Metadata validation failed: ${errorMessage}. Customer charged but appointment NOT created.`,
              },
            });
            if (recoveryStamped.count === 0) {
              await reportTerminalCaptureRace({
                db: tx,
                paymentId: payment.id,
                orderId: paymentIntentId,
                observedStatus: payment.paymentStatus,
                reason: `metadata validation failed: ${errorMessage}`,
              });
            }

            // CRITICAL ALERT - Log in structured format for monitoring systems
            console.error(
              JSON.stringify({
                event: "CRITICAL_PAYMENT_WITHOUT_APPOINTMENT",
                alert_priority: "P1",
                payment_id: payment.id,
                payment_intent: paymentIntentId,
                user_id: payment.userId,
                user_email: payment.user.email,
                amount: payment.amount,
                currency: payment.currency,
                error: errorMessage,
                action_required:
                  "IMMEDIATE: Manual appointment creation or full refund required",
                dashboard_url: `${getAppUrl()}/admin/payments/${payment.id}`,
                timestamp: new Date().toISOString(),
              }),
            );

            console.error(
              `
================================================================================
                    CRITICAL ALERT: PAYMENT WITHOUT APPOINTMENT
================================================================================
Payment ID:      ${payment.id}
Payment Intent:  ${paymentIntentId}
User ID:         ${payment.userId}
User Email:      ${payment.user.email || "N/A"}
Amount:          ${payment.currency} ${payment.amount / 100}
Error:           ${errorMessage}

ACTION REQUIRED: Customer was charged but appointment was NOT created!
                 Either create appointment manually or issue full refund.
================================================================================
        `,
            );

            return null; // Exit early — requires manual intervention
          }

          // #1439 — the confirmation stamp is a CAS for the same reason as the
          // two recovery branches above, and it is the one a REPLAY now reaches
          // (the dev replay route used to fail metadata validation). Confirming
          // an EXPIRED payment would flip a hold the abandoned-payments sweep
          // has already released, so a terminal row is reported, not booked.
          const confirmed = await tx.payment.updateMany({
            where: { id: payment.id, paymentStatus: PaymentStatus.PENDING },
            data: {
              paymentStatus: PaymentStatus.SUCCEEDED,
              ...capturedGatewayId,
            },
          });
          if (confirmed.count === 0) {
            await reportTerminalCaptureRace({
              db: tx,
              paymentId: payment.id,
              orderId: paymentIntentId,
              observedStatus: payment.paymentStatus,
              reason:
                "capture arrived after the payment reached a terminal state",
            });
            return null; // Signal: nothing to confirm, skip Phase 2
          }

          let appointment;
          if (payment.appointmentId) {
            // NEW FLOW: Appointment already created during checkout (tentative)
            appointment = await tx.appointment.findUnique({
              where: { id: payment.appointmentId },
            });

            console.log(
              JSON.stringify({
                event: "webhook_confirming_existing_appointment",
                paymentIntent: paymentIntentId,
                appointmentId: payment.appointmentId,
                timestamp: new Date().toISOString(),
              }),
            );
          } else {
            // LEGACY FLOW: Appointment not created during checkout
            appointment = await createAppointmentFromWebhook(
              tx,
              metadata,
              payment,
            );

            console.log(
              JSON.stringify({
                event: "webhook_creating_new_appointment",
                paymentIntent: paymentIntentId,
                appointmentId: appointment.id,
                appointmentType: metadata.appointmentType,
                timestamp: new Date().toISOString(),
              }),
            );
          }

          if (!appointment) {
            throw new Error("Failed to create or find appointment");
          }

          // Confirm appointment: set isTentative = false and update status to APPROVED
          const confirmResult = await confirmExistingAppointment(
            tx,
            appointment.id,
            payment.userId,
          );

          // TRIAL: the session is AWAITING_PAYMENT with its slot already held, so
          // capture is what schedules it. Scoped to AWAITING_PAYMENT via
          // updateMany so a re-delivered webhook is a no-op rather than
          // resurrecting a trial the learner cancelled or the expiry job closed.
          if (metadata.trialId) {
            const scheduled = await tx.trialSession.updateMany({
              where: {
                id: metadata.trialId,
                status: TrialSessionStatus.AWAITING_PAYMENT,
              },
              data: {
                status: TrialSessionStatus.SCHEDULED,
                paymentId: payment.id,
                pendingPaymentUrl: null,
                paymentDueAt: null,
              },
            });

            console.log(
              JSON.stringify({
                event: scheduled.count
                  ? "webhook_trial_scheduled"
                  : "webhook_trial_not_awaiting_payment",
                paymentIntent: paymentIntentId,
                trialId: metadata.trialId,
                timestamp: new Date().toISOString(),
              }),
            );
          }

          console.log(
            `✅ Payment ${paymentIntentId} processed successfully. Appointment ID: ${appointment.id}`,
          );

          // Return data needed for Phase 2
          return {
            outcome: "confirmed",
            paymentId: payment.id,
            appointmentId: appointment.id,
            appointmentType: metadata.appointmentType,
            userId: payment.userId,
            userName: payment.user.name,
            amount: payment.amount,
            currency: payment.currency,
            // #855 — a capture that landed after the booking was cancelled; Phase 2
            // auto-refunds it instead of treating it as a confirmed booking.
            capturedAfterTerminal: confirmResult.capturedAfterTerminal,
            // #837 — the #827 first-confirmed-wins guard blocked this booking; Phase 2
            // auto-refunds the loser and releases its tentative hold.
            doubleBookingBlocked: confirmResult.doubleBookingBlocked ?? false,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 15_000,
        },
      ),
    );
  } catch (err) {
    // B8b (booking-journey audit) — a LEGACY-shape capture (no appointmentId
    // in metadata, so checkout never pre-created the appointment) whose slot
    // chunks overlap an already-confirmed booking trips the #440 GiST
    // constraint inside the create. Left unhandled, that exception rolls back
    // the SUCCEEDED stamp above and the webhook is re-driven into the same
    // wall forever: gateway truth says captured, our ledger never agrees,
    // manual refund. Convert it here into the modelled outcome the #827
    // double-booking path already has — stamp SUCCEEDED outside the rolled-
    // back tx, then auto-refund below. (The NEW flow never hits this: its
    // confirm-time recheck returns doubleBookingBlocked in-tx instead.)
    if (!isExclusionViolation(err)) throw err;
    const loser = await prisma.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      select: { id: true, paymentStatus: true },
    });
    if (!loser) throw err;
    // Description stays HONEST at each step (CodeRabbit triage): "refund
    // pending" while the gateway call is in flight — if it fails, the record
    // must not claim money the buyer has not received. The success branch
    // below rewrites it to "Auto-refunded".
    // #1439 — third recovery stamp of the same shape, so it takes the same CAS.
    // The failed tx rolled the confirmation back, so the row is PENDING again
    // unless it went terminal underneath us; if it did, refundPayment would
    // reject it anyway (PAYMENT_NOT_SUCCEEDED), so report and stop.
    const restamped = await prisma.payment.updateMany({
      where: { id: loser.id, paymentStatus: PaymentStatus.PENDING },
      data: {
        paymentStatus: PaymentStatus.SUCCEEDED,
        // #1353 — the rolled-back tx took the id with it, and this branch
        // refunds immediately below; re-stamp it so that refund's webhook can
        // match the row.
        ...capturedGatewayId,
        description:
          "Refund pending: legacy-shape capture overlapped a confirmed booking (slot_no_confirmed_overlap) — booking NOT confirmed.",
      },
    });
    if (restamped.count === 0) {
      await reportTerminalCaptureRace({
        db: prisma,
        paymentId: loser.id,
        orderId: paymentIntentId,
        observedStatus: loser.paymentStatus,
        reason:
          "legacy-shape capture overlapped a confirmed booking (slot_no_confirmed_overlap)",
      });
      return;
    }
    void recordSystemError({
      organizationId: null,
      category: "PAYMENT",
      summary: `Legacy-shape capture ${paymentIntentId} overlapped a confirmed booking — auto-refunding`,
      err: err instanceof Error ? err : new Error(String(err)),
      context: { paymentIntentId, paymentId: loser.id },
    }).catch(() => {});
    try {
      await refundPayment({
        paymentId: loser.id,
        reason: "legacy capture overlapped a confirmed booking",
        initiatedByUserId: null,
      });
      await prisma.payment.update({
        where: { id: loser.id },
        data: {
          description:
            "Auto-refunded: legacy-shape capture overlapped a confirmed booking — booking NOT confirmed.",
        },
      });
    } catch (refundError) {
      reportSentryError(refundError, { subsystem: "payments" });
      console.error(
        "Failed to auto-refund GiST-overlap legacy capture; payment keeps its Refund-pending marker for manual recovery:",
        refundError,
      );
    }
    return;
  }

  // If transaction returned null, the payment was already processed or had a metadata error
  if (!txResult) return;

  // #837 — the gateway captured a different amount than we ordered. Auto-refund
  // the whole capture (never confirm a booking for the wrong money) and skip
  // Phase 2. REQUIRES_MANUAL_RECOVERY stays stamped as the fallback if the
  // refund throws. Idempotent: on webhook replay the payment is already
  // SUCCEEDED so the SUCCEEDED early-return fires before this path is reached,
  // and refundPayment's refundable-balance guard blocks any double-refund.
  if (txResult.outcome === "amount_mismatch") {
    try {
      await refundPayment({
        paymentId: txResult.paymentId,
        reason: "capture amount mismatch",
        initiatedByUserId: null,
      });
      // Refund succeeded — clear the Phase 1 REQUIRES_MANUAL_RECOVERY marker so
      // ops dashboards don't flag a payment that no longer needs manual recovery.
      await prisma.payment.update({
        where: { id: txResult.paymentId },
        data: {
          description: `Auto-refunded: capture amount ${txResult.gatewayAmountPaise}p ≠ expected ${txResult.expectedAmount}p. Booking NOT confirmed.`,
        },
      });
    } catch (refundError) {
      reportSentryError(refundError, {
        subsystem: "payments",
        contexts: {
          payment: {
            paymentId: txResult.paymentId,
            gatewayAmountPaise: txResult.gatewayAmountPaise,
            expectedAmount: txResult.expectedAmount,
          },
        },
      });
      console.error(
        "Failed to auto-refund amount-mismatch capture; REQUIRES_MANUAL_RECOVERY (Phase 2):",
        refundError,
      );
    }
    return;
  }

  // #855 — the capture landed after the booking was cancelled. The payment is
  // SUCCEEDED (gateway truth) but the booking is dead, so auto-refund and skip
  // the rest of Phase 2 — no success email, earnings, invoice, or notifications
  // for a cancelled booking. Idempotent against webhook replay (see refund.ts).
  if (txResult.capturedAfterTerminal) {
    try {
      await refundPayment({
        paymentId: txResult.paymentId,
        reason: "capture after cancellation",
        initiatedByUserId: null,
      });
    } catch (refundError) {
      reportSentryError(refundError, { subsystem: "payments" });
      console.error(
        "Failed to auto-refund capture-after-cancellation (Phase 2):",
        refundError,
      );
    }
    return;
  }

  // #837 — the #827 first-confirmed-wins guard blocked this booking: the payment
  // is SUCCEEDED but the slots lost to an overlapping confirmed booking, so
  // auto-refund and release the tentative hold (otherwise a paid customer holds
  // no booking and their slots block rebooking). Skip the rest of Phase 2 — no
  // earnings/invoice/notifications for a booking that never confirmed.
  // Idempotent: webhook replay hits the SUCCEEDED early-return before here;
  // refundPayment's refundable-balance guard blocks a double-refund; the slot
  // release runs after a successful refund so a refund failure leaves the hold
  // for the #830 orphan sweep + manual recovery rather than freeing it unpaid.
  if (txResult.doubleBookingBlocked) {
    try {
      await refundPayment({
        paymentId: txResult.paymentId,
        reason: "double-booking blocked at confirmation",
        initiatedByUserId: null,
      });
      // Release the tentative hold only once the money is back.
      await withSerializableRetry(() =>
        prisma.$transaction(
          (tx) => cleanupFailedPaymentAppointment(tx, txResult.appointmentId),
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 10_000,
            timeout: 15_000,
          },
        ),
      );
    } catch (refundError) {
      reportSentryError(refundError, {
        subsystem: "payments",
        contexts: {
          booking: {
            paymentId: txResult.paymentId,
            appointmentId: txResult.appointmentId,
          },
        },
      });
      console.error(
        "Failed to auto-refund double-booking loser; slots left for #830 sweep (Phase 2):",
        refundError,
      );
    }
    return;
  }

  // Phase 2: Non-critical post-transaction work (earnings, invoice, notifications)
  // Failures here are logged but do NOT roll back the payment.
  // The `sync-payment-earnings` and related background jobs serve as safety nets.

  // M5 FIX: Send payment success email in Phase 2 (post-commit) so a
  // transaction rollback cannot leave the user with a false confirmation.
  try {
    const paymentForEmail = await prisma.payment.findUnique({
      where: { id: txResult.paymentId },
      include: { user: { include: { consulteeProfile: true } } },
    });
    if (paymentForEmail) {
      await sendPaymentSuccessNotification(
        prisma,
        paymentForEmail as PaymentWithUser,
        txResult.appointmentId,
        txResult.appointmentType,
      );
    }
  } catch (emailError) {
    reportSentryError(emailError, { subsystem: "payments", level: "warning" });
    console.error(
      "Failed to send payment success email (Phase 2):",
      emailError,
    );
  }

  const { paymentId, appointmentId, userId, userName, amount, currency } =
    txResult;

  // --- Earnings creation ---
  try {
    const resolved = await resolvePaymentForEarnings(
      { id: paymentId },
      metadata.appointmentType,
    );

    if (resolved) {
      await createEarningsFromPayment({
        payment: resolved.paymentForEarnings,
        appointmentType: resolved.earningsAppointmentType,
      });

      console.log(
        `💰 Earnings record created for payment ${paymentId}, consultant ${resolved.consultantProfileId}`,
      );
    }
  } catch (earningsError) {
    // C-01 #837 — payment + booking are committed but earnings + the BOOKING
    // journal are not. Real money moved, so we don't roll back and we don't
    // pretend success with a silent warning: page (ERROR) and durably record
    // the ledger gap. The healer is the data-state sync-payment-earnings scan
    // (SUCCEEDED payment + earnings:none), keyed on row state — not on this
    // marker — so it's guaranteed and idempotent even if this alert is lost.
    await recordSystemError({
      category: "PAYOUT",
      summary: `Earnings + booking journal not written for committed payment ${paymentId} (webhook path)`,
      err: earningsError,
      correlationId: paymentId,
      context: { paymentId, appointmentId, userId, path: "webhook" },
    });
    console.error(
      `⚠️ Failed to create earnings for payment ${paymentId}:`,
      earningsError,
    );
  }

  // --- Referral qualifying action (first paid booking triggers both bonuses) ---
  // FIX #437: Process for the buyer (consultee) — their first paid booking qualifies their referral
  try {
    await processQualifyingAction(userId, "first_paid_booking");
  } catch (referralError) {
    reportSentryError(referralError, {
      subsystem: "payments",
      level: "warning",
    });
    console.error(
      `⚠️ Failed to process referral qualifying action for user ${userId}:`,
      referralError,
    );
  }

  // FIX #437: Also process for the consultant (service provider) — receiving their first
  // paid booking qualifies their referral too. This fixes the broken Consultant→Consultant
  // referral scenario where consultants never trigger qualification because they don't
  // make bookings, they receive them.
  try {
    await processConsultantBookingReferral({ id: paymentId }, userId);
  } catch (consultantReferralError) {
    reportSentryError(consultantReferralError, {
      subsystem: "payments",
      level: "warning",
    });
    console.error(
      `⚠️ Failed to process consultant referral qualifying action:`,
      consultantReferralError,
    );
  }

  // #1365 — the personal-consultee tax invoice the v0 lockdown (#768) removed.
  // The platform bills as principal supplier (ADR 26), so a consumer who was
  // charged 18% GST is owed a Rule 46 document; org-funded checkouts still roll
  // up into OrganizationInvoice and the mint no-ops for them by design.
  await mintConsumerInvoiceBestEffort({ paymentId });

  // --- Novu notifications (M5 FIX: moved outside transaction) ---
  try {
    // #734 — the notification only needs the consultant's id/name; the old
    // 4-level include dragged full User + profile rows for all four shapes.
    // #1484 widens it by exactly one scalar, the plan's own title, because this
    // is the only appointment read Phase 2 makes and the buyer's confirmation
    // has to name what they bought.
    const planNotifSelect = {
      select: {
        title: true,
        consultantProfile: {
          select: { user: { select: { id: true, name: true } } },
        },
      },
    } as const;
    const appointmentForNotif = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        // ADR 23 — the notification inherits the org-ness of the record that
        // triggered it, so both payloads below can be attributed and routed.
        organizationId: true,
        organization: { select: { name: true } },
        consultation: {
          select: { consultationPlan: planNotifSelect },
        },
        subscription: {
          select: { subscriptionPlan: planNotifSelect },
        },
        webinar: {
          select: { webinarPlan: planNotifSelect },
        },
        class: {
          select: { classPlan: planNotifSelect },
        },
      },
    });

    const consultantProfileData =
      appointmentForNotif?.consultation?.consultationPlan?.consultantProfile ||
      appointmentForNotif?.subscription?.subscriptionPlan?.consultantProfile ||
      appointmentForNotif?.webinar?.webinarPlan?.consultantProfile ||
      appointmentForNotif?.class?.classPlan?.consultantProfile;

    const consultantNameForNotif =
      consultantProfileData?.user?.name || "Consultant";
    const consultantUserId = consultantProfileData?.user?.id;

    // #1484 — name the thing that was bought. `metadata.planId` is an id and
    // sat on the left of the `||` at both payload sites below, so every normal
    // capture told the buyer they had purchased a UUID; the fallback it shadowed
    // returned `metadata.appointmentType` on BOTH branches of its ternary and so
    // could never be a plan name either. A TRIAL hangs off the parent
    // subscription plan, whose title names the paid programme, not the free
    // session — so it gets its own label rather than that plan's title.
    const resolvedPlanTitle =
      metadata.appointmentType === AppointmentsType.TRIAL
        ? "Trial session"
        : (appointmentForNotif?.consultation?.consultationPlan?.title ??
          appointmentForNotif?.subscription?.subscriptionPlan?.title ??
          appointmentForNotif?.webinar?.webinarPlan?.title ??
          appointmentForNotif?.class?.classPlan?.title ??
          humaniseAppointmentType(metadata.appointmentType));

    const orgId = appointmentForNotif?.organizationId ?? null;
    const scope = notificationScope(
      orgId,
      appointmentForNotif?.organization?.name,
    );
    // Org-hosted → the org route, which is right for every recipient of the
    // batched trigger below. B2C → the bare /dashboard router bounce, because
    // consultant and consultee land in different personal trees.
    const dashboardUrl = notificationHref(orgId, "appointments");

    // #1446 — collected, not fired and forgotten: they are awaited together
    // below, before the channel step touches the pool's only connection.
    const notifications: Promise<unknown>[] = [];

    // Notify consultee of successful payment
    notifications.push(
      Promise.resolve(
        notifyPaymentSuccess(userId, {
          ...scope,
          amount,
          currency,
          consultantName: consultantNameForNotif,
          appointmentType: metadata.appointmentType,
          planTitle: resolvedPlanTitle,
          dashboardUrl,
        }),
      ),
    );

    // Notify both consultant and consultee of the booked appointment
    const notifUserIds = [userId];
    if (consultantUserId && consultantUserId !== userId) {
      notifUserIds.push(consultantUserId);
    }

    // #1085 — the template renders a session time; omitting it left an empty
    // placeholder in the user's very first booking notification.
    const firstSlot = await prisma.slotOfAppointment.findFirst({
      where: { appointmentId },
      orderBy: { startsAt: "asc" },
      select: { startsAt: true },
    });
    // B9 (booking-journey audit) — APPOINTMENT_BOOKED names a TIME. For a
    // subscription placeholder (paid, zero slots until the consultant
    // allocates) there is no time, and the Novu template rendered a blank
    // date placeholder as the payer's very first booking message.
    // notifyPaymentSuccess above already told them the purchase worked, so
    // the booked-with-time ping is deferred to allocation (PR 2c wires that
    // notification). Template-side rendering stays a Novu dashboard concern
    // (#1085 precedent).
    if (!firstSlot?.startsAt) {
      console.log(
        JSON.stringify({
          event: "appointment_booked_notification_skipped_no_slots",
          appointmentId,
          paymentId: paymentId,
          timestamp: new Date().toISOString(),
        }),
      );
    } else {
      // Money-hardening pass — Promise.resolve guards against non-promise
      // returns (Novu wrappers swallow internally; test doubles return
      // undefined), so a synchronous throw can't become an unhandled
      // rejection inside this handler.
      notifications.push(
        Promise.resolve(
          notifyAppointmentBooked(notifUserIds, {
            ...scope,
            appointmentId,
            dateTime: firstSlot.startsAt.toISOString(),
            appointmentType: metadata.appointmentType,
            consultantName: consultantNameForNotif,
            consulteeName: userName || "User",
            planTitle: resolvedPlanTitle,
            dashboardUrl,
          }),
        ),
      );
    }

    // #1446 — best-effort still, but bounded and finished BEFORE the channel
    // step: `allSettled` swallows a rejected trigger (the Novu wrappers already
    // log and report it) and the deadline drops one that hangs.
    await Promise.allSettled(
      notifications.map((notification, i) =>
        withPhase2Deadline(notification, `novu-trigger[${i}] ${paymentId}`),
      ),
    );
  } catch (novuError) {
    reportSentryError(novuError, { subsystem: "payments", level: "warning" });
    console.error(
      `⚠️ Failed to send Novu notifications for payment ${paymentId}:`,
      novuError,
    );
  }

  // --- Stream channel creation (truly fire-and-forget — does not block webhook response) ---
  //
  // #1356 — the work itself moved to `ensureChannelsForAppointment`, which
  // stamps `Appointment.chatChannelEnsuredAt` on success. The call stays here,
  // in the same post-commit position and with the same fire-and-forget posture,
  // for the same reason as before: it is outbound network work. What changed is
  // that failing it now leaves a trace — a confirmed appointment with a NULL
  // stamp — which reconcile-orphaned-confirmations re-drives instead of the
  // buyer silently never having a chat.
  void (async () => {
    try {
      // #1446 — the step opens with a DB read, so it is the first thing to die
      // when the single connection is busy. Bounded: on timeout
      // `chatChannelEnsuredAt` stays NULL, which is exactly the queue that
      // reconcile-orphaned-confirmations drains.
      const result = await withPhase2Deadline(
        ensureChannelsForAppointment(appointmentId),
        `ensureChannelsForAppointment(${appointmentId})`,
      );
      if (!result) {
        streamLogger.warn(
          "Stream channel step hit its deadline — stamp left NULL for the reconcile sweep",
          { appointmentId, userId, deadlineMs: PHASE_2_DEADLINE_MS },
        );
        return;
      }
      if (!result.ensured) {
        streamLogger.warn(
          "Stream channels not ensured on payment success — left for the reconcile sweep",
          { appointmentId, userId, reason: result.reason },
        );
      }
    } catch (channelError) {
      // #1134 P1-15 — this used to say "sync job will catch up". No such job
      // exists: `stream-sync` only DELETES stale Stream users, and
      // syncUserEventChannels repairs webinar/class/DM membership on the next
      // dashboard load but cannot invent a channel for a booking it never saw.
      // A failure here means the buyer silently has no chat, so it must at
      // least page. The reconcile sweep is now the durable re-drive.
      reportSentryError(channelError, {
        subsystem: "stream",
        op: "handlePaymentSuccess.createChannels",
        extra: { appointmentId, userId },
      });
      streamLogger.error(
        "Auto-channel creation failed on payment success — buyer has no chat",
        channelError,
        { appointmentId, userId },
      );
    }
  })();
}

/**
 * Handle failed payment - cleans up tentative appointments
 */
export async function handlePaymentFailure(paymentIntentId: string) {
  return await prisma.$transaction(async (tx) => {
    // #734 — narrowed from a 5-level include; the failure path only reads
    // the payer's email/name and the consultant's name for notifications.
    const consultantUserSelect = {
      select: {
        consultantProfile: {
          select: { user: { select: { id: true, name: true } } },
        },
      },
    } as const;
    const payment = await tx.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      select: {
        id: true,
        paymentStatus: true,
        userId: true,
        appointmentId: true,
        amount: true,
        currency: true,
        description: true,
        user: { select: { email: true, name: true } },
        appointment: {
          select: {
            id: true,
            appointmentType: true,
            consultation: {
              select: { consultationPlan: consultantUserSelect },
            },
            subscription: {
              select: { subscriptionPlan: consultantUserSelect },
            },
          },
        },
      },
    });

    if (!payment) {
      console.warn(
        `Payment record not found for failed intent: ${paymentIntentId}`,
      );
      reportSentryMessage("Payment failure webhook: payment not found", {
        subsystem: "payments",
        level: "warning",
        extra: { paymentIntentId },
      });
      return;
    }

    // FIX Issue #8: Idempotency check - prevent duplicate processing
    if (payment.paymentStatus === PaymentStatus.FAILED) {
      console.log(
        `Payment ${paymentIntentId} has already been marked as failed.`,
      );
      reportSentryMessage("Payment failure webhook idempotency short-circuit", {
        subsystem: "payments",
        expected: true,
        extra: { paymentIntentId },
      });
      return;
    }

    // M7 FIX: Guard against SUCCEEDED → FAILED transition.
    // A late failure webhook must not override a payment that already succeeded.
    if (payment.paymentStatus === PaymentStatus.SUCCEEDED) {
      console.warn(
        `Payment ${paymentIntentId} already SUCCEEDED. Ignoring late failure webhook.`,
      );
      reportSentryMessage(
        "Payment failure webhook arrived after SUCCEEDED — ignored",
        {
          subsystem: "payments",
          expected: true,
          level: "warning",
          extra: { paymentIntentId },
        },
      );
      return;
    }

    // Guard against EXPIRED → FAILED transition.
    // Once a payment is expired by cleanup jobs, a late failure webhook should not overwrite it.
    if (payment.paymentStatus === PaymentStatus.EXPIRED) {
      console.log(
        `Payment ${paymentIntentId} already EXPIRED. Ignoring late failure webhook.`,
      );
      reportSentryMessage(
        "Payment failure webhook arrived after EXPIRED — ignored",
        {
          subsystem: "payments",
          expected: true,
          extra: { paymentIntentId },
        },
      );
      return;
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: { paymentStatus: PaymentStatus.FAILED },
    });

    if (payment.appointment) {
      await cleanupFailedPaymentAppointment(tx, payment.appointment.id);
    }

    // Send payment failure email
    await sendPaymentFailureNotification(tx, payment);

    // --- Novu notification (fire-and-forget) ---
    try {
      const consultantUser =
        payment.appointment?.consultation?.consultationPlan?.consultantProfile
          ?.user ||
        payment.appointment?.subscription?.subscriptionPlan?.consultantProfile
          ?.user;

      const consultantName = consultantUser?.name || "Consultant";
      const appointmentType =
        payment.appointment?.appointmentType || "CONSULTATION";

      void Promise.resolve(
        notifyPaymentFailed(payment.userId, {
          amount: payment.amount,
          currency: payment.currency,
          consultantName,
          appointmentType,
          failureReason:
            payment.description || "Payment could not be processed",
          retryUrl: `${getAppUrl()}/dashboard`,
        }),
      ).catch(() => {});
    } catch (novuError) {
      reportSentryError(novuError, { subsystem: "payments", level: "warning" });
      console.error(
        `⚠️ Failed to send Novu payment failed notification for payment ${payment.id}:`,
        novuError,
      );
    }

    console.log(
      `📧 Payment failure notification sent for payment ${paymentIntentId}`,
    );
  });
}

// ============================================================================
// Appointment Creation from Webhook Metadata
// ============================================================================

/**
 * Create appointment from webhook metadata based on appointment type
 */
async function createAppointmentFromWebhook(
  tx: Tx,
  metadata: Record<string, string>,
  payment: PaymentWithUser,
) {
  const {
    appointmentType,
    planId,
    eventId,
    startsAt,
    endsAt,
    schedulingPeriodStartsAt,
    schedulingPeriodEndsAt,
    notes,
  } = metadata;

  if (!payment.user.consulteeProfile) {
    throw new Error("User profile not found for payment");
  }

  const consulteeProfileId = payment.user.consulteeProfile.id;
  const userId = payment.user.id;

  let appointment;

  switch (appointmentType) {
    case AppointmentsType.CONSULTATION:
      appointment = await createConsultation(tx, {
        planId,
        startsAt,
        endsAt,
        notes,
        consulteeProfileId,
        userId,
      });
      break;
    case AppointmentsType.SUBSCRIPTION:
      // LEGACY FLOW WARNING: This should only happen for old payments
      // New subscriptions create placeholder appointment during checkout
      console.warn(
        JSON.stringify({
          event: "legacy_subscription_creation",
          warning:
            "Creating subscription via webhook - expected only for old payments",
          paymentId: payment.id,
          planId,
          timestamp: new Date().toISOString(),
        }),
      );
      appointment = await createSubscription(tx, {
        planId,
        startsAt,
        endsAt,
        schedulingPeriodStartsAt,
        schedulingPeriodEndsAt,
        notes,
        consulteeProfileId,
        userId,
      });
      break;
    case AppointmentsType.WEBINAR:
      appointment = await createWebinar(tx, { eventId, userId });
      break;
    case AppointmentsType.CLASS:
      appointment = await createClass(tx, { eventId, userId });
      break;
    default:
      throw new Error(`Unsupported appointment type: ${appointmentType}`);
  }

  await tx.payment.update({
    where: { id: payment.id },
    data: { appointmentId: appointment.id },
  });

  return appointment;
}

// ============================================================================
// Appointment Type-Specific Creation Functions
// ============================================================================

async function createConsultation(tx: Tx, data: ConsultationData) {
  // #440 — the include rides the create so the overlap-guard column comes
  // back without a second query inside the webhook transaction. #1319 adds
  // the consultant's user id: the conflict filter this row has to be visible
  // to matches on `user.some.id`, not on the profile.
  const consultation = await tx.consultation.create({
    data: {
      consultationPlanId: data.planId,
      status: AppointmentStatus.PENDING,
      requestedById: data.consulteeProfileId,
      requestNotes: data.notes,
      bookingSource: "DIRECT_CHECKOUT",
    },
    include: {
      consultationPlan: {
        select: {
          consultantProfileId: true,
          consultantProfile: { select: { userId: true } },
        },
      },
    },
  });

  const consultantUserId =
    consultation.consultationPlan.consultantProfile?.userId;
  if (!consultantUserId) {
    // Without it the row is invisible to the consultant-scoped conflict filter
    // and the allocator will happily double-book on top of it. A capture that
    // cannot produce a correct booking must fail loudly, not quietly commit a
    // half-connected one — the caller's CRITICAL alert exists for this.
    throw new Error(
      "Consultation plan has no consultant user; cannot create booking",
    );
  }

  // #1071 / ADR B1 — the identical call handleConsultationCheckout makes.
  // This path used to mint ONE row spanning the whole session with only the
  // buyer attached: not an atom run, and unseen by conflict detection.
  const slotAtoms = buildContiguousSlotAtomsForWindow({
    startsAt: new Date(data.startsAt),
    endsAt: new Date(data.endsAt),
    consultantProfileId: consultation.consultationPlan.consultantProfileId,
    // Checkout births `!skipPayment` and the capture webhook flips it false.
    // This creator only runs AFTER capture, so confirmed is the same end state
    // by a shorter road — confirmExistingAppointment re-flips it either way.
    isTentative: false,
    userIds: [consultantUserId, data.userId],
  });

  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.CONSULTATION,
      consultationId: consultation.id,
      slotsOfAppointment: { create: slotAtoms },
      // #1319 A9 — legacy-shape capture creates the appointment itself, so the
      // participant rows are born here rather than flipped by the confirm path.
      // One row per user the atoms connect: the consultant attends too.
      participants: {
        create: [
          { userId: consultantUserId, role: "CONSULTANT", status: "CONFIRMED" },
          { userId: data.userId, role: "CONSULTEE", status: "CONFIRMED" },
        ],
      },
    },
    include: {
      slotsOfAppointment: true,
    },
  });

  // #1071 — assert before the transaction commits, not after a reader trips
  // over it. Free: the rows are already in hand from the create's include.
  assertSingleContiguousLiveRun(appointment.slotsOfAppointment);

  return appointment;
}

async function createSubscription(tx: Tx, data: SubscriptionData) {
  const plan = await tx.subscriptionPlan.findUnique({
    where: { id: data.planId },
    // #1076 — the owning consultant's zone is what the caps bucket on.
    include: {
      consultantProfile: { select: { user: { select: { timezone: true } } } },
    },
  });
  if (!plan) throw new Error("Subscription plan not found");

  // Check if this is a scheduling period request (no slots) or direct slot booking
  const isSchedulingPeriodRequest =
    data.schedulingPeriodStartsAt && data.schedulingPeriodEndsAt;

  let startDate: Date;
  let endDate: Date;

  if (isSchedulingPeriodRequest) {
    // Use provided scheduling period dates (safe to assert since checked above)
    startDate = new Date(data.schedulingPeriodStartsAt!);
    endDate = new Date(data.schedulingPeriodEndsAt!);
  } else {
    // Calculate subscription period from current date
    startDate = new Date();
    endDate = calculateSubscriptionEndDate(startDate, plan.durationInMonths);
  }

  const subscription = await tx.subscription.create({
    data: {
      subscriptionPlanId: data.planId,
      status: AppointmentStatus.PENDING,
      requestedById: data.consulteeProfileId,
      requestNotes: data.notes,
      bookingSource: "DIRECT_CHECKOUT",
      schedulingPeriodStartsAt: startDate,
      schedulingPeriodEndsAt: endDate,
      schedulingTimezone: resolveSchedulingTimezone(
        plan.consultantProfile?.user?.timezone,
      ),
    },
  });

  // #1319 — a slotless placeholder, which is what handleSubscriptionCheckout
  // has always produced: a subscription's sessions are allocated later by the
  // consultant from the Requests tab, so there is no time here to chunk.
  //
  // This used to branch on `!isSchedulingPeriodRequest && startsAt && endsAt`
  // and write one seat row — a row with no `startsAt` and no `endsAt`, which
  // are NOT NULL with no default. The `as unknown as` cast was what let it
  // compile; at runtime the branch could only ever throw and take the whole
  // capture transaction down with it. Matching the checkout counterpart
  // removes the divergence and the dead branch in one move.
  return await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.SUBSCRIPTION,
      subscriptionId: subscription.id,
    },
    include: {
      slotsOfAppointment: true,
    },
  });
}

async function createWebinar(tx: Tx, data: EventData) {
  const webinar = await tx.webinar.findUnique({
    where: { id: data.eventId },
    include: { appointment: { include: { slotsOfAppointment: true } } },
  });
  if (!webinar) throw new Error("Webinar not found");

  // Validate webinar has been scheduled (has an appointment with at least one slot)
  const masterSlot = webinar.appointment?.slotsOfAppointment?.[0];
  if (!webinar.appointment || !masterSlot) {
    throw new Error("Webinar has not been scheduled. Cannot create booking.");
  }

  // #1319 — register the payer against the consultant's existing slots, which
  // is what handleWebinarCheckout does. The seat row this used to mint carried
  // no `consultantProfileId` and duplicated the master slot's window, so a
  // webinar's occupancy grew by a full session for every ticket sold and the
  // atom run gained a second, parallel row nobody could group with it.
  await connectAttendeeToEventSlots(tx, {
    appointments: [webinar.appointment],
    userId: data.userId,
  });

  // #1319 A9 — the seat row is gone, but the seat is not: record the payer
  // against the event's own appointment, the same edge handleWebinarCheckout
  // writes, in the same HELD state. Born CONFIRMED it would outlive its own
  // guard: `confirmExistingAppointment` runs AFTER this and its B2 CAS refuses
  // a capture landing on a cancelled webinar, but this transaction commits
  // either way — leaving a confirmed seat on a dead event that Phase 2 has
  // already refunded. HELD is promoted by the CAS or by nothing.
  await recordParticipants(
    tx,
    webinar.appointment.id,
    [{ userId: data.userId, role: "CONSULTEE" }],
    { status: "HELD" },
  );

  const createdAppointment = await tx.appointment.findUnique({
    where: { id: webinar.appointment.id },
    include: { slotsOfAppointment: true },
  });
  if (!createdAppointment) {
    throw new Error("Failed to fetch created appointment");
  }
  return createdAppointment;
}

async function createClass(tx: Tx, data: EventData) {
  const classInstance = await tx.class.findUnique({
    where: { id: data.eventId },
    include: {
      appointments: {
        include: { slotsOfAppointment: { select: { id: true } } },
      },
    },
  });
  if (!classInstance) throw new Error("Class not found");

  // #1319 — enrol the payer into the sessions that already exist, exactly as
  // handleClassCheckout does. This used to CREATE an appointment per buyer,
  // holding one seat row spanning `schedulingPeriodStartsAt` to
  // `schedulingPeriodEndsAt` — months wide, with no `consultantProfileId`.
  // Worse than a bad row shape: a class's Appointments ARE its sessions, so
  // every enrolment added a phantom session to the class, inflating the
  // session count that capacity, the "fully scheduled" enrolment gate and the
  // consultee's timeline all read.
  // A session Appointment with no slots is an unscheduled session: connecting
  // to it links the payer to nothing. Refusing on `appointments.length` alone
  // let that case through and still recorded a paid seat, so the buyer was
  // enrolled in a class with no time on the calendar.
  const scheduledSessions = classInstance.appointments.filter(
    (appointment) => appointment.slotsOfAppointment.length > 0,
  );
  const [firstAppointment] = scheduledSessions;
  if (!firstAppointment) {
    // Same refusal createWebinar makes for an unscheduled event: there is
    // nothing to enrol into, and inventing a placeholder is what caused this.
    throw new Error("Class has not been scheduled. Cannot create booking.");
  }

  await connectAttendeeToEventSlots(tx, {
    appointments: scheduledSessions,
    userId: data.userId,
  });

  // #1319 A9 — one participant row per scheduled session, matching
  // handleClassCheckout. HELD for the same reason as the webinar arm: the B2
  // CAS in confirmExistingAppointment, not this creator, decides whether a
  // capture on a terminal class is allowed to confirm anything.
  for (const appointment of scheduledSessions) {
    await recordParticipants(
      tx,
      appointment.id,
      [{ userId: data.userId, role: "CONSULTEE" }],
      { status: "HELD" },
    );
  }

  const createdAppointment = await tx.appointment.findUnique({
    where: { id: firstAppointment.id },
    include: { slotsOfAppointment: true },
  });
  if (!createdAppointment) {
    throw new Error("Failed to fetch created appointment");
  }
  return createdAppointment;
}

// ============================================================================
// Appointment State Management
// ============================================================================

/**
 * Confirm consultation or subscription status after successful payment
 * Transitions APPROVED_PENDING_PAYMENT → APPROVED
 */
async function confirmApprovalStatus(
  tx: Tx,
  entityType: "consultation" | "subscription",
  entityId: string,
): Promise<{ capturedAfterTerminal: boolean }> {
  // #855 — signals Phase 2 to auto-refund a capture that landed after the
  // booking was cancelled (money collected for a now-dead booking).
  let capturedAfterTerminal = false;
  if (entityType === "consultation") {
    const consultation = await tx.consultation.findUnique({
      where: { id: entityId },
    });

    if (!consultation) {
      throw new Error(`Consultation ${entityId} not found`);
    }

    // B2 (#825 CAS doctrine) — APPROVED is only reachable from the two
    // pre-payment states. The old else-branch moved ANY status → APPROVED,
    // so a capture landing after a cancel resurrected the booking. Now the
    // guard rides the WHERE; a late capture against a terminal booking is
    // money collected for nothing — surface it for refund instead.
    const movedConsult = await tx.consultation.updateMany({
      where: {
        id: entityId,
        status: {
          in: [
            AppointmentStatus.PENDING,
            AppointmentStatus.APPROVED_PENDING_PAYMENT,
          ],
        },
      },
      data: { status: AppointmentStatus.APPROVED },
    });
    if (movedConsult.count === 0) {
      // Re-read: the pre-read raced the very transition that made the CAS
      // miss, so logging it would report the wrong state (review catch on
      // #844). The fresh value decides whether this is benign (already
      // APPROVED/SCHEDULED/COMPLETED) or money-for-nothing.
      const fresh = await tx.consultation.findUnique({
        where: { id: entityId },
        select: { status: true },
      });
      const freshStatus = fresh?.status ?? consultation.status;
      if (
        freshStatus !== AppointmentStatus.APPROVED &&
        freshStatus !== AppointmentStatus.SCHEDULED &&
        freshStatus !== AppointmentStatus.COMPLETED
      ) {
        capturedAfterTerminal = true; // #855 — Phase 2 auto-refunds
        void recordSystemError({
          organizationId: null,
          category: "PAYMENT",
          summary: `Payment captured for consultation ${entityId} in terminal state ${freshStatus} — refund needed`,
          err: new Error("CAPTURE_AFTER_TERMINAL_STATE"),
          context: { entityType: "consultation", entityId },
        }).catch(() => {});
      }
    }
  } else {
    const subscription = await tx.subscription.findUnique({
      where: { id: entityId },
    });

    if (!subscription) {
      throw new Error(`Subscription ${entityId} not found`);
    }

    // For subscriptions: Only transition APPROVED_PENDING_PAYMENT → APPROVED
    // Do NOT change PENDING → APPROVED here!
    // Subscription stays PENDING until consultant allocates slots via Requests tab
    // SlotAllocationService.allocate() will set status to APPROVED when slots are allocated
    if (subscription.status === AppointmentStatus.APPROVED_PENDING_PAYMENT) {
      // CAS — the pre-read can race a cancel; the guard decides (B2).
      await tx.subscription.updateMany({
        where: {
          id: entityId,
          status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
        },
        data: { status: AppointmentStatus.APPROVED },
      });
      console.log(
        `✅ Subscription ${entityId} payment completed - moving from APPROVED_PENDING_PAYMENT to APPROVED`,
      );
    } else if (subscription.status === AppointmentStatus.CANCELLED) {
      // #855 — capture landed after the subscription was cancelled: money for a
      // dead booking. PENDING here is normal (slots are allocated later), so
      // only CANCELLED is the terminal-capture case.
      capturedAfterTerminal = true;
      void recordSystemError({
        organizationId: null,
        category: "PAYMENT",
        summary: `Payment captured for subscription ${entityId} in terminal state CANCELLED — refund needed`,
        err: new Error("CAPTURE_AFTER_TERMINAL_STATE"),
        context: { entityType: "subscription", entityId },
      }).catch(() => {});
    } else {
      console.log(
        `ℹ️ Subscription ${entityId} payment received - keeping status as ${subscription.status} (consultant will allocate slots)`,
      );
    }
  }
  return { capturedAfterTerminal };
}

/**
 * Confirm appointment by making slots non-tentative and updating status
 *
 * FIX Issue #1 & #3: For multi-user events (WEBINAR, CLASS), only confirm
 * the paying user's slots, not all slots for the shared appointment.
 *
 * @param tx - Prisma transaction client
 * @param appointmentId - The appointment ID to confirm
 * @param userId - The paying user's ID (required for WEBINAR/CLASS to prevent confirming other users' slots)
 */
// Exported for the #827 regression tests; only handlePaymentSuccess calls it in prod.
export async function confirmExistingAppointment(
  tx: Tx,
  appointmentId: string,
  userId?: string,
): Promise<{ capturedAfterTerminal: boolean; doubleBookingBlocked?: boolean }> {
  // First fetch appointment to determine type
  const appointment = await tx.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      consultation: true,
      subscription: true,
      webinar: true,
      class: true,
    },
  });

  if (!appointment) {
    console.warn(`Appointment ${appointmentId} not found for confirmation`);
    return { capturedAfterTerminal: false };
  }

  // #827 — first-confirmed-wins recheck for the EXCLUSIVE booking types.
  // Checkout's hard-overlap check only blocks against isTentative:false
  // slots and its tentative dedup is same-user-only, so two different users
  // can both pay for overlapping slots; whichever capture webhook lands
  // second must NOT flip its slots confirmed over the winner's. The loser
  // stays tentative (the orphan/refund path picks it up, see #830) and the
  // conflict is surfaced loudly instead of double-booking the consultant.
  // Webinars/classes are capacity-based, not exclusive — skipped.
  if (appointment.consultation || appointment.subscription) {
    const mySlots = await tx.slotOfAppointment.findMany({
      where: { appointmentId, isTentative: true },
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        user: { select: { id: true } },
      },
    });
    for (const slot of mySlots) {
      // The non-booker participants (the consultant) attend both bookings —
      // a confirmed overlapping slot sharing one of them is a true conflict.
      const participantIds = slot.user
        .map((u) => u.id)
        .filter((id) => id !== userId);
      if (participantIds.length === 0) continue;
      const conflict = await tx.slotOfAppointment.findFirst({
        where: {
          id: { not: slot.id },
          startsAt: { lt: slot.endsAt },
          endsAt: { gt: slot.startsAt },
          isTentative: false,
          user: { some: { id: { in: participantIds } } },
          appointment: { OR: buildOccupiedAppointmentFilter() },
        },
        select: { id: true, appointmentId: true },
      });
      if (conflict) {
        // Modelled outcome — the #827 first-confirmed-wins guard working as
        // designed (lost race). Phase 2 auto-refunds the loser; still
        // reported at "warning" (not "info") since it needs that follow-up.
        reportSentryError(new Error("CONFIRMATION_BLOCKED_DOUBLE_BOOKING"), {
          subsystem: "payments",
          expected: true,
          level: "warning",
          contexts: {
            booking: {
              appointmentId,
              conflictingAppointmentId: conflict.appointmentId,
              slotId: slot.id,
            },
          },
        });
        console.error(
          JSON.stringify({
            event: "confirmation_blocked_double_booking",
            appointmentId,
            conflictingAppointmentId: conflict.appointmentId,
            slotId: slot.id,
            timestamp: new Date().toISOString(),
          }),
        );
        void recordSystemError({
          organizationId: null,
          category: "PAYMENT",
          summary: `Double-booking blocked at confirmation: appointment ${appointmentId} overlaps an already-confirmed slot — the payment needs a refund`,
          err: new Error("CONFIRMATION_BLOCKED_DOUBLE_BOOKING"),
          context: {
            appointmentId,
            conflictingAppointmentId: conflict.appointmentId,
            slotId: slot.id,
          },
        }).catch(() => {});
        // #837 — slots stay tentative here; the webhook's Phase 2 auto-refunds
        // the loser and releases the hold. The #830 sweep re-drives via this
        // same guard and reports (doesn't refund), so signalling the block up is
        // what routes the refund without fighting the guard.
        return { capturedAfterTerminal: false, doubleBookingBlocked: true };
      }
    }
  }

  // FIX Issue #3: For CLASS, confirm ALL user's slots across all sessions
  // Classes have multiple appointments (one per session), but payment only links to first
  //
  // B2 (booking-journey audit) — the status stamp and the slot flips are
  // GUARDED now. The old code stamped SCHEDULED with a blind update, so a
  // capture landing after the event was cancelled resurrected it to
  // SCHEDULED and re-confirmed the payer's slots on a dead event — money
  // kept, event undead. The guard rides the WHERE (CAS doctrine); a miss
  // means the event moved underneath us, and the fresh read decides benign
  // replay (already live/done — flip slots, keep money) vs capture-after-
  // terminal (CANCELLED/DRAFT — refund via Phase 2, touch nothing).
  const BENIGN_EVENT_STATUSES = ["SCHEDULED", "IN_PROGRESS", "COMPLETED"];

  if (appointment.class && userId) {
    const classId = appointment.class.id;
    const restamped = await tx.class.updateMany({
      where: {
        id: classId,
        status: { in: CLASS_EVENT_ALLOWED_FROM.SCHEDULED },
      },
      data: { status: "SCHEDULED" },
    });
    if (restamped.count === 0) {
      const fresh = await tx.class.findUnique({
        where: { id: classId },
        select: { status: true },
      });
      if (!fresh || !BENIGN_EVENT_STATUSES.includes(fresh.status)) {
        void recordSystemError({
          organizationId: null,
          category: "PAYMENT",
          summary: `Payment captured for class ${classId} in non-live state ${fresh?.status ?? "unknown"} — refund needed`,
          err: new Error("CAPTURE_AFTER_TERMINAL_STATE"),
          context: { entityType: "class", entityId: classId },
        }).catch(() => {});
        return { capturedAfterTerminal: true };
      }
    }

    await tx.slotOfAppointment.updateMany({
      where: {
        appointment: { classId: appointment.class.id },
        user: { some: { id: userId } },
      },
      data: { isTentative: false },
    });
    // #1319 A9 — the seat is paid for; mirror the flip on the participant rows.
    // Only a HELD seat confirms: a capture landing on a cancelled seat must
    // not resurrect it (the refund arm below handles the money).
    await setParticipantStatus(
      tx,
      {
        appointment: { classId: appointment.class.id },
        userId,
        status: "HELD",
      },
      "CONFIRMED",
    );

    console.log(
      JSON.stringify({
        event: "class_all_sessions_confirmed",
        classId: appointment.class.id,
        userId,
        timestamp: new Date().toISOString(),
      }),
    );
  }
  // FIX Issue #1: For WEBINAR, confirm only the paying user's slot
  // Webinars share one appointment among all participants
  else if (appointment.webinar && userId) {
    const webinarId = appointment.webinar.id;
    const restamped = await tx.webinar.updateMany({
      where: {
        id: webinarId,
        status: { in: EVENT_ALLOWED_FROM.SCHEDULED },
      },
      data: { status: "SCHEDULED" },
    });
    if (restamped.count === 0) {
      const fresh = await tx.webinar.findUnique({
        where: { id: webinarId },
        select: { status: true },
      });
      if (!fresh || !BENIGN_EVENT_STATUSES.includes(fresh.status)) {
        void recordSystemError({
          organizationId: null,
          category: "PAYMENT",
          summary: `Payment captured for webinar ${webinarId} in non-live state ${fresh?.status ?? "unknown"} — refund needed`,
          err: new Error("CAPTURE_AFTER_TERMINAL_STATE"),
          context: { entityType: "webinar", entityId: webinarId },
        }).catch(() => {});
        return { capturedAfterTerminal: true };
      }
    }

    await tx.slotOfAppointment.updateMany({
      where: {
        appointmentId,
        user: { some: { id: userId } },
      },
      data: { isTentative: false },
    });
    await setParticipantStatus(
      tx,
      { appointmentId, userId, status: "HELD" },
      "CONFIRMED",
    );

    console.log(
      JSON.stringify({
        event: "webinar_user_slot_confirmed",
        webinarId: appointment.webinar.id,
        userId,
        timestamp: new Date().toISOString(),
      }),
    );
  }
  // For CONSULTATION and SUBSCRIPTION: original behavior (single user per appointment)
  else {
    await tx.slotOfAppointment.updateMany({
      where: { appointmentId },
      data: { isTentative: false },
    });
    await setParticipantStatus(
      tx,
      { appointmentId, status: "HELD" },
      "CONFIRMED",
    );
  }

  // Update status for consultation and subscription
  let capturedAfterTerminal = false;
  if (appointment.consultation) {
    const r = await confirmApprovalStatus(
      tx,
      "consultation",
      appointment.consultation.id,
    );
    capturedAfterTerminal = capturedAfterTerminal || r.capturedAfterTerminal;
  }

  if (appointment.subscription) {
    const r = await confirmApprovalStatus(
      tx,
      "subscription",
      appointment.subscription.id,
    );
    capturedAfterTerminal = capturedAfterTerminal || r.capturedAfterTerminal;
  }

  // Webinar/class status stamps moved ABOVE, next to their slot flips: the
  // stamp is now the CAS guard that decides whether those flips may run at
  // all (B2). A blind re-stamp here would resurrect a cancelled event after
  // the guard above correctly refused it.

  return { capturedAfterTerminal };
}

/**
 * Clean up tentative appointments for failed payments
 */
async function cleanupFailedPaymentAppointment(tx: Tx, appointmentId: string) {
  const appointment = await tx.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      slotsOfAppointment: true,
      consultation: true,
      subscription: true,
    },
  });

  if (!appointment) return;

  // Live holds only: a previously released row is soft-cancelled, not gone,
  // and counting it here would re-run this arm on every replayed failure.
  const tentativeSlots = appointment.slotsOfAppointment.filter(
    (slot) => slot.isTentative && slot.deletedAt === null,
  );

  if (tentativeSlots.length > 0) {
    // Doctrine rule 2: the hold is freed by status, so the slot survives for
    // the dispute trail that a failed payment is most likely to need.
    await transitionSlotCompletion(tx, {
      where: { appointmentId, isTentative: true, deletedAt: null },
      to: SlotCompletionStatus.CANCELLED,
      data: { deletedAt: new Date() },
      allowZero: true,
    });

    if (appointment.consultation || appointment.subscription) {
      // Live rows only — the release above leaves its rows in place, so an
      // unfiltered count would never reach zero and the EXPIRED transition
      // this gates would never fire again.
      const remainingSlots = await tx.slotOfAppointment.count({
        where: { appointmentId, deletedAt: null },
      });
      if (remainingSlots === 0) {
        // Soft-delete: transition to EXPIRED status instead of hard-deleting
        // to preserve audit trails for support/disputes/refunds.
        // #836 — guard rides the WHERE: never expire an APPROVED or terminal
        // booking from this cleanup path; zero rows means it already moved on.
        if (appointment.consultation) {
          await tx.consultation.updateMany({
            where: {
              id: appointment.consultation.id,
              status: { in: REQUEST_ALLOWED_FROM.EXPIRED },
            },
            data: { status: AppointmentStatus.EXPIRED },
          });
        }
        if (appointment.subscription) {
          await tx.subscription.updateMany({
            where: {
              id: appointment.subscription.id,
              status: { in: REQUEST_ALLOWED_FROM.EXPIRED },
            },
            data: { status: AppointmentStatus.EXPIRED },
          });
        }
      }
    }
  }
}

// ============================================================================
// Email Notification Helpers
// ============================================================================

/**
 * Send payment success email notification
 */
async function sendPaymentSuccessNotification(
  tx: Tx,
  payment: PaymentWithUser,
  appointmentId: string,
  appointmentType: string,
) {
  try {
    const appointment = await tx.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        consultation: {
          include: {
            consultationPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: true,
                  },
                },
              },
            },
          },
        },
        subscription: {
          include: {
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: true,
                  },
                },
              },
            },
          },
        },
        webinar: {
          include: {
            webinarPlan: {
              include: {
                consultantProfile: {
                  include: { user: { select: { name: true } } },
                },
              },
            },
          },
        },
        class: {
          include: {
            classPlan: {
              include: {
                consultantProfile: {
                  include: { user: { select: { name: true } } },
                },
              },
            },
          },
        },
      },
    });

    if (!appointment) {
      reportSentryError(
        new Error(
          `Cannot send payment success email: appointment ${appointmentId} not found`,
        ),
        { subsystem: "payments", level: "warning" },
      );
      console.error(
        `Cannot send payment success email: appointment ${appointmentId} not found`,
      );
      return;
    }

    let consultantName = "Consultant";
    const amount = payment.amount;
    const currency = payment.currency;

    // Get consultant name based on appointment type
    if (appointment.consultation?.consultationPlan?.consultantProfile?.user) {
      consultantName =
        appointment.consultation.consultationPlan.consultantProfile.user.name ||
        "Consultant";
    } else if (
      appointment.subscription?.subscriptionPlan?.consultantProfile?.user
    ) {
      consultantName =
        appointment.subscription.subscriptionPlan.consultantProfile.user.name ||
        "Consultant";
    } else if (appointment.webinar?.webinarPlan?.consultantProfile?.user) {
      consultantName =
        appointment.webinar.webinarPlan.consultantProfile.user.name ||
        "Consultant";
    } else if (appointment.class?.classPlan?.consultantProfile?.user) {
      consultantName =
        appointment.class.classPlan.consultantProfile.user.name || "Consultant";
    }

    // Send email
    await sendPaymentSuccessEmail({
      email: payment.user.email || "",
      name: payment.user.name || "User",
      consultantName,
      appointmentType: appointmentType.toLowerCase() as
        | "consultation"
        | "subscription"
        | "webinar"
        | "class",
      amount,
      currency,
      dashboardUrl: `${getAppUrl()}/dashboard`,
    });

    console.log(
      `📧 Payment success email sent to ${payment.user.email} for ${appointmentType}`,
    );
  } catch (error) {
    reportSentryError(error, { subsystem: "payments", level: "warning" });
    // Don't throw - email failures shouldn't block payment processing
    console.error("Failed to send payment success email:", error);
  }
}

/**
 * Send payment failure email notification
 */
async function sendPaymentFailureNotification(
  tx: Tx,
  payment: {
    id: string;
    appointmentId: string | null;
    amount: number;
    currency: string;
    description: string | null;
    user: { email: string | null; name: string | null };
  },
) {
  try {
    const consultantUserSelect = {
      select: {
        consultantProfile: {
          select: { user: { select: { name: true } } },
        },
      },
    } as const;
    const appointment = await tx.appointment.findUnique({
      where: { id: payment.appointmentId || "" },
      select: {
        consultation: {
          select: { id: true, consultationPlan: consultantUserSelect },
        },
        subscription: {
          select: { id: true, subscriptionPlan: consultantUserSelect },
        },
      },
    });

    if (!appointment) {
      reportSentryError(
        new Error(
          `Cannot send payment failure email: appointment not found for payment ${payment.id}`,
        ),
        { subsystem: "payments", level: "warning" },
      );
      console.error(
        `Cannot send payment failure email: appointment not found for payment ${payment.id}`,
      );
      return;
    }

    let consultantName = "Consultant";
    let appointmentType: "consultation" | "subscription" = "consultation";
    let retryUrl = `${getAppUrl()}/dashboard`;

    // Get consultant name and appointment type
    if (appointment.consultation?.consultationPlan?.consultantProfile?.user) {
      consultantName =
        appointment.consultation.consultationPlan.consultantProfile.user.name ||
        "Consultant";
      appointmentType = "consultation";
      retryUrl = `${getAppUrl()}/consultations/${appointment.consultation.id}/payment`;
    } else if (
      appointment.subscription?.subscriptionPlan?.consultantProfile?.user
    ) {
      consultantName =
        appointment.subscription.subscriptionPlan.consultantProfile.user.name ||
        "Consultant";
      appointmentType = "subscription";
      retryUrl = `${getAppUrl()}/subscriptions/${appointment.subscription.id}/payment`;
    }

    // Send email
    await sendPaymentFailedEmail({
      email: payment.user.email || "",
      name: payment.user.name || "User",
      consultantName,
      appointmentType,
      amount: payment.amount,
      currency: payment.currency,
      retryUrl,
      failureReason: payment.description || "Payment could not be processed",
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000), // 48 hours from now
    });

    console.log(
      `📧 Payment failure email sent to ${payment.user.email} for ${appointmentType}`,
    );
  } catch (error) {
    reportSentryError(error, { subsystem: "payments", level: "warning" });
    // Don't throw - email failures shouldn't block payment processing
    console.error("Failed to send payment failure email:", error);
  }
}
