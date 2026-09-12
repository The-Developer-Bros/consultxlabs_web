/**
 * Checkout Operations
 * Handles the complete checkout flow for all appointment types
 */

import { reportSentryError } from "@/lib/observability/report";
import {
  findUncoveredAtom,
  loadPublishedCoverage,
  windowAtoms,
} from "@/utils/slotAllocation/availabilityCoverage";
import {
  linkParticipantsToPayment,
  recordParticipants,
  setParticipantStatus,
} from "@/lib/booking/participants";
import {
  appendCreationHistory,
  transitionConsultationRequest,
  transitionSlotCompletion,
  transitionSubscriptionRequest,
  transitionTrialSession,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { PaymentError } from "@/lib/payments/core/types";
import prisma, { type Tx } from "@/lib/prisma";
import { CheckoutInput, checkoutSchema } from "@/schemas/checkout";
import { calculateSubscriptionEndDate } from "@/utils/dateUtils";
import {
  AppointmentsType,
  type Currency,
  PaymentGateway,
  PaymentStatus,
  Prisma,
  AppointmentStatus,
  TrialSessionStatus,
} from "@prisma/client";
import {
  CHECKOUT_WAIT_RETRY_CONFIG,
  EventFullError,
  lockSlotBooking,
  unlockSlotBooking,
  lockEventCheckout,
  unlockEventCheckout,
  lockConsulteeBooking,
  unlockConsulteeBooking,
  extendLock,
  extendSlotInterval,
  CHECKOUT_LOCK_TTL_MS,
  ApprovalLock,
} from "@/utils/appointmentlock";
import { validateSlotTiming } from "@/lib/payments/utils/slot-validation";
import { buildContiguousSlotAtomsForWindow } from "@/lib/appointments/contiguous-slot-run";
import { connectAttendeeToEventSlots } from "@/lib/appointments/attendee-seats";
import { ensureConsulteeProfile } from "@/lib/profiles/ensure-consultee-profile";
import {
  buildDeadHoldFilter,
  buildOccupiedAppointmentFilter,
} from "@/utils/slotAllocation/occupancyPolicy";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { isUserEnrolled } from "@/lib/payments/utils/participants";
import { getClassCapacity, getWebinarCapacity } from "@/lib/events/capacity";
import { getExchangeRates } from "@/lib/currency";
import { resolveSchedulingTimezone } from "@/lib/scheduling/schedulingTimezone";
import {
  applyCreditsToPayment,
  getUserCredits,
  processQualifyingAction,
  processConsultantBookingReferral,
} from "@/lib/referrals/service";
import {
  deriveCheckoutAmount,
  type CheckoutDiscountInput,
} from "@/lib/payments/pricing/derive-checkout-amount";
import {
  createEarningsFromPayment,
  resolvePaymentForEarnings,
} from "@/lib/payments/payouts";
import { walletDebit } from "@/lib/api/organizations/wallet";
import {
  isWalletFrozen,
  WalletFrozenError,
} from "@/lib/payments/wallet-freeze";
import { recordSystemError } from "@/lib/enterprise/system-events";
import {
  recordBookingUtilization,
  ProgramAssignmentLimitError,
} from "@/lib/api/organizations/program-helpers";
import { appointmentTypeToServiceType } from "@/lib/payments/tax/tax-engine";
import {
  validatePlanCurrency,
  validateDiscountCurrency,
} from "@/lib/payments/validation/currency-guards";
import { checkPaymentLegsSumToAmount } from "@/lib/payments/payment-legs";
import {
  recordOverageAtCheckout,
  notifyOverageDueAfterCommit,
  type PendingOverageNotification,
} from "@/lib/payments/billing/overage-settlement";
import { mintConsumerInvoiceBestEffort } from "@/lib/payments/billing/consumer-invoice";
import {
  getInvoiceCreditLimitPaise,
  assertVerifiedDomainOrThrow,
} from "@/lib/enterprise/governance";
import { checkConsent } from "@/lib/compliance/dpdp";
import { PURPOSE_CODES } from "@/lib/compliance/purpose-codes";
import { ENABLE_DUNNING_SUSPEND } from "@/lib/feature-flags";
import {
  notifyOrgProgramExhausted,
  notifyOrgProgramCapNear,
} from "@/lib/novu/org-workflows";
import { sumPaise } from "@/lib/payments/utils/money";
import { MARKETPLACE_VISIBILITY } from "@/lib/api/plans/visibility";
import {
  ensurePlatformCancellationPolicy,
  resolveCheckoutCancellationPolicyId,
} from "@/lib/payments/operations/cancellation-policy-store";
import { isBusinessErrorCode } from "@/lib/errors/classification/payment-error-classification";

// Re-export for backward compatibility
export const unifiedCheckoutSchema = checkoutSchema;
export type { CheckoutInput };

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Unified return type for subscription checkout
 * FIX Issue #2: Creates placeholder appointment for payment linkage
 * This ensures webhook uses NEW FLOW (confirm) not LEGACY FLOW (create duplicate)
 * Consultant allocates specific slots later via Requests tab
 */
type SubscriptionCheckoutResult = {
  // #780 — extended-client reads return price/trialPriceInPaise as number;
  // GetPayload says bigint.
  plan: Omit<
    Prisma.SubscriptionPlanGetPayload<{
      include: {
        consultantProfile: {
          include: { user: true };
        };
      };
    }>,
    "price" | "trialPriceInPaise"
  > & { price: number; trialPriceInPaise: number };
  amount: number;
  subscription: Prisma.SubscriptionGetPayload<Record<string, never>>;
  appointment: Prisma.AppointmentGetPayload<Record<string, never>>;
  isSchedulingPeriodRequest: boolean;
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * #1437 — Razorpay caps an order's `notes` at 15 keys and 256 characters per
 * value, and this object is that payload (Stripe's own limits are far looser,
 * so the tighter gateway sets the shape for both).
 *
 * Two consequences are handled here. The buyer's booking note is truncated
 * rather than forwarded verbatim: `checkoutSchema` already rejects anything
 * longer, and the full text is persisted on the Payment and Appointment rows,
 * so this copy exists only for the gateway dashboard and losing its tail costs
 * nothing — whereas exceeding the limit costs the buyer the whole purchase.
 * And `discountCode` was dropped: the org-sponsored event case emitted exactly
 * 15 keys, leaving no headroom for the next one, and the discount is already
 * reflected in the order amount and recorded on the Payment row, while nothing
 * in the webhook path ever reads it back out of the gateway.
 *
 * #1462 — an optional field with no value is omitted rather than emitted as an
 * empty string, because the webhook schemas type those fields as `.optional()`,
 * which admits an absent key but rejects `""`; sending the empty key made every
 * scheduling-period subscription fail validation at capture, and it also spent
 * key budget the 15-key ceiling above has no room for.
 */
const GATEWAY_NOTE_MAX_CHARS = 256;

/** Why a superseded open order's booking was cancelled (#1463). */
const SUPERSEDED_HOLD_NOTE =
  "Superseded by a newer checkout attempt for the same booking";

/**
 * Build payment metadata for both payment intents and webhook handlers
 * Ensures consistency between payment creation and mock payment flows.
 *
 * When the booking is org-sponsored, `organizationId` and `fundingSource`
 * are stamped into the gateway's `notes` (C.1, #687). This lets the
 * webhook attribute the payment to the org without an extra DB lookup
 * and gives invoice-fraud reconcilers a server-side proof that the
 * booker's claimed org matches the gateway's record.
 */
export function buildPaymentMetadata(
  data: CheckoutInput,
  userId: string,
  orgContext?: {
    organizationId: string | null;
    fundingSource: "PERSONAL" | "WALLET" | "INVOICE" | "LICENSE" | null;
  },
): { appointmentId: string; appointmentType: string; [key: string]: string } {
  const notes = (data.notes || "").slice(0, GATEWAY_NOTE_MAX_CHARS);
  return {
    appointmentId: "pending",
    appointmentType: data.appointmentType,
    userId: userId,
    planId: data.planId,
    // #1462 — every key below is conditional. A scheduling-period subscription
    // carries no direct slots, so `startsAt`/`endsAt` used to reach the gateway
    // as `""` and then failed `z.string().datetime().optional()` on the way
    // back in, stranding a captured sale as REQUIRES_MANUAL_RECOVERY.
    ...(data.startsAt && { startsAt: data.startsAt }),
    ...(data.endsAt && { endsAt: data.endsAt }),
    ...(data.slotOfAvailabilityWeeklyId && {
      slotOfAvailabilityWeeklyId: data.slotOfAvailabilityWeeklyId,
    }),
    ...(data.slotOfAvailabilityCustomId && {
      slotOfAvailabilityCustomId: data.slotOfAvailabilityCustomId,
    }),
    ...(data.schedulingPeriodStartsAt && {
      schedulingPeriodStartsAt: data.schedulingPeriodStartsAt,
    }),
    ...(data.schedulingPeriodEndsAt && {
      schedulingPeriodEndsAt: data.schedulingPeriodEndsAt,
    }),
    ...(notes && { notes }),
    ...(data.eventId && { eventId: data.eventId }),
    ...(orgContext?.organizationId && {
      organizationId: orgContext.organizationId,
    }),
    ...(orgContext?.fundingSource && {
      fundingSource: orgContext.fundingSource,
    }),
  };
}

// ============================================================================
// Open-Order Reuse (rec C, checkout dossier Q2)
// ============================================================================

/**
 * Rec C (bugs/finances/checkout-webhooks-idempotency.md Q2) — a checkout
 * remount or new tab mints a FRESH clientIdempotencyKey, so #828's same-key
 * replay sees nothing and a naive flow mints a PARALLEL Razorpay order for
 * the same user+plan — parallel charges. Before any gateway call we adopt an
 * open PENDING payment for the same user+plan(+org) whose expiresAt window
 * is still live and hand its orderId back so every mount resumes the SAME
 * order.
 *
 * The scope is deliberately tight: userId equality, status PENDING,
 * expiresAt strictly in the future (respect the minted window), same routed
 * gateway (a Razorpay order cannot be resumed through Stripe.js or vice
 * versa — the replay path refuses cross-gateway resume for the same reason),
 * soft-deletes excluded, and plan identity resolved through the appointment
 * join (Payment carries no planId column). Legitimate repeat purchases are
 * unaffected: once the hold expires or is cancelled, the row is no longer
 * (PENDING ∧ fresh) and the next attempt mints fresh.
 *
 * Race-safe without a claim column: every schema-valid checkout input takes
 * a distributed lock keyed identically for the same user+plan (consultee +
 * slot atoms for slot shapes, event-checkout:<type>:<event|plan> otherwise),
 * so two concurrent remounts serialize before reaching here and the loser
 * observes the winner's COMMITTED row; same-key duplicates stay covered by
 * the clientIdempotencyKey unique (#828 P2002 replay).
 */
/** A resumable open order — the fields the resume response needs. */
interface ReusableOrder {
  id: string;
  paymentIntent: string;
  amount: number;
  currency: string;
  isMockPayment: boolean;
  /** The booked window's slot rows (consultation/class shape); empty for
   *  subscription placeholders whose period lives on the slot rows too. */
  appointment?: {
    slotsOfAppointment: Array<{ startsAt: Date; endsAt: Date }>;
  } | null;
}

/**
 * The [start, end) a set of slot rows actually covers.
 *
 * #1463 — a booked window is stored as N contiguous 30-minute atoms (#1319), so
 * the window gate below cannot read the first row's endpoints: for anything
 * longer than half an hour the first atom ends 30 minutes into the booking and
 * every resume was rejected as a slot-window mismatch. The run's first start and
 * last end are the window.
 */
function slotRunWindow(
  slots: Array<{ startsAt: Date; endsAt: Date }> | undefined,
): { startsAt: Date; endsAt: Date } | null {
  if (!slots || slots.length === 0) return null;
  return {
    startsAt: new Date(Math.min(...slots.map((s) => s.startsAt.getTime()))),
    endsAt: new Date(Math.max(...slots.map((s) => s.endsAt.getTime()))),
  };
}

export async function findReusablePendingOrderPayment(
  db: Pick<typeof prisma, "payment">,
  params: {
    userId: string;
    appointmentType: "CONSULTATION" | "SUBSCRIPTION" | "WEBINAR" | "CLASS";
    planId: string;
    eventId?: string;
    organizationId: string | null;
    paymentGateway: PaymentGateway;
    /**
     * #1220-triage — the CURRENT request's computed total. A candidate whose
     * frozen amount differs (changed coupon, credit balance moved) is
     * superseded instead of resumed, so a stale price can never be charged.
     */
    expectedAmountPaise: number;
    /** Slot window for direct bookings — a resume must be for THIS time,
     *  not just this plan (#1220-triage critical finding). */
    slotWindow?: { startsAt: Date; endsAt: Date };
    /** Subscription billing-period window; both-null rows only match a
     *  both-null request. */
    schedulingPeriod?: { startsAt: Date; endsAt: Date } | null;
  },
): Promise<{
  reusable: ReusableOrder | null;
  /** Scope/freshness matches rejected by the window/amount gates — the caller
   *  EXPIRES these ("superseded") so they can neither be resumed nor re-minted
   *  into a parallel charge. */
  supersede: Array<{ id: string; reason: string }>;
}> {
  // Plan identity per type — events are identified by their event row (the
  // plan is 1:1 with it); direct bookings by their plan id. An undefined
  // eventId would make Prisma drop the filter entirely (matches ANY
  // appointment), which is exactly the over-broad reuse we must never do.
  let planScope: Record<string, unknown> | null;
  switch (params.appointmentType) {
    case "CONSULTATION":
      planScope = { consultation: { consultationPlanId: params.planId } };
      break;
    case "SUBSCRIPTION":
      planScope = { subscription: { subscriptionPlanId: params.planId } };
      break;
    case "WEBINAR":
      planScope = params.eventId ? { webinarId: params.eventId } : null;
      break;
    case "CLASS":
      planScope = params.eventId ? { classId: params.eventId } : null;
      break;
    default:
      planScope = null;
  }
  if (!planScope) return { reusable: null, supersede: [] };

  const candidates = await db.payment.findMany({
    where: {
      userId: params.userId,
      paymentStatus: PaymentStatus.PENDING,
      // Freshness — respect the minted window exactly; never resume a stale hold.
      expiresAt: { gt: new Date() },
      // Null-safe org equality: personal stays personal, sponsored matches sponsor.
      organizationId: params.organizationId,
      paymentGateway: params.paymentGateway,
      deletedAt: null,
      appointment: planScope,
    },
    orderBy: { createdAt: "desc" },
    take: 5, // bounded: newest attempts first; older ones get superseded below
    select: {
      id: true,
      paymentIntent: true,
      amount: true,
      currency: true,
      isMockPayment: true,
      appointment: {
        select: {
          slotsOfAppointment: {
            select: { startsAt: true, endsAt: true },
            orderBy: { startsAt: "asc" as const },
            // #1463 — the whole run, not its first atom. Bounded well above any
            // single bookable window so a pathological row cannot widen the read.
            take: 48,
          },
        },
      },
    },
  });

  const reusable: ReusableOrder[] = [];
  const supersede: Array<{ id: string; reason: string }> = [];

  for (const candidate of candidates) {
    const appt = candidate.appointment as {
      slotsOfAppointment: Array<{ startsAt: Date; endsAt: Date }>;
    } | null;

    // Gate 1 — slot window (#1220-triage Critical): a second checkout for a
    // DIFFERENT appointment time must never resume the first attempt's order.
    if (params.appointmentType === "CONSULTATION") {
      const run = slotRunWindow(appt?.slotsOfAppointment);
      if (!params.slotWindow || !run) {
        supersede.push({ id: candidate.id, reason: "window-unmatchable" });
        continue;
      }
      if (
        run.startsAt.getTime() !== params.slotWindow.startsAt.getTime() ||
        run.endsAt.getTime() !== params.slotWindow.endsAt.getTime()
      ) {
        supersede.push({ id: candidate.id, reason: "slot-window-mismatch" });
        continue;
      }
    }
    if (params.appointmentType === "SUBSCRIPTION") {
      const reqPeriod = params.schedulingPeriod ?? null;
      // Subscription windows ride the SAME slot rows as consultations — the
      // minted placeholder's slot carries the scheduling-period bounds.
      const rowPeriod = slotRunWindow(appt?.slotsOfAppointment);
      if (!!reqPeriod !== !!rowPeriod) {
        supersede.push({ id: candidate.id, reason: "period-mismatch" });
        continue;
      }
      if (
        reqPeriod &&
        rowPeriod &&
        (rowPeriod.startsAt.getTime() !== reqPeriod.startsAt.getTime() ||
          rowPeriod.endsAt.getTime() !== reqPeriod.endsAt.getTime())
      ) {
        supersede.push({ id: candidate.id, reason: "period-mismatch" });
        continue;
      }
    }

    // Gate 2 — priced-input parity (#1220-triage Major): a changed coupon /
    // credit balance / tax profile computes a DIFFERENT total for this
    // request; resuming would charge the stale number. Expire-and-fresh.
    if (candidate.amount !== params.expectedAmountPaise) {
      supersede.push({ id: candidate.id, reason: "amount-mismatch" });
      continue;
    }

    reusable.push(candidate);
    break; // newest match wins
  }

  return { reusable: reusable[0] ?? null, supersede };
}

/**
 * #1463 — superseding an open order is a RELEASE, not just a status flip.
 *
 * Expiring the Payment row alone left the superseded attempt's tentative
 * appointment and slots occupying the calendar, so the very next attempt for
 * the same window hit "Time slot is already booked" again and the buyer was
 * walled in until the cleanup sweep ran. The hold has to go back at the same
 * moment its payment stops being payable, which is why the payment CAS, the
 * slot release and the parent request's cancellation all sit in one
 * transaction: a partial release is exactly the state that reopens the wall.
 *
 * Every write is CAS-in-WHERE per ADR 21 — the payment claim carries
 * `paymentStatus: PENDING` so a capture that landed a millisecond earlier wins
 * and its booking is left completely alone, and the appointment and slot moves
 * go through the guarded helpers in `lib/booking/transitions.ts` rather than a
 * bare update. A parent that has already moved on (its own payment succeeded)
 * throws `IllegalTransitionError`, which is caught per appointment so the rest
 * of the release still commits.
 *
 * Group events are deliberately untouched: their slots are shared between
 * attendees, so releasing a seat is a disconnect rather than a status move and
 * belongs to `cancelPendingCheckout`, which owns that shape. No event checkout
 * is blocked by a per-buyer hold, so nothing here depends on it.
 */
async function releaseSupersededHolds(params: {
  paymentIds: string[];
  userId: string;
}): Promise<void> {
  await prisma.$transaction(async (tx: Tx) => {
    const claimed = await tx.payment.updateManyAndReturn({
      where: {
        id: { in: params.paymentIds },
        userId: params.userId,
        paymentStatus: PaymentStatus.PENDING,
      },
      data: { paymentStatus: PaymentStatus.EXPIRED, expiresAt: new Date() },
      select: { id: true, appointmentId: true },
    });

    const appointmentIds = claimed
      .map((row) => row.appointmentId)
      .filter((id): id is string => id !== null);
    if (appointmentIds.length === 0) return;

    const appointments = await tx.appointment.findMany({
      where: { id: { in: appointmentIds }, deletedAt: null },
      select: {
        id: true,
        webinarId: true,
        classId: true,
        consultation: { select: { id: true } },
        subscription: { select: { id: true } },
      },
    });

    for (const appointment of appointments) {
      if (appointment.webinarId || appointment.classId) continue;

      // Doctrine rule 2: a slot is freed by status, never by DELETE — the
      // buyer keeps the record of the attempt they abandoned.
      await transitionSlotCompletion(tx, {
        where: {
          appointmentId: appointment.id,
          isTentative: true,
          deletedAt: null,
        },
        to: "CANCELLED",
        data: { deletedAt: new Date() },
        reason: SUPERSEDED_HOLD_NOTE,
        actorUserId: params.userId,
        allowZero: true,
      });

      try {
        if (appointment.consultation) {
          await transitionConsultationRequest(tx, {
            where: { id: appointment.consultation.id },
            to: "CANCELLED",
            fromIn: ["PENDING", "APPROVED_PENDING_PAYMENT"],
            actorUserId: params.userId,
            reason: SUPERSEDED_HOLD_NOTE,
            data: {
              cancellationNotes: SUPERSEDED_HOLD_NOTE,
              cancelledAt: new Date(),
            },
          });
        }
        if (appointment.subscription) {
          await transitionSubscriptionRequest(tx, {
            where: { id: appointment.subscription.id },
            to: "CANCELLED",
            fromIn: ["PENDING", "APPROVED_PENDING_PAYMENT"],
            actorUserId: params.userId,
            reason: SUPERSEDED_HOLD_NOTE,
            data: {
              cancellationNotes: SUPERSEDED_HOLD_NOTE,
              cancelledAt: new Date(),
            },
          });
        }
      } catch (error) {
        // The parent moved past the payment stage under us, which means some
        // other payment already carried it — that booking is not ours to
        // cancel. Modelled, so it is reported for visibility only.
        if (!(error instanceof IllegalTransitionError)) throw error;
        reportSentryError(error, {
          subsystem: "payments",
          level: "warning",
          expected: true,
          extra: { appointmentId: appointment.id },
        });
      }
    }
  });
}

// ============================================================================
// Payment Intent Manager
// ============================================================================

/**
 * Manages payment intent creation and cleanup with proper error handling
 */
export class PaymentIntentManager {
  // intentId -> userId. Bounded FIFO: this Map lives on module scope of a
  // warm serverless instance, and an entry that never reaches cancelIntent
  // (caller crash before cleanup) would otherwise grow monotonically for the
  // life of the instance (#audit: unbounded-cache finding).
  private static activeIntents = new Map<string, string>(); // intentId -> userId
  private static readonly MAX_TRACKED_INTENTS = 500;

  /**
   * Create payment intent with automatic cleanup tracking
   */
  static async createWithCleanup(params: {
    amount: number;
    currency: string;
    metadata: {
      appointmentId: string;
      appointmentType: string;
      [key: string]: string;
    };
    paymentGateway: PaymentGateway;
    isMockPayment?: boolean;
  }) {
    try {
      // Imported at call time so the checkout bundle does not evaluate the
      // Razorpay core (and its #1219 test-key guard) at module load.
      const { createPaymentIntent } = await import("../index");
      const paymentResponse = await createPaymentIntent(params);

      // Evict oldest entries first (Map iterates in insertion order) so a
      // warm instance can't accumulate unbounded tracked intents. Eviction
      // drops cleanup ownership for that intent - only reachable at >500
      // concurrent un-cancelled intents on one instance, and strictly better
      // than the previous behaviour (no bound at all) - but surface it so a
      // sustained-eviction pattern is visible in Sentry, not silent.
      while (
        this.activeIntents.size >= PaymentIntentManager.MAX_TRACKED_INTENTS
      ) {
        const oldest = this.activeIntents.keys().next().value;
        if (oldest === undefined) break;
        this.activeIntents.delete(oldest);
        reportSentryError(
          new Error(
            `PaymentIntentManager evicted tracked intent ${oldest} before cancellation`,
          ),
          {
            subsystem: "payments",
            level: "warning",
            expected: true,
            extra: { evictedIntentId: oldest },
          },
        );
      }

      // Track the intent for potential cleanup
      this.activeIntents.set(
        paymentResponse.id,
        params.metadata.userId || "unknown",
      );

      return paymentResponse;
    } catch (error) {
      console.error("Payment intent creation failed:", error);
      reportSentryError(error, { subsystem: "payments" });
      // A typed gateway error (the #1219 test-key guard, an UNKNOWN_GATEWAY)
      // keeps its code so the route can answer with the right status; only
      // untyped failures are flattened into the retry-later message.
      if (error instanceof PaymentError) throw error;
      throw new Error(
        "Failed to create payment intent. Please try again later.",
      );
    }
  }

  /**
   * Cancel a payment intent and clean up tracking
   */
  static async cancelIntent(
    intentId: string,
    reason: string = "Database operation failed",
  ) {
    try {
      const { cancelPaymentIntent } = await import("../index");
      await cancelPaymentIntent(intentId, reason);
    } catch (error) {
      console.error(`Failed to cancel payment intent ${intentId}:`, error);
      reportSentryError(error, { subsystem: "payments", level: "warning" });
      // Don't throw - cleanup should be best-effort
    } finally {
      // Untrack regardless of outcome: the tracking map only decides whether
      // a future cleanup() should re-attempt cancellation. Leaving failed
      // cancels tracked was a slow memory leak on long-lived instances.
      this.activeIntents.delete(intentId);
    }
  }

  /**
   * Cleanup tracked payment intent
   */
  static async cleanup(intentId: string, reason: string) {
    if (this.activeIntents.has(intentId)) {
      await this.cancelIntent(intentId, reason);
    }
  }
}

// ============================================================================
// Amount Calculation and Validation
// ============================================================================

/**
 * Calculate final amount with discount and validate plan availability
 * Does NOT create any appointment records - only validates
 */
export async function calculateAmountAndValidate(
  validatedData: CheckoutInput,
  userId: string,
  buyerCountry: string = "IN",
  /**
   * #1465-triage — the org scope `handleCheckout` already resolved (membership
   * verified) before it calls this. Only reaches the slot-availability gate,
   * where it scopes the self-hold exclusion to holds this request could
   * actually resume. Null default keeps every non-org caller personal.
   */
  organizationId: string | null = null,
) {
  return await prisma.$transaction(async (tx) => {
    let amount = 0;
    let plan;
    let priceCurrency: Currency = "INR";

    // Lazy-create ConsulteeProfile if this is the user's first
    // consumer action. ORG_WORKSPACE / CONSULTANT users who also book
    // personal sessions (valid, if rare) would hit "User profile not
    // found" before this helper existed — now we seed the profile on
    // demand inside the checkout tx.
    await ensureConsulteeProfile(tx, userId);
    const user = await tx.user.findUnique({
      where: { id: userId },
      include: {
        consulteeProfile: true,
      },
    });

    if (!user?.consulteeProfile) {
      throw new Error("User profile not found");
    }

    // Get plan and validate availability without creating records
    // E2E-audit P1 fix — purchase-path storefront gates. Detail pages hide
    // unverified consultants' profiles and archived (withdrawn-from-sale)
    // plans, but this transaction looked rows up by bare id, so a stale or
    // hand-built URL could still pay an unverified seller or buy a pulled
    // plan. Mirror lib/data/consultant-detail.ts's VERIFIED rule and
    // eventPlanDiscoverableWhere's archivedAt/marketplace rules here, inside
    // the lock. Non-marketplace (ORG_ONLY) plans stay purchasable only via
    // the org-sponsored path — whose membership/assignment/contract gates
    // run below and inside revalidateInsideLock.
    const assertPlanPurchasable = (
      p: {
        archivedAt: Date | null;
        visibility: string;
        consultantProfile: { verificationStatus: string } | null;
      },
      label: string,
    ) => {
      if (
        p.consultantProfile &&
        p.consultantProfile.verificationStatus !== "VERIFIED"
      ) {
        throw new Error(`${label} is not available`);
      }
      if (p.archivedAt) {
        throw new Error(`${label} is no longer available`);
      }
      if (
        !MARKETPLACE_VISIBILITY.includes(
          p.visibility as (typeof MARKETPLACE_VISIBILITY)[number],
        ) &&
        !validatedData.organizationId
      ) {
        throw new Error(`${label} is not available`);
      }
    };

    switch (validatedData.appointmentType) {
      case "CONSULTATION":
        plan = await tx.consultationPlan.findUnique({
          where: { id: validatedData.planId },
          include: {
            consultantProfile: {
              include: { user: true },
            },
          },
        });

        if (!plan) {
          throw new Error("Consultation plan not found");
        }

        // #781 §B — soft-deleted expert is not bookable
        if (plan.consultantProfile?.deletedAt) {
          throw new Error("Consultation plan not found");
        }

        assertPlanPurchasable(plan, "This consultation");

        // #1463 — the buyer's User id, not their ConsulteeProfile id: the
        // duplicate-hold step compares it to `Payment.userId`.
        await validateSlotAvailability(
          tx,
          validatedData,
          userId,
          plan.consultantProfile.user.id, // FIX: Pass consultant user ID to filter by consultant
          organizationId,
        );
        amount = plan.price;
        priceCurrency = plan.priceCurrency;
        break;

      case "SUBSCRIPTION":
        plan = await tx.subscriptionPlan.findUnique({
          where: { id: validatedData.planId },
          include: {
            consultantProfile: {
              include: { user: true },
            },
          },
        });

        if (!plan) {
          throw new Error("Subscription plan not found");
        }

        // #781 §B — soft-deleted expert is not bookable
        if (plan.consultantProfile?.deletedAt) {
          throw new Error("Subscription plan not found");
        }

        assertPlanPurchasable(plan, "This subscription");

        // #1463 — the buyer's User id; see the consultation arm above.
        await validateSlotAvailability(
          tx,
          validatedData,
          userId,
          plan.consultantProfile.user.id, // FIX: Pass consultant user ID to filter by consultant
          organizationId,
        );
        amount = plan.price;
        priceCurrency = plan.priceCurrency;
        break;

      case "WEBINAR": {
        if (!validatedData.eventId) {
          throw new Error("Event ID is required for webinar");
        }
        const webinar = await tx.webinar.findUnique({
          where: { id: validatedData.eventId },
          include: {
            webinarPlan: {
              include: {
                consultantProfile: true,
              },
            },
            appointment: {
              include: {
                slotsOfAppointment: {
                  include: {
                    user: { select: { id: true } },
                  },
                },
              },
            },
          },
        });

        if (!webinar) {
          throw new Error("Webinar not found");
        }

        plan = webinar.webinarPlan;

        // #781 §B — soft-deleted expert is not bookable
        if (plan.consultantProfile?.deletedAt) {
          throw new Error("Webinar not found");
        }

        assertPlanPurchasable(plan, "This webinar");

        const consultantUserId = plan.consultantProfile?.userId;
        const webinarCapacity = getWebinarCapacity({
          webinar,
          plan: webinar.webinarPlan,
          excludeUserIds: consultantUserId ? [consultantUserId] : [],
        });

        if (webinarCapacity.isFull) {
          throw new Error("Webinar is full");
        }

        amount = plan.price;
        priceCurrency = plan.priceCurrency;
        break;
      }

      case "CLASS": {
        if (!validatedData.eventId) {
          throw new Error("Event ID is required for class");
        }
        const classInstance = await tx.class.findUnique({
          where: { id: validatedData.eventId },
          include: {
            classPlan: {
              include: { consultantProfile: true },
            },
            appointments: {
              include: {
                slotsOfAppointment: {
                  include: {
                    user: true,
                  },
                },
              },
            },
          },
        });

        if (!classInstance) {
          throw new Error("Class not found");
        }

        plan = classInstance.classPlan;

        // #781 §B — soft-deleted expert is not bookable
        if (plan.consultantProfile?.deletedAt) {
          throw new Error("Class not found");
        }

        assertPlanPurchasable(plan, "This class");

        const classConsultantUserId = plan.consultantProfile?.userId;
        const classCapacity = getClassCapacity({
          classInstance,
          plan: classInstance.classPlan,
          excludeUserIds: classConsultantUserId ? [classConsultantUserId] : [],
        });

        if (classCapacity.isFull) {
          throw new Error("Class is full");
        }

        amount = plan.price;
        priceCurrency = plan.priceCurrency;
        break;
      }

      default:
        throw new Error("Invalid appointment type");
    }

    // Apply discount if provided - with full backend re-validation
    let discountCodeId = null;
    let appliedDiscount: CheckoutDiscountInput | null = null;
    if (validatedData.discountCode) {
      const discount = await tx.discountCode.findUnique({
        where: { code: validatedData.discountCode.toUpperCase().trim() },
      });

      if (discount) {
        // Re-validate all conditions (don't trust frontend validation)
        if (!discount.isActive) {
          throw new Error("Discount code is no longer active");
        }

        if (discount.expiresAt && new Date() > discount.expiresAt) {
          throw new Error("Discount code has expired");
        }

        if (
          discount.maxUses !== null &&
          discount.currentUses >= discount.maxUses
        ) {
          throw new Error("Discount code has reached maximum uses");
        }

        discountCodeId = discount.id;

        // Validate FIXED_AMOUNT discount currency matches plan currency (INR for MVP)
        if (
          !validateDiscountCurrency(
            {
              discountType: discount.discountType,
              currency: discount.currency,
            },
            priceCurrency,
          )
        ) {
          throw new Error(
            "Discount code currency does not match plan currency",
          );
        }

        appliedDiscount = {
          discountType: discount.discountType,
          discountValue: discount.discountValue,
          maxDiscount: discount.maxDiscount,
        };

        // NOTE: currentUses increment is done in the payment transaction
        // to ensure count only increases when payment is successfully created
      }
    }

    // Use priceCurrency extracted from plan (set in the switch above)
    const currency = priceCurrency;

    // Validate plan currency (MVP: all plans must be INR)
    validatePlanCurrency(currency);

    // #1319 — list price, then discount, then GST on the discounted base, then
    // referral credits against the tax-inclusive total. That sequence is now a
    // single pure function the parity suite imports instead of transcribing.
    // The credit balance is still read lazily, only once the order clears the
    // redemption floor, so orders that cannot spend a credit keep it out of the
    // transaction's read set.
    const derived = await deriveCheckoutAmount({
      basePaise: amount,
      buyerCountry,
      serviceType: appointmentTypeToServiceType(validatedData.appointmentType),
      discount: appliedDiscount,
      useReferralCredits: validatedData.useReferralCredits === true,
      resolveAvailableCreditsPaise: async () =>
        (await getUserCredits(userId, tx)).totalAvailable,
    });
    // Original plan price before any discounts/credits, used for consultant
    // earnings — discounts are platform-funded, not consultant-funded.
    const { originalAmount, taxAmount, creditsApplied, isInternational } =
      derived;
    amount = derived.amount;

    // Guard: reject amounts in the 1-99 paise range (> ₹0 but < ₹1).
    // Razorpay requires a minimum order value of ₹1 (100 paise). An amount of exactly 0
    // is allowed — it triggers the mock/zero-amount payment path (free tier, full-credit cover).
    const MINIMUM_CHECKOUT_AMOUNT_PAISE = 100;
    if (amount > 0 && amount < MINIMUM_CHECKOUT_AMOUNT_PAISE) {
      throw new Error(
        `Final checkout amount (${amount} paise) is below the ₹1 minimum after discounts and credits. ` +
          `Please adjust the discount or use a free-session mechanism for zero-price bookings.`,
      );
    }

    return {
      amount,
      originalAmount,
      taxAmount,
      currency,
      discountCodeId,
      consulteeProfileId: user.consulteeProfile.id,
      // #1365 — the buyer's remembered GST state, resolved in the same lookup
      // that resolves the consultee so the invoice mint needs no extra read.
      consulteeBillingStateCode: user.consulteeProfile.billingStateCode,
      creditsApplied,
      buyerCountry,
      isInternational,
    };
  });
}

// ============================================================================
// Slot Availability Validation
// ============================================================================

/**
 * The one definition of "this buyer's hold is still live".
 *
 * #1463 — step 2 below and the self-hold exclusion must agree exactly on what
 * a live hold is, or a hold could be excluded from one and not the other. The
 * shape is the one step 2 has always used: still PENDING, and either inside its
 * minted expiry window or young enough that the window has not been stamped yet.
 * `deletedAt: null` is the single addition, matching what
 * `findReusablePendingOrderPayment` will adopt — a soft-deleted payment is not
 * a hold anybody can resume.
 *
 * Liveness only. The self-hold exclusion narrows this further with the resume
 * gate's own scope (gateway + org) — see `findSelfHoldAppointmentIds`. Step 2's
 * duplicate-attempt guard must NOT carry that scope: it asks "does this buyer
 * already hold this window at all", and scoping it would let a second attempt
 * on another gateway slip past the guard entirely.
 */
function buildLiveHoldPaymentFilter(
  buyerUserId: string,
  now: Date,
): Prisma.PaymentWhereInput {
  return {
    userId: buyerUserId,
    paymentStatus: PaymentStatus.PENDING,
    deletedAt: null,
    OR: [
      { expiresAt: { gt: now } },
      {
        AND: [
          { expiresAt: null },
          { createdAt: { gte: new Date(now.getTime() - 5 * 60 * 1000) } },
        ],
      },
    ],
  };
}

/**
 * #1463 — the appointments that are this buyer's OWN open order for exactly
 * this booking, and therefore are not occupants of the slot they hold.
 *
 * A buyer who closes the gateway modal and clicks Pay again used to be told
 * "Time slot is already booked" by their own hold, which made the documented
 * open-order resume (`findReusablePendingOrderPayment`, "Rec C") unreachable:
 * the availability gate ran first and threw. Excluding these appointments lets
 * the request reach that gate, which then either resumes the same gateway order
 * or supersedes it and releases the hold.
 *
 * The exclusion is deliberately as narrow as the resume gate itself. It takes
 * the same buyer, the same plan, the same gateway and the same org scope, a
 * payment that is still PENDING and still live, and a window that matches
 * EXACTLY — a different buyer, a different plan, or any
 * overlapping-but-different window keeps blocking, and a shape whose plan
 * identity cannot be resolved (webinars and classes, whose slots are shared
 * between attendees) is never excluded at all.
 *
 * #1465-triage — gateway and org are part of that narrowness, not decoration.
 * `findReusablePendingOrderPayment` requires both to match before it will
 * resume or supersede a candidate, so a hold minted on a different gateway (or
 * under a different org scope) is one this request can neither adopt nor
 * expire. Excluding it from availability without those two terms let the same
 * buyer mint a SECOND tentative appointment and a second payable order over the
 * same window, and both orders could capture. A hold that cannot be resumed
 * must keep blocking; the buyer waits out its `expiresAt` instead of
 * double-paying.
 *
 * Exactness is decided in code rather than in the WHERE clause because a booked
 * window is stored as N contiguous 30-minute atoms (#1319), so no single row
 * carries both endpoints: the run's first start and last end are what must
 * equal the request.
 */
export async function findSelfHoldAppointmentIds(
  tx: Tx,
  params: {
    buyerUserId: string;
    appointmentType: CheckoutInput["appointmentType"];
    planId: string;
    /** The gateway this request will mint on — the resume gate's own scope. */
    paymentGateway: PaymentGateway;
    /** Server-resolved org scope; null for personal/marketplace checkouts. */
    organizationId: string | null;
    slotStart: Date;
    slotEnd: Date;
    now: Date;
  },
): Promise<string[]> {
  // A switch rather than a ternary chain: sonar S3358 flags the nested form,
  // and the exhaustive shape is what keeps a new appointment type from silently
  // inheriting an exclusion it was never reasoned about.
  let planScope: Prisma.AppointmentWhereInput | null;
  switch (params.appointmentType) {
    case "CONSULTATION":
      planScope = { consultation: { consultationPlanId: params.planId } };
      break;
    case "SUBSCRIPTION":
      planScope = { subscription: { subscriptionPlanId: params.planId } };
      break;
    default:
      planScope = null;
  }
  if (!planScope) return [];

  const candidates = await tx.appointment.findMany({
    where: {
      ...planScope,
      deletedAt: null,
      payment: {
        some: {
          ...buildLiveHoldPaymentFilter(params.buyerUserId, params.now),
          // The two terms `findReusablePendingOrderPayment` also requires.
          // Null-safe org equality: personal stays personal.
          paymentGateway: params.paymentGateway,
          organizationId: params.organizationId,
        },
      },
      // Cheap index-served pre-filter on the run's first atom; the run's full
      // extent is checked below.
      slotsOfAppointment: {
        some: {
          startsAt: params.slotStart,
          isTentative: true,
          deletedAt: null,
        },
      },
    },
    select: {
      id: true,
      slotsOfAppointment: {
        where: { deletedAt: null },
        select: { startsAt: true, endsAt: true },
      },
    },
    // Bounded: one buyer can hold one window on one plan; anything beyond a
    // handful is a state this exclusion should not be widening for anyway.
    take: 5,
  });

  return candidates
    .filter((appointment) => {
      const slots = appointment.slotsOfAppointment;
      if (slots.length === 0) return false;
      const runStart = Math.min(...slots.map((s) => s.startsAt.getTime()));
      const runEnd = Math.max(...slots.map((s) => s.endsAt.getTime()));
      return (
        runStart === params.slotStart.getTime() &&
        runEnd === params.slotEnd.getTime()
      );
    })
    .map((appointment) => appointment.id);
}

/**
 * Validate slot availability with protection against race conditions
 * Checks for:
 * 1. Confirmed overlapping bookings
 * 2. Duplicate tentative bookings by same user
 * 3. Excessive tentative bookings (rate limiting)
 *
 * #1463 — returns the buyer's own self-held appointment ids so the caller's
 * own conflict checks can exclude the same rows this function did; re-deriving
 * them there would be a second query answering an identical question.
 */
export async function validateSlotAvailability(
  tx: Tx,
  data: CheckoutInput,
  buyerUserId?: string,
  consultantUserId?: string, // NEW: Filter by consultant to prevent blocking across different consultants
  /**
   * #1465-triage — the SERVER-resolved org scope for this request, which is
   * what `findReusablePendingOrderPayment` matches on. Defaults to null
   * (personal) so a caller that cannot resolve it fails closed: an org-scoped
   * hold then keeps blocking rather than being excluded from availability by a
   * request that could never resume it.
   */
  organizationId: string | null = null,
): Promise<{ selfHoldAppointmentIds: string[] }> {
  if (!data.startsAt || !data.endsAt) return { selfHoldAppointmentIds: [] };

  // LCY-2 consent cascade (#701/#1230) — a consultant who withdrew
  // SESSION_BOOKING consent must not receive new bookings. Fail-closed:
  // no artifact or withdrawn artifact ⇒ block.
  if (consultantUserId) {
    // #1421 — `tx`, not the global client. Every caller of this helper is
    // already inside an interactive transaction, and under PG_POOL_MAX=1 that
    // transaction holds the pool's only connection: a global-client read here
    // waits for a connection that cannot be freed until the transaction it is
    // blocking commits, so checkout died at the 3 s pg connect timeout with
    // "timeout exceeded when trying to connect". The dynamic imports this
    // block used to carry are gone too; both symbols are static imports above.
    if (
      !(await checkConsent(
        {
          userId: consultantUserId,
          purposeCode: PURPOSE_CODES.SESSION_BOOKING,
        },
        tx,
      ))
    ) {
      throw Object.assign(
        new Error(
          "This consultant has withdrawn session-delivery consent and cannot accept new bookings.",
        ),
        { httpStatus: 403, code: "CONSENT_WITHDRAWN" },
      );
    }
  }

  const slotStart = new Date(data.startsAt);
  const slotEnd = new Date(data.endsAt);
  const now = new Date();

  // 0. Validate slot is not in the past or too soon (minimum lead time check)
  const timingError = validateSlotTiming(slotStart);
  if (timingError) {
    throw new Error(timingError);
  }

  // 0b. Validate the whole [start, end) window against the consultant's
  // PUBLISHED availability. #1320 — this used to check the window against the
  // single row the client named (`slotOfAvailabilityWeeklyId`), so a two-hour
  // booking spanning two adjacent one-hour rows was rejected even though the
  // expert-page grid drew them as one block and the generator now merges
  // them. The rule is now interval containment against the UNION of the
  // consultant's rows: every 30-minute atom of the window must fall inside
  // some published row. The named id, when present, still proves ownership
  // and catches a soft-deleted profile (B13); it is no longer the boundary.
  if (data.slotOfAvailabilityWeeklyId || data.slotOfAvailabilityCustomId) {
    // Both row kinds are read for the same three facts, so they share one
    // include; a checkout names at most one of them.
    const namedRowInclude = {
      consultantProfile: {
        select: { id: true, userId: true, deletedAt: true },
      },
    } as const;
    const named =
      (data.slotOfAvailabilityWeeklyId
        ? await tx.slotOfAvailabilityWeekly.findUnique({
            where: { id: data.slotOfAvailabilityWeeklyId },
            include: namedRowInclude,
          })
        : null) ??
      (data.slotOfAvailabilityCustomId
        ? await tx.slotOfAvailabilityCustom.findUnique({
            where: { id: data.slotOfAvailabilityCustomId },
            include: namedRowInclude,
          })
        : null);
    // A named row can legitimately vanish mid-checkout: a save on the
    // consultant's side coalesces adjacent rows into one and re-ids it. The
    // union check below is the authority, so a missing row is not fatal
    // unless we cannot resolve the consultant at all.
    if (named) {
      if (named.consultantProfile.deletedAt) {
        throw new Error("This expert is no longer accepting bookings");
      }
      if (
        consultantUserId &&
        named.consultantProfile.userId !== consultantUserId
      ) {
        throw new Error(
          "Availability slot does not belong to the specified consultant",
        );
      }
    }
    const profileId =
      named?.consultantProfile.id ??
      (consultantUserId
        ? (
            await tx.consultantProfile.findFirst({
              // The named row got its deletedAt check above; this fallback
              // runs when there is no named row, so it carries its own.
              where: { userId: consultantUserId, deletedAt: null },
              select: { id: true },
            })
          )?.id
        : undefined);
    if (!profileId) {
      throw new Error("Availability slot not found");
    }

    const atoms = windowAtoms(slotStart, slotEnd);
    // ScheduleType is exclusive, so only the consultant's active arm publishes
    // availability; the loader hands back [] for the dormant one (#1320).
    const { scheduleType, weeklyRows, customRows } =
      await loadPublishedCoverage(tx, profileId, slotStart, slotEnd);
    const uncovered = findUncoveredAtom(atoms, weeklyRows, customRows);

    if (uncovered) {
      // FIX #520 Bug 2: Diagnostic logging for intermittent slot validation failures
      console.error(
        JSON.stringify({
          event: "slot_validation_failed",
          reason: "atom_outside_published_availability",
          scheduleType,
          uncoveredAtomStart: uncovered.start.toISOString(),
          candidateDay: uncovered.day,
          candidateMinutes: uncovered.minutes,
          weeklyRows: weeklyRows.length,
          customRows: customRows.length,
          slotStartISO: data.startsAt,
          slotEndISO: data.endsAt,
          namedWeeklyId: data.slotOfAvailabilityWeeklyId ?? null,
          namedCustomId: data.slotOfAvailabilityCustomId ?? null,
          timestamp: new Date().toISOString(),
        }),
      );
      throw new Error(
        "Selected slot does not fall within the specified availability window",
      );
    }
  }

  // #1463 — the buyer's own open order for exactly this booking. Resolved once
  // and subtracted from both blocking steps below; see
  // findSelfHoldAppointmentIds for why the exclusion is this narrow.
  const selfHoldAppointmentIds = buyerUserId
    ? await findSelfHoldAppointmentIds(tx, {
        buyerUserId,
        appointmentType: data.appointmentType,
        planId: data.planId,
        paymentGateway: data.paymentGateway,
        organizationId,
        slotStart,
        slotEnd,
        now,
      })
    : [];
  const notSelfHeld: Prisma.SlotOfAppointmentWhereInput[] =
    selfHoldAppointmentIds.length > 0
      ? [{ NOT: { appointmentId: { in: selfHoldAppointmentIds } } }]
      : [];

  // 1. Check for confirmed overlapping appointments FOR THIS CONSULTANT ONLY
  // FIX Bug #05: Use canonical overlap predicate that catches all 4 overlap shapes
  // (partial start, partial end, full containment, and exact match)
  // FIX #540: Only check slots belonging to occupied (active) appointments.
  // Cancelled/rejected/expired appointment slots should NOT block new bookings.
  const existingBooking = await tx.slotOfAppointment.findFirst({
    where: {
      AND: [
        { startsAt: { lt: slotEnd } },
        { endsAt: { gt: slotStart } },
        // #1169 PR 2 — the `{ isTentative: false }` filter that used to sit
        // here hid LIVE tentative holds: an in-flight checkout's hold passed
        // unseen (the exclusion constraint carries the same NOT-isTentative
        // predicate), so two overlapping holds both reached payment and both
        // charged. The occupancy term below is the whole check now — it admits
        // live holds and drops released/expired ones by status, and
        // cleanup-tentative-slots bounds any stale remainder. Re-adding a
        // confirmed-only predicate here reopens the double-charge.
        // FIX: Filter by consultant - only check slots belonging to this consultant
        ...(consultantUserId
          ? [
              {
                user: {
                  some: {
                    id: consultantUserId,
                  },
                },
              },
            ]
          : []),
        // FIX #540: Only count slots from active/occupied appointments.
        // #1319 — minus dead holds (lapsed DIRECT_CHECKOUT / pay-link windows),
        // so a slot frees the moment its payment window passes rather than
        // when the sweep runs. The JS twin is isOccupiedByLiveAppointment.
        {
          appointment: {
            AND: [
              { OR: buildOccupiedAppointmentFilter() },
              { NOT: buildDeadHoldFilter(now) },
            ],
          },
        },
        // #1463 — the buyer's own live hold on exactly this window and plan is
        // their open order, not another occupant, and the Rec C block below
        // (findReusablePendingOrderPayment) is the path that resumes or
        // supersedes it. Everything else still blocks.
        ...notSelfHeld,
      ],
    },
  });

  if (existingBooking) {
    throw new Error("Time slot is already booked");
  }

  // 2. Check for duplicate tentative bookings by the same user FOR THIS CONSULTANT
  // FIX Bug #05: Use canonical overlap predicate
  //
  // #1463 — this step took the caller's ConsulteeProfile id and compared it to
  // `Payment.userId`, which is a User id, so it could never match and the step
  // never fired. The parameter is the buyer's User id now, which is also the
  // identity the self-hold exclusion needs.
  if (buyerUserId) {
    const recentAttempt = await tx.slotOfAppointment.findFirst({
      where: {
        AND: [
          { startsAt: { lt: slotEnd } },
          { endsAt: { gt: slotStart } },
          { isTentative: true },
          // FIX: Filter by consultant - only check tentative slots for this consultant
          ...(consultantUserId
            ? [
                {
                  user: {
                    some: {
                      id: consultantUserId,
                    },
                  },
                },
              ]
            : []),
          {
            appointment: {
              payment: {
                some: buildLiveHoldPaymentFilter(buyerUserId, now),
              },
            },
          },
          // #1463 — same exclusion as step 1: telling the buyer to "complete
          // your current payment" while giving them no way to do so is the
          // dead end this issue is about.
          ...notSelfHeld,
        ],
      },
    });

    if (recentAttempt) {
      throw new Error(
        "You already have a pending booking for this time slot. Please complete your current payment or wait a few minutes to try again.",
      );
    }
  }

  // #1319 — the former "max 3 pending attempts per slot" step is gone: since
  // #1169 PR 2 step 1 blocks on ANY live hold, this count could never reach
  // one, let alone three. Do not re-add a per-slot attempt cap here; the hold
  // itself is the cap.

  return { selfHoldAppointmentIds };
}

// ============================================================================
// Checkout Lock Management
// ============================================================================

/**
 * Get plan data needed for lock acquisition
 * Returns consultant profile info for slot-based locking
 *
 * FIX Bug #04: Changed from userId to id (consultantProfileId) to match
 * the lock key used in request-for-approval flow. All slot locks must use
 * the same identity (consultantProfileId) to prevent parallel bypass.
 */
async function getPlanDataForLock(
  data: CheckoutInput,
): Promise<{ consultantProfile?: { id: string } }> {
  // For CONSULTATION and SUBSCRIPTION, we need consultant profile ID for slot locking
  if (data.appointmentType === "CONSULTATION") {
    const plan = await prisma.consultationPlan.findUnique({
      where: { id: data.planId },
      select: {
        consultantProfile: {
          select: { id: true },
        },
      },
    });
    if (!plan) throw new Error("Consultation plan not found");
    return plan;
  }

  if (data.appointmentType === "SUBSCRIPTION") {
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: data.planId },
      select: {
        consultantProfile: {
          select: { id: true },
        },
      },
    });
    if (!plan) throw new Error("Subscription plan not found");
    return plan;
  }

  // For WEBINAR/CLASS, we don't need consultant ID (event-based locking)
  return {};
}

/**
 * B4 — OPTIMISTIC capacity read for WEBINAR/CLASS, run BEFORE the event
 * checkout mutex. Mirrors the in-lock recount's query shape exactly (same
 * includes, same capacity helpers, same host-exclusion rule) so the two can
 * only disagree inside the near-capacity race window that Serializable
 * isolation arbitrates. Advisory-only: a full answer here is terminal for
 * this request (sold out); a not-full answer proves nothing and the mutex +
 * recount still decide.
 */
async function readEventCapacity(
  appointmentType: "WEBINAR" | "CLASS",
  eventId: string,
): Promise<{ isFull: boolean }> {
  if (appointmentType === "WEBINAR") {
    const webinar = await prisma.webinar.findUnique({
      where: { id: eventId },
      include: {
        webinarPlan: { include: { consultantProfile: true } },
        appointment: {
          include: {
            slotsOfAppointment: { include: { user: { select: { id: true } } } },
          },
        },
      },
    });
    if (!webinar) return { isFull: false }; // not-found → let the lock path report it
    const consultantUserId = webinar.webinarPlan.consultantProfile?.userId;
    return getWebinarCapacity({
      webinar,
      plan: webinar.webinarPlan,
      excludeUserIds: consultantUserId ? [consultantUserId] : [],
    });
  }

  const classInstance = await prisma.class.findUnique({
    where: { id: eventId },
    include: {
      classPlan: { include: { consultantProfile: true } },
      appointments: {
        include: { slotsOfAppointment: { include: { user: true } } },
      },
    },
  });
  if (!classInstance) return { isFull: false };
  const ownerUserId = classInstance.classPlan.consultantProfile?.userId;
  return getClassCapacity({
    classInstance,
    plan: classInstance.classPlan,
    excludeUserIds: ownerUserId ? [ownerUserId] : [],
  });
}

/**
 * Acquire appropriate lock based on checkout type
 * Returns lock or null if no locking needed
 */
async function acquireCheckoutLock(
  data: CheckoutInput,
  planData: { consultantProfile?: { id: string } },
): Promise<ApprovalLock | ApprovalLock[] | null> {
  const appointmentType = data.appointmentType;

  // Strategy A: Slot-based locking (CONSULTATION + direct SUBSCRIPTION)
  // FIX Bug #04: Use consultantProfileId (not userId) to match request-for-approval lock key
  if (data.startsAt && data.endsAt) {
    let consultantProfileId: string;

    if (
      appointmentType === "CONSULTATION" ||
      appointmentType === "SUBSCRIPTION"
    ) {
      consultantProfileId = planData.consultantProfile!.id;
    } else {
      // For WEBINAR/CLASS with slots (shouldn't happen but handle gracefully)
      throw new Error(
        "Invalid checkout configuration: slot-based checkout for event type",
      );
    }

    console.log(
      JSON.stringify({
        event: "checkout_lock_acquiring",
        type: "slot-based",
        appointmentType,
        consultantProfileId,
        slot: data.startsAt,
        timestamp: new Date().toISOString(),
      }),
    );

    // #1169 PR 1 — interval-granular: every 30-min atom of [startsAt, endsAt)
    // is locked, so an overlapping booking with a DIFFERENT start collides
    // instead of sailing past on a different instant key.
    return await lockSlotBooking(
      consultantProfileId,
      data.startsAt,
      data.endsAt!,
      CHECKOUT_LOCK_TTL_MS[appointmentType], // #832 — per-type budget
    );
  }

  // Strategy B: Event-based locking (WEBINAR, CLASS, scheduling-period SUBSCRIPTION)
  if (appointmentType === "WEBINAR" || appointmentType === "CLASS") {
    if (!data.eventId) {
      throw new Error(`${appointmentType} checkout requires event ID`);
    }

    console.log(
      JSON.stringify({
        event: "checkout_lock_acquiring",
        type: "event-based",
        appointmentType,
        eventId: data.eventId,
        timestamp: new Date().toISOString(),
      }),
    );

    // B4 (booking-journey audit) — OPTIMISTIC CAPACITY PRE-CHECK before the
    // mutex. During a drop, hundreds of buyers serialize behind one
    // event-checkout key only to discover inside the lock that the event is
    // full; with a 26s function ceiling most of them died as raw 504s. One
    // bounded read here answers "already sold out" for the overwhelming
    // majority WITHOUT touching the mutex — the Serializable recount inside
    // remains the authoritative gate for the near-capacity race.
    const preCheck = await readEventCapacity(appointmentType, data.eventId);
    if (preCheck.isFull) {
      throw new EventFullError(appointmentType);
    }

    return await lockEventCheckout(
      appointmentType,
      data.eventId,
      CHECKOUT_LOCK_TTL_MS[appointmentType], // #832 — per-type budget
      CHECKOUT_WAIT_RETRY_CONFIG, // B4 — fail fast, never queue past the ceiling
    );
  }

  // Scheduling period SUBSCRIPTION (no slots during checkout)
  if (appointmentType === "SUBSCRIPTION" && data.schedulingPeriodStartsAt) {
    console.log(
      JSON.stringify({
        event: "checkout_lock_acquiring",
        type: "event-based",
        appointmentType: "SUBSCRIPTION",
        planId: data.planId,
        timestamp: new Date().toISOString(),
      }),
    );

    return await lockEventCheckout(
      appointmentType,
      data.planId,
      CHECKOUT_LOCK_TTL_MS[appointmentType], // #832 — per-type budget
      CHECKOUT_WAIT_RETRY_CONFIG,
    );
  }

  // Should not reach here if validation is correct
  console.warn(
    JSON.stringify({
      event: "checkout_no_lock_needed",
      appointmentType,
      data,
      timestamp: new Date().toISOString(),
    }),
  );

  return null;
}

/**
 * Release checkout lock safely (for finally blocks)
 */
async function releaseCheckoutLock(
  lock: ApprovalLock | ApprovalLock[] | null,
  lockType: string,
): Promise<void> {
  if (!lock) return;

  if (Array.isArray(lock)) {
    await unlockSlotBooking(lock);
  } else {
    await unlockEventCheckout(lock);
  }

  console.log(
    JSON.stringify({
      event: "checkout_lock_released",
      lockType,
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * BUG-E: Verify plan still exists inside lock
 * Prevents race condition where plan is deleted between initial validation and checkout
 */
async function verifyPlanExistsInsideLock(
  tx: Tx,
  appointmentType: string,
  planId: string,
): Promise<{
  consultantProfileId: string | null;
  organizationId: string | null;
  /** ACCEPTED collaborators' profile ids; only webinar and class plans have any. */
  collaboratorProfileIds: string[];
}> {
  // ADR 18 — also surface the plan's consultant + org ownership so the
  // allowlist/exclusivity checks below reuse this lookup.
  const select = { consultantProfileId: true, organizationId: true } as const;
  // #1580 C-P0-2 — the self-booking guard below also refuses an ACCEPTED
  // collaborator, who would otherwise be paid back part of their own seat.
  const collaborators = {
    where: { status: "ACCEPTED" as const },
    select: { consultantProfileId: true },
  };
  let plan: {
    consultantProfileId: string | null;
    organizationId: string | null;
    collaborators?: { consultantProfileId: string }[];
  } | null = null;

  switch (appointmentType) {
    case "CONSULTATION":
      plan = await tx.consultationPlan.findUnique({
        where: { id: planId },
        select,
      });
      break;
    case "SUBSCRIPTION":
      plan = await tx.subscriptionPlan.findUnique({
        where: { id: planId },
        select,
      });
      break;
    case "WEBINAR":
      plan = await tx.webinarPlan.findUnique({
        where: { id: planId },
        select: { ...select, collaborators },
      });
      break;
    case "CLASS":
      plan = await tx.classPlan.findUnique({
        where: { id: planId },
        select: { ...select, collaborators },
      });
      break;
  }

  if (!plan) {
    throw new Error(
      "This plan is no longer available. Please refresh and try again.",
    );
  }
  return {
    consultantProfileId: plan.consultantProfileId,
    organizationId: plan.organizationId,
    collaboratorProfileIds: (plan.collaborators ?? []).map(
      (c) => c.consultantProfileId,
    ),
  };
}

/**
 * Re-validate availability inside the lock
 * Critical for preventing TOCTOU race conditions
 */
/** What the pre-lock org gate chain resolved; re-asserted under the lock. */
interface OrgFundingContext {
  organizationId: string;
  callerMembershipId: string;
  programAssignmentId: string | null;
  appointmentType: "CONSULTATION" | "SUBSCRIPTION" | "WEBINAR" | "CLASS";
}

async function revalidateInsideLock(
  data: CheckoutInput,
  userId: string,
  // ADR 18 — Program funding this org-sponsored booking; null for
  // PERSONAL/marketplace checkouts. Drives the curated-panel check.
  programId: string | null = null,
  orgContext: OrgFundingContext | null = null,
): Promise<void> {
  // Re-run the same validation as calculateAmountAndValidate
  // but this time we're inside the lock, so it's safe
  await prisma.$transaction(async (tx) => {
    await ensureConsulteeProfile(tx, userId);
    const user = await tx.user.findUnique({
      where: { id: userId },
      include: {
        consulteeProfile: true,
        // For the self-booking guard below. A user may hold both profiles —
        // ConsultantProfile and ConsulteeProfile are independent 1:1s and
        // deliberately not mutually exclusive (ADR 18, and the roles doc says
        // so outright), which is exactly what makes the guard necessary.
        consultantProfile: { select: { id: true } },
      },
    });

    if (!user?.consulteeProfile) {
      throw new Error("User profile not found");
    }

    // BUG-E: Re-validate plan still exists (could be deleted between initial validation and lock)
    const plan = await verifyPlanExistsInsideLock(
      tx,
      data.appointmentType,
      data.planId,
    );

    // Nobody buys their own plan. Because one person can hold both profiles,
    // a LEARNER in a sponsoring org who also sells on the marketplace could
    // book their OWN plan against the org's credit pool and route the
    // sponsor's money into their own payout account. The same-org
    // EXPERT+LEARNER block doesn't reach this: it needs only a
    // ConsulteeProfile and a plan, and `ProgramConsultantAllowlist` — the one
    // thing that would have caught it — is empty by default under ADR 18's
    // open network.
    //
    // Blocked for personal checkouts too. There the loss is the platform fee
    // rather than someone else's money, so it is self-punishing rather than
    // dangerous, but there is no legitimate reason to buy your own session and
    // a rule with no exceptions needs no explanation at the call site.
    //
    // An ACCEPTED collaborator is the same party for this purpose: they hold a
    // share of the price and would be paid back part of their own seat, so the
    // sponsor-money loop above is reachable through a collaboration too. The
    // capacity `excludeUserIds` sites are left alone — a buyer refused here
    // never holds a seat (#1580 C-P0-2).
    // Not gated on the owner existing: an org-owned plan has no owner and can
    // still carry collaborators.
    if (
      user.consultantProfile &&
      (plan.consultantProfileId === user.consultantProfile.id ||
        plan.collaboratorProfileIds.includes(user.consultantProfile.id))
    ) {
      throw new Error("You cannot book your own plan.");
    }

    // #1319 (B2B gap 3) — the org gate chain ran BEFORE the locks, so an org
    // suspended, a membership revoked, an assignment rolled or a consent
    // withdrawn between the gate and the write still got sponsored. Re-assert
    // the resolved rows by id under the lock; the credit limit is re-checked
    // inside the Serializable booking tx already.
    if (orgContext) {
      const now = new Date();
      const org = await tx.organization.findUnique({
        where: { id: orgContext.organizationId },
        select: { status: true, canSponsor: true },
      });
      if (
        !org ||
        !org.canSponsor ||
        (org.status !== "ACTIVE" && org.status !== "PENDING_VERIFICATION")
      ) {
        throw new Error(
          "This organization can no longer sponsor bookings. Please refresh and try again.",
        );
      }
      const membership = await tx.membership.findUnique({
        where: { id: orgContext.callerMembershipId },
        select: { status: true },
      });
      if (membership?.status !== "ACTIVE") {
        throw new Error("You are not an active member of this organization.");
      }
      if (orgContext.programAssignmentId) {
        const assignment = await tx.programAssignment.findFirst({
          where: {
            id: orgContext.programAssignmentId,
            status: "ACTIVE",
            periodStart: { lte: now },
            periodEnd: { gte: now },
            program: {
              status: "ACTIVE",
              OR: [
                { coveredPlanTypes: { isEmpty: true } },
                { coveredPlanTypes: { has: orgContext.appointmentType } },
              ],
              contract: {
                organizationId: orgContext.organizationId,
                status: "ACTIVE",
                effectiveFrom: { lte: now },
                OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }],
              },
            },
          },
          select: { id: true },
        });
        if (!assignment) {
          throw new Error(
            "Your program assignment changed while this booking was in progress. Please refresh and try again.",
          );
        }
      }
      if (ENABLE_DUNNING_SUSPEND) {
        const suspended = await tx.organizationInvoice.findFirst({
          where: {
            organizationId: orgContext.organizationId,
            status: "OVERDUE",
            dunningSuspendedAt: { not: null },
          },
          select: { id: true },
        });
        if (suspended) {
          // #1467 — the in-lock re-check of the same dunning gate. It throws
          // inside the checkout transaction, so without the code the catch below
          // rewrites it to "Failed to record payment information"; with it the
          // buyer gets the same 402 the pre-lock gate returns.
          throw Object.assign(
            new Error(
              "This organization is suspended from new sponsored bookings until its overdue invoice is paid.",
            ),
            { httpStatus: 402, code: "BILLING_SUSPENDED_DUNNING" },
          );
        }
      }
      if (
        // #1421 — same pool-starvation rule as validateSlotAvailability: this
        // runs inside revalidateInsideLock's transaction.
        !(await checkConsent(
          {
            userId,
            purposeCode: PURPOSE_CODES.SESSION_BOOKING,
          },
          tx,
        ))
      ) {
        throw Object.assign(
          new Error(
            "Consent required before your organization can book sessions for you.",
          ),
          {
            httpStatus: 403,
            code: "CONSENT_REQUIRED",
            purposeCode: "SESSION_BOOKING",
          },
        );
      }
    }

    // ADR 18 — curated-panel enforcement (#971 shipped the stub). Rows on
    // the funding Program restrict org-sponsored bookings to listed
    // consultants; zero rows keep the sponsor network open. Checked under
    // the distributed lock to close the check-then-book race.
    if (programId) {
      const panel = await tx.programConsultantAllowlist.findMany({
        where: { programId },
        select: { consultantProfileId: true },
      });
      if (
        panel.length > 0 &&
        !panel.some(
          (row) => row.consultantProfileId === plan.consultantProfileId,
        )
      ) {
        throw new Error(
          "This consultant is not on your organization's approved panel for this program. Choose a listed consultant or ask your organization admin.",
        );
      }
    }

    // ADR 18 — exclusiveEngagement blocks the consultant's independent
    // plans (no org ownership) while an ACTIVE membership declares
    // exclusivity. Org-owned plans stay bookable. The "hide" half
    // (marketplace visibility filtering) remains future work per the ADR.
    if (plan.consultantProfileId && !plan.organizationId) {
      const exclusive = await tx.membership.findFirst({
        where: {
          consultantProfileId: plan.consultantProfileId,
          exclusiveEngagement: true,
          status: "ACTIVE",
        },
        select: { id: true },
      });
      if (exclusive) {
        throw new Error(
          "This consultant works exclusively through their organization; their independent plans cannot be booked.",
        );
      }
    }

    // Re-validate slot availability based on appointment type
    switch (data.appointmentType) {
      case "CONSULTATION": {
        // Only validate if there are slots
        if (data.startsAt && data.endsAt) {
          // FIX: Fetch plan to get consultant user ID for filtering
          const consultationPlan = await tx.consultationPlan.findUnique({
            where: { id: data.planId },
            include: { consultantProfile: { include: { user: true } } },
          });
          if (!consultationPlan) throw new Error("Consultation plan not found");

          // #1463 — the buyer's User id, and the self-held appointments it
          // resolves are excluded from the consultee-side check below too.
          const { selfHoldAppointmentIds } = await validateSlotAvailability(
            tx,
            data,
            userId,
            consultationPlan.consultantProfile.user.id,
            orgContext?.organizationId ?? null,
          );

          // Consultee-side conflict check.
          //
          // validateNoConflicts (SlotValidationService) is scoped to the
          // consultant's User ID — it ensures the consultant is not double-booked
          // but says nothing about the learner's own calendar. A learner who is
          // a member of two orgs (e.g., Org A with SEAT_PACK and Org B with
          // PREPAID_UNLIMITED) faces zero cost friction on either side, making
          // it easy to accidentally book overlapping sessions with two different
          // consultants. Both would pass the consultant-side check because they
          // involve different consultants, leaving the learner double-booked.
          //
          // The same scenario exists on the open marketplace — any consultee can
          // book overlapping sessions with two different consultants. Enterprise
          // multi-org membership increases the probability because the learner
          // has multiple "free" billing paths with no payment step to slow them.
          //
          // We run this query inside the distributed lock and inside the
          // Serializable transaction (TOCTOU-safe). We reuse
          // buildOccupiedAppointmentFilter so the occupancy definition matches
          // validateNoConflicts exactly — TENTATIVE and CONFIRMED both block.
          const consulteeConflict = await tx.appointment.findFirst({
            where: {
              AND: [
                { OR: buildOccupiedAppointmentFilter() },
                // #1319 — parity with step 1 of validateSlotAvailability.
                { NOT: buildDeadHoldFilter(new Date()) },
                // #1463 — and parity with its self-hold exclusion: the buyer's
                // own open order for this exact window is not a competing
                // session on their calendar, it is the thing they are trying to
                // finish paying for. Without this the availability fix above
                // would only move the wall one query to the right.
                ...(selfHoldAppointmentIds.length > 0
                  ? [{ NOT: { id: { in: selfHoldAppointmentIds } } }]
                  : []),
                {
                  slotsOfAppointment: {
                    some: {
                      AND: [
                        { startsAt: { lt: new Date(data.endsAt!) } },
                        { endsAt: { gt: new Date(data.startsAt!) } },
                        // userId (User.id) is the right scope — slots are
                        // connected to User records, not ConsulteeProfile records.
                        // This catches conflicts regardless of which org the
                        // conflicting booking came from or whether it was a
                        // marketplace booking with no org context at all.
                        { user: { some: { id: userId } } },
                      ],
                    },
                  },
                },
              ],
            },
            select: { id: true },
          });
          if (consulteeConflict) {
            throw new Error(
              "You already have a session booked during this time.",
            );
          }
        }
        break;
      }
      case "SUBSCRIPTION": {
        // Only validate if there are slots
        if (data.startsAt && data.endsAt) {
          // FIX: Fetch plan to get consultant user ID for filtering
          const subscriptionPlan = await tx.subscriptionPlan.findUnique({
            where: { id: data.planId },
            include: { consultantProfile: { include: { user: true } } },
          });
          if (!subscriptionPlan) throw new Error("Subscription plan not found");

          // #1463 — the buyer's User id; see the consultation arm above.
          const { selfHoldAppointmentIds } = await validateSlotAvailability(
            tx,
            data,
            userId,
            subscriptionPlan.consultantProfile.user.id,
            orgContext?.organizationId ?? null,
          );

          // Consultee-side conflict check for direct-slot subscriptions.
          // Same reasoning as the CONSULTATION case above — a subscription
          // booked with an explicit slot window must not overlap an existing
          // consultee appointment, regardless of which org or marketplace
          // context that prior appointment came from.
          const subscriptionConsulteeConflict = await tx.appointment.findFirst({
            where: {
              AND: [
                { OR: buildOccupiedAppointmentFilter() },
                // #1319 — parity with step 1 of validateSlotAvailability.
                { NOT: buildDeadHoldFilter(new Date()) },
                // #1463 — same self-hold exclusion as the consultation arm.
                ...(selfHoldAppointmentIds.length > 0
                  ? [{ NOT: { id: { in: selfHoldAppointmentIds } } }]
                  : []),
                {
                  slotsOfAppointment: {
                    some: {
                      AND: [
                        { startsAt: { lt: new Date(data.endsAt!) } },
                        { endsAt: { gt: new Date(data.startsAt!) } },
                        { user: { some: { id: userId } } },
                      ],
                    },
                  },
                },
              ],
            },
            select: { id: true },
          });
          if (subscriptionConsulteeConflict) {
            throw new Error(
              "You already have a session booked during this time.",
            );
          }
        }
        break;
      }

      case "WEBINAR": {
        if (!data.eventId) throw new Error("Event ID is required for webinar");

        const webinar = await tx.webinar.findUnique({
          where: { id: data.eventId },
          include: {
            webinarPlan: {
              include: {
                consultantProfile: true,
              },
            },
            appointment: {
              // `user` is load-bearing: without it the participant count is
              // silently 0 and this whole recheck is dead.
              include: {
                slotsOfAppointment: {
                  include: { user: { select: { id: true } } },
                },
              },
            },
          },
        });

        if (!webinar) throw new Error("Webinar not found");

        const plan = webinar.webinarPlan;
        const consultantUserId = plan.consultantProfile?.userId;
        const capacity = getWebinarCapacity({
          webinar,
          plan,
          excludeUserIds: consultantUserId ? [consultantUserId] : [],
        });

        if (capacity.isFull) {
          throw new Error("Webinar is full");
        }
        break;
      }

      case "CLASS": {
        if (!data.eventId) throw new Error("Event ID is required for class");

        const classInstance = await tx.class.findUnique({
          where: { id: data.eventId },
          include: {
            classPlan: {
              include: { consultantProfile: true },
            },
            appointments: {
              include: {
                slotsOfAppointment: {
                  include: {
                    user: true,
                  },
                },
              },
            },
          },
        });

        if (!classInstance) throw new Error("Class not found");

        const ownerUserId = classInstance.classPlan.consultantProfile?.userId;
        const capacity = getClassCapacity({
          classInstance,
          plan: classInstance.classPlan,
          excludeUserIds: ownerUserId ? [ownerUserId] : [],
        });

        if (capacity.isFull) {
          throw new Error("Class is full");
        }
        break;
      }

      default:
        throw new Error("Invalid appointment type");
    }
  });
}

// ============================================================================
// Appointment Creation Handlers (Type-Specific)
// ============================================================================

export async function handleConsultationCheckout(
  tx: Tx,
  data: CheckoutInput,
  consulteeProfileId: string,
  userId: string,
  skipPayment: boolean,
  /**
   * Resolved org context for this checkout (already validated by caller).
   * Passed through to `Appointment.organizationId` so the org dashboard's
   * `/api/organizations/[orgId]/appointments` query (which filters by
   * `Appointment.organizationId`) actually surfaces fresh org-funded
   * bookings. Without this stamp, only the `Payment` row carried the org
   * tag — leaving the appointment invisible to org admins until backfill.
   *
   * Issue: #674 (personal vs org scope split). The runtime-stamping gap
   * was flagged in the May 2026 production-readiness audit.
   */
  organizationId: string | null,
  /**
   * #1499 — the CancellationPolicy version this sale is governed by, resolved once
   * by the caller so every appointment of one checkout cites the same row.
   */
  cancellationPolicyId: string,
) {
  const plan = await tx.consultationPlan.findUnique({
    where: { id: data.planId },
    include: {
      consultantProfile: {
        include: { user: true },
      },
    },
  });

  if (!plan) {
    throw new Error("Consultation plan not found");
  }

  // userId is the consultee's user ID (passed by caller — no extra DB lookup needed)
  const consultantUserId = plan.consultantProfile.user.id;
  const consulteeUserId = userId;

  // Validate slot availability
  // FIX: Pass consultant user ID to filter by consultant
  // #1463 — the buyer's User id, which is what `Payment.userId` holds.
  await validateSlotAvailability(
    tx,
    data,
    consulteeUserId,
    consultantUserId,
    organizationId,
  );

  // Create consultation
  const initialStatus = skipPayment
    ? AppointmentStatus.APPROVED
    : AppointmentStatus.PENDING;
  const consultation = await tx.consultation.create({
    data: {
      consultationPlanId: plan.id,
      status: initialStatus,
      requestedById: consulteeProfileId,
      requestNotes: data.notes,
      bookingSource: "DIRECT_CHECKOUT",
    },
  });

  // N x 30-minute atoms, both parties on every one (#1071 / ADR B1). Half-hour
  // rows are what conflict detection compares against, and the consultant has
  // to be connected or the user-scoped filter in validateNoConflicts
  // (`user.some.id === consultantUserId`) cannot see the booking at all.
  // #1319 — shared with the webhook capture fallback, which had drifted to one
  // oversized row carrying only the buyer.
  const slotAtoms = buildContiguousSlotAtomsForWindow({
    startsAt: new Date(data.startsAt!),
    endsAt: new Date(data.endsAt!),
    // #440 — denormalized for the DB-level overlap guard.
    consultantProfileId: plan.consultantProfileId,
    isTentative: !skipPayment,
    userIds: [consultantUserId, consulteeUserId],
  });

  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.CONSULTATION,
      consultationId: consultation.id,
      organizationId,
      // B1/#1499 — freeze the refund terms at booking by pointing at the immutable
      // policy version; the cancel flow reads it back through this FK.
      cancellationPolicyId,
      slotsOfAppointment: { create: slotAtoms },
    },
  });
  // #1319 A9 — shadow participant rows, same tx as the slot connects.
  await recordParticipants(
    tx,
    appointment.id,
    [
      { userId: consultantUserId, role: "CONSULTANT" },
      { userId: consulteeUserId, role: "CONSULTEE" },
    ],
    { organizationId, status: skipPayment ? "CONFIRMED" : "HELD" },
  );
  // #1333 — the opening timeline row, written here rather than left to the
  // first CAS so a booking that has not moved yet still has a story. Same tx as
  // the create: a consultation that exists always has one.
  await appendCreationHistory(
    tx,
    "CONSULTATION",
    consultation.id,
    initialStatus,
    { appointmentId: appointment.id, actorUserId: userId, organizationId },
  );

  return { appointment, plan, amount: plan.price };
}

export async function handleSubscriptionCheckout(
  tx: Tx,
  data: CheckoutInput,
  consulteeProfileId: string,
  _skipPayment: boolean,
  /** Resolved org context — see handleConsultationCheckout for rationale. */
  organizationId: string | null,
  /** #1499 — see handleConsultationCheckout. */
  cancellationPolicyId: string,
): Promise<SubscriptionCheckoutResult> {
  const plan = await tx.subscriptionPlan.findUnique({
    where: { id: data.planId },
    include: {
      consultantProfile: {
        include: { user: true },
      },
    },
  });

  if (!plan) {
    throw new Error("Subscription plan not found");
  }

  // Determine if this is a scheduling period request or direct slot booking
  const isSchedulingPeriodRequest =
    data.schedulingPeriodStartsAt && data.schedulingPeriodEndsAt;

  // Calculate subscription dates based on booking type
  const startDate = isSchedulingPeriodRequest
    ? new Date(data.schedulingPeriodStartsAt!)
    : new Date();
  const endDate = isSchedulingPeriodRequest
    ? new Date(data.schedulingPeriodEndsAt!)
    : calculateSubscriptionEndDate(startDate, plan.durationInMonths);

  // Check for existing pending/approved subscriptions with overlapping periods
  // This prevents same user from double-buying the same plan
  const existingSubscription = await tx.subscription.findFirst({
    where: {
      subscriptionPlanId: plan.id,
      requestedById: consulteeProfileId,
      status: {
        in: [
          AppointmentStatus.PENDING,
          AppointmentStatus.APPROVED,
          AppointmentStatus.APPROVED_PENDING_PAYMENT,
        ],
      },
      OR: [
        {
          AND: [
            { schedulingPeriodStartsAt: { lte: endDate } },
            { schedulingPeriodEndsAt: { gte: startDate } },
          ],
        },
      ],
    },
  });

  if (existingSubscription) {
    throw new Error(
      "You already have a pending or active subscription for this plan with overlapping dates.",
    );
  }

  // Create subscription - consultant will allocate slots via Requests tab
  const subscription = await tx.subscription.create({
    data: {
      subscriptionPlanId: plan.id,
      status: AppointmentStatus.PENDING, // Always PENDING until consultant allocates slots
      requestedById: consulteeProfileId,
      requestNotes: data.notes,
      bookingSource: "DIRECT_CHECKOUT",
      schedulingPeriodStartsAt: startDate,
      schedulingPeriodEndsAt: endDate,
      // #1076 — caps bucket on the consultant's days, not the column default.
      schedulingTimezone: resolveSchedulingTimezone(
        plan.consultantProfile?.user?.timezone,
      ),
    },
  });

  // Link any completed trial to this subscription (trial conversion tracking)
  // Find a completed trial from the same consultee for this consultant
  const completedTrial = await tx.trialSession.findFirst({
    where: {
      consulteeProfileId,
      consultantProfileId: plan.consultantProfileId,
      status: TrialSessionStatus.COMPLETED, // Only link completed trials, not pending/scheduled
      convertedToSubscriptionId: null, // Not already linked to another subscription
    },
  });

  if (completedTrial) {
    // Mark the trial as converted and link to this subscription
    // CAS (#1319): the findFirst above filtered COMPLETED; the WHERE here is
    // what makes that hold at write time.
    await transitionTrialSession(tx, {
      where: { id: completedTrial.id },
      to: TrialSessionStatus.CONVERTED,
      data: { convertedToSubscriptionId: subscription.id },
    });

    console.log(
      JSON.stringify({
        event: "trial_converted",
        trialId: completedTrial.id,
        subscriptionId: subscription.id,
        consulteeProfileId,
        consultantProfileId: plan.consultantProfileId,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  // FIX Issue #2: Create placeholder appointment for payment linkage
  // This ensures webhook uses NEW FLOW (confirm) not LEGACY FLOW (create duplicate)
  // Makes this handler symmetrical with others - consultant allocates slots later
  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.SUBSCRIPTION,
      subscriptionId: subscription.id,
      organizationId,
      // #1499 — the placeholder carries the money, so it must carry the terms too:
      // the sessions allocated later inherit this row's policy, and `cancellation-
      // scope` reads the terms off whichever row the Payment hangs on. The old Json
      // snapshot was never written here, which is why the fallback in that module
      // existed at all.
      cancellationPolicyId,
      // No slots created - consultant allocates later via Requests tab
    },
  });
  // #1319 A9 — the placeholder has no slots yet, but the buyer is a
  // participant of the engagement from the moment they hold it.
  const consulteeUser = await tx.consulteeProfile.findUnique({
    where: { id: consulteeProfileId },
    select: { userId: true },
  });
  if (consulteeUser) {
    await recordParticipants(
      tx,
      appointment.id,
      [{ userId: consulteeUser.userId, role: "CONSULTEE" }],
      { organizationId, status: _skipPayment ? "CONFIRMED" : "HELD" },
    );
  }
  // #1333 — see handleConsultationCheckout. Placed after the buyer lookup so
  // the opening row carries the same attribution the participant rows do.
  await appendCreationHistory(
    tx,
    "SUBSCRIPTION",
    subscription.id,
    AppointmentStatus.PENDING,
    {
      appointmentId: appointment.id,
      actorUserId: consulteeUser?.userId ?? null,
      organizationId,
    },
  );

  return {
    appointment,
    subscription,
    plan,
    amount: plan.price,
    isSchedulingPeriodRequest: !!isSchedulingPeriodRequest,
  };
}

export async function handleWebinarCheckout(
  tx: Tx,
  data: CheckoutInput,
  userId: string,
  _skipPayment: boolean,
) {
  const webinar = await tx.webinar.findUnique({
    where: { id: data.eventId },
    include: {
      webinarPlan: {
        include: {
          consultantProfile: true,
        },
      },
      appointment: {
        include: {
          slotsOfAppointment: {
            include: {
              user: { select: { id: true } },
            },
          },
        },
      },
    },
  });

  if (!webinar) {
    throw new Error("Webinar not found");
  }

  const plan = webinar.webinarPlan;
  const consultantUserId = plan.consultantProfile?.userId;
  const capacity = getWebinarCapacity({
    webinar,
    plan,
    excludeUserIds: consultantUserId ? [consultantUserId] : [],
  });

  if (capacity.isFull) {
    throw new Error("Webinar is full");
  }

  // FIX Issue #5: Validate webinar is scheduled before allowing booking
  // Prevents slot timing from defaulting to new Date()
  if (!webinar.appointment?.slotsOfAppointment?.[0]) {
    throw new Error(
      "This webinar has not been scheduled yet. Please wait for the consultant to set a date and time.",
    );
  }

  // Block booking for COMPLETED or CANCELLED webinars
  const blockedStatuses = ["COMPLETED", "CANCELLED"] as const;
  if (
    blockedStatuses.includes(webinar.status as (typeof blockedStatuses)[number])
  ) {
    const message =
      webinar.status === "COMPLETED"
        ? "This webinar has already ended."
        : "This webinar has been cancelled.";
    throw new Error(message);
  }

  // BUG-A FIX: Block booking if the webinar's scheduled end time has already passed.
  // This catches stale SCHEDULED webinars where the consultant never updated the status.
  // Late joiners to IN_PROGRESS webinars are still allowed as long as the end time hasn't passed.
  const masterSlot = webinar.appointment.slotsOfAppointment[0];
  if (masterSlot.endsAt < new Date()) {
    throw new Error(
      "This webinar has already ended. It can no longer accept registrations.",
    );
  }

  // Check if user is already registered for this webinar
  const isAlreadyRegistered = webinar.appointment?.slotsOfAppointment?.some(
    (slot) => slot.user?.some((u) => u.id === userId),
  );
  if (isAlreadyRegistered) {
    throw new Error("You are already registered for this webinar");
  }

  // Create or reuse appointment
  let appointment = webinar.appointment;
  if (!appointment) {
    // Webinar appointments are SHARED across registrants — multiple
    // attendees from different orgs can join the same webinar. So we
    // tag with the WebinarPlan owner's org (the event host's org), not
    // the first registrant's booking org. This makes "events we host"
    // discoverable in the org dashboard, and avoids first-registrant-
    // wins org leakage.
    // #1499 — for the same reason no cancellationPolicyId is stamped: one row
    // cannot carry one buyer's terms when several orgs are seated on it. A null
    // FK reads as the platform ladder, which is what whole-event refunds already
    // assume. Org tiers therefore do not reach event seats — a documented
    // limitation, not an oversight.
    appointment = await tx.appointment.create({
      data: {
        appointmentType: AppointmentsType.WEBINAR,
        webinarId: webinar.id,
        organizationId: plan.organizationId ?? null,
      },
      include: {
        slotsOfAppointment: {
          include: {
            user: { select: { id: true } },
          },
        },
      },
    });
  }

  // Add user to webinar by linking them to ALL existing slots.
  // Webinar participants attend the entire session, so they must be
  // connected to every SlotOfAppointment (not given a new duplicate slot).
  if (appointment && appointment.slotsOfAppointment.length > 0) {
    await connectAttendeeToEventSlots(tx, {
      appointments: [appointment],
      userId,
    });
    // #1319 A9 — one participant row per seat holder.
    await recordParticipants(
      tx,
      appointment.id,
      [{ userId, role: "CONSULTEE" }],
      { status: _skipPayment ? "CONFIRMED" : "HELD" },
    );
  }

  return { appointment, plan, amount: plan.price };
}

export async function handleClassCheckout(
  tx: Tx,
  data: CheckoutInput,
  userId: string,
  _skipPayment: boolean,
) {
  const classInstance = await tx.class.findUnique({
    where: { id: data.eventId },
    include: {
      classPlan: {
        include: { consultantProfile: true },
      },
      appointments: {
        include: {
          slotsOfAppointment: {
            include: {
              user: true,
            },
          },
        },
      },
    },
  });

  if (!classInstance) {
    throw new Error("Class not found");
  }

  const plan = classInstance.classPlan;
  const consultantUserId = plan.consultantProfile?.userId;

  const capacity = getClassCapacity({
    classInstance,
    plan,
    excludeUserIds: consultantUserId ? [consultantUserId] : [],
  });

  if (capacity.isFull) {
    throw new Error("Class is full");
  }

  // H5 FIX: Validate class hasn't already ended (all sessions past).
  // Similar to webinar validation — prevents booking a class whose last session is over.
  if (classInstance.appointments.length > 0) {
    const lastSession =
      classInstance.appointments[classInstance.appointments.length - 1];
    const lastMasterSlot = lastSession.slotsOfAppointment[0];
    if (lastMasterSlot && lastMasterSlot.endsAt < new Date()) {
      throw new Error(
        "This class has already ended. It can no longer accept enrollments.",
      );
    }
  }

  // Check if user is already enrolled - OPT-2: Use extracted utility
  if (isUserEnrolled(classInstance.appointments, userId)) {
    throw new Error("You are already enrolled in this class");
  }

  // B11 — a partially-scheduled class (consultant hasn't allocated every
  // session yet) must not accept paid enrollments: the loop below links the
  // buyer only to EXISTING sessions, silently shorting them the rest.
  const expectedSessions = classInstance.classPlan?.totalSessions;
  if (
    typeof expectedSessions === "number" &&
    expectedSessions > 0 &&
    classInstance.appointments.length < expectedSessions
  ) {
    throw new Error(
      `This class is not fully scheduled yet (${classInstance.appointments.length} of ${expectedSessions} sessions). Enrollment opens once all sessions are scheduled.`,
    );
  }

  // Link user to ALL existing slots of ALL class appointments (sessions).
  // Class participants attend every session, so they must be connected to
  // every existing SlotOfAppointment (not given duplicate slots).
  const linkedSlotCount = await connectAttendeeToEventSlots(tx, {
    appointments: classInstance.appointments,
    userId,
  });
  // #1319 A9 — one participant row per session the buyer is enrolled in.
  for (const appointment of classInstance.appointments) {
    await recordParticipants(
      tx,
      appointment.id,
      [{ userId, role: "CONSULTEE" }],
      { status: _skipPayment ? "CONFIRMED" : "HELD" },
    );
  }

  // Return the first appointment for compatibility
  const firstAppointment = classInstance.appointments[0];
  if (!firstAppointment) {
    throw new Error("No class sessions found");
  }

  return {
    appointment: firstAppointment,
    plan,
    amount: plan.price,
    slotsLinked: linkedSlotCount,
    // For enterprise cap counting (issue #710): one engagement per
    // class day. The learner is enrolling in every existing class
    // appointment at this moment, so the count is fully known here.
    engagementsConsumed: classInstance.appointments.length,
  };
}

// ============================================================================
// Main Checkout Flows
// ============================================================================

/**
 * Ring one org-programme bell for a ProgramAssignment, after the checkout
 * transaction has settled.
 *
 * #1435 — both bells used to run this lookup on the global client from INSIDE
 * the Serializable transaction. Under PG_POOL_MAX=1 that query queues behind
 * the transaction's own connection and dies at the 3 s pg connect timeout, and
 * the .catch below swallowed it, so the bell was lost silently on Netlify.
 *
 * Fire-and-forget: a booking must not fail because a notification did not go
 * out. `Program.organizationId` lives on its parent Contract, not on Program
 * itself, so the select chain hops Program → Contract → Organization.
 */
function dispatchProgramBell(
  programAssignmentId: string,
  bell:
    | { kind: "EXHAUSTED" }
    | {
        kind: "CAP_NEAR";
        engagementsUsed: number;
        cap: number;
        usedPct: number;
      },
): void {
  void prisma.programAssignment
    .findUnique({
      where: { id: programAssignmentId },
      select: {
        membership: {
          select: {
            userId: true,
            user: { select: { name: true, email: true } },
          },
        },
        program: {
          select: {
            name: true,
            contract: {
              select: {
                organizationId: true,
                organization: { select: { name: true } },
              },
            },
          },
        },
      },
    })
    .then((ctx) => {
      if (!ctx) return;
      const orgId = ctx.program.contract.organizationId;
      const common = {
        orgName: ctx.program.contract.organization.name,
        programName: ctx.program.name,
        assigneeName: ctx.membership.user.name ?? ctx.membership.user.email,
        dashboardUrl: `/dashboard/organization/${orgId}/programs`,
      };
      return bell.kind === "EXHAUSTED"
        ? notifyOrgProgramExhausted(orgId, ctx.membership.userId, common)
        : notifyOrgProgramCapNear(orgId, ctx.membership.userId, {
            ...common,
            engagementsUsed: bell.engagementsUsed,
            cap: bell.cap,
            usedPct: bell.usedPct,
          });
    })
    .catch((notifyErr) => {
      console.error(
        bell.kind === "EXHAUSTED"
          ? "[notifyOrgProgramExhausted] failed:"
          : "[notifyOrgProgramCapNear] failed:",
        notifyErr,
      );
      reportSentryError(notifyErr, {
        subsystem: "payments",
        level: "warning",
      });
    });
}

/**
 * Production checkout flow (real payments)
 * Steps:
 * 1. Validate data and calculate amount
 * 2. Create payment intent with gateway
 * 3. Create payment record with PENDING status
 * 4. Return payment intent for client to complete
 * 5. Appointment will be created via webhook after payment success
 */
export async function handleCheckout(
  validatedData: CheckoutInput,
  userId: string,
  isMockPayment: boolean = false,
  buyerCountry: string = "IN",
) {
  let lock: ApprovalLock | ApprovalLock[] | null = null;
  let lockType = "";
  // #898 follow-up — tier-2 consultee lock (acquired alongside the checkout lock
  // below; see the ordering note at STEP 2).
  let consulteeLock: ApprovalLock | null = null;
  // TYPE-1: Properly typed payment response instead of any
  let paymentResponse: { id: string; client_secret: string | null } | null =
    null;

  // Enterprise (Arch 4-Modified): resolve org + Program context up-front.
  //
  //   fundingSource=PERSONAL → org is tagged for reporting only; learner pays.
  //   fundingSource=WALLET   → debit BillingAccount.walletBalance atomically.
  //   fundingSource=INVOICE  → accrue to the org's monthly invoice.
  //   fundingSource=LICENSE  → absorbed by a LICENSED_SEAT program, amount=0.
  //
  // Every non-PERSONAL path also requires an ACTIVE `ProgramAssignment`
  // whose Program covers the current `appointmentType` — that's the source
  // of truth for "is this booking sponsored?". A missing assignment on a
  // WALLET/INVOICE/LICENSE org fails closed: we refuse rather than
  // silently bill the learner's card.
  const appointmentType = validatedData.appointmentType as
    | "CONSULTATION"
    | "SUBSCRIPTION"
    | "WEBINAR"
    | "CLASS";

  let organizationId: string | null = null;
  let billingAccountId: string | null = null;
  let fundingSource: "PERSONAL" | "WALLET" | "INVOICE" | "LICENSE" | null =
    null;
  let programAssignmentId: string | null = null;
  // ADR 18 — Program behind the assignment above; feeds the curated-panel
  // check in revalidateInsideLock.
  let fundingProgramId: string | null = null;
  let callerMembershipId: string | null = null;
  // #785 B6 — effective INVOICE credit limit; threaded to the Serializable
  // booking tx for a race-safe re-check (the pre-lock check below is fast-fail only).
  let creditEffectiveLimit: number | null = null;

  if (validatedData.organizationId) {
    const org = await prisma.organization.findUnique({
      where: { id: validatedData.organizationId },
      select: {
        id: true,
        status: true,
        canSponsor: true,
        billingAccount: {
          select: {
            id: true,
            fundingSource: true,
            creditLimit: true,
            walletBalance: true,
          },
        },
      },
    });
    if (!org) {
      throw new Error("Organization not found.");
    }
    // PR-1d: PENDING_VERIFICATION orgs may transact for INVOICE bookings
    // under the credit-limit gate (#687 invoice-fraud guard). Anything
    // else still requires fully ACTIVE status.
    if (org.status !== "ACTIVE" && org.status !== "PENDING_VERIFICATION") {
      throw new Error(
        `Organization is ${org.status.toLowerCase()}; cannot process bookings.`,
      );
    }
    if (!org.canSponsor) {
      throw new Error(
        "This organization is not configured to sponsor bookings (canSponsor=false).",
      );
    }

    // #812 — dunning-suspend gate (config-gated, default off). The dunning cron's
    // Stage 3 stamps OrganizationInvoice.dunningSuspendedAt once an invoice is
    // unpaid past the grace window; while any such invoice is still OVERDUE, new
    // sponsored bookings for the org are blocked until it is paid. Paying the
    // invoice clears its OVERDUE status, which lifts this gate naturally.
    if (ENABLE_DUNNING_SUSPEND) {
      const suspended = await prisma.organizationInvoice.findFirst({
        where: {
          organizationId: org.id,
          status: "OVERDUE",
          dunningSuspendedAt: { not: null },
        },
        select: { invoiceNumber: true },
        // #750 — cite the OLDEST overdue invoice in the block message, not an
        // arbitrary one.
        orderBy: { dueDate: "asc" },
      });
      if (suspended) {
        // #1467 — same shape as the assignment refusal below: a bare Error here
        // would 500 the moment the flag is switched on. 402 because the block is
        // lifted by paying money that is already owed, which is exactly what
        // Payment Required means to the buyer's client.
        throw Object.assign(
          new Error(
            `This organization has an overdue invoice (${suspended.invoiceNumber}) and is suspended from new sponsored bookings until it is paid.`,
          ),
          { httpStatus: 402, code: "BILLING_SUSPENDED_DUNNING" },
        );
      }
    }

    // SECURITY: Verify the caller is an active Membership of this org.
    const callerMembership = await prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId: org.id } },
      select: { role: true, status: true, id: true },
    });
    if (!callerMembership || callerMembership.status !== "ACTIVE") {
      throw new Error("You are not an active member of this organization.");
    }

    // #701 — DPDP consent gate. The member is having a session booked + paid on
    // their behalf by the org; require a live SESSION_BOOKING consent artifact
    // before processing it. Fail-closed (checkConsent is false with no artifact).
    if (
      !(await checkConsent({
        userId,
        purposeCode: PURPOSE_CODES.SESSION_BOOKING,
      }))
    ) {
      throw Object.assign(
        new Error(
          "Consent required before your organization can book sessions for you. Grant session-booking consent in your organization's privacy settings.",
        ),
        {
          httpStatus: 403,
          code: "CONSENT_REQUIRED",
          purposeCode: "SESSION_BOOKING",
        },
      );
    }

    organizationId = org.id;
    callerMembershipId = callerMembership.id;
    billingAccountId = org.billingAccount?.id ?? null;
    fundingSource = org.billingAccount?.fundingSource ?? "PERSONAL";

    // Block personal referral credits on org-funded bookings.
    if (validatedData.useReferralCredits && fundingSource !== "PERSONAL") {
      validatedData = { ...validatedData, useReferralCredits: false };
    }

    // INVOICE fundingSource: enforce creditLimit. PR-1d (#687):
    // unverified orgs (PENDING_VERIFICATION) get an automatic
    // governance credit-limit even when the BillingAccount.creditLimit
    // column is null — the default ₹50k starter blocks the
    // book-everything-then-ghost abuse pattern. The cap auto-lifts
    // once the org is verified OR pays its first invoice.
    if (fundingSource === "INVOICE") {
      // K-02 / #687 — an org may not accrue INVOICE debt without a verified
      // domain. The credit-limit gate below caps unverified-STATUS orgs; this
      // asserts the orthogonal domain-ownership proof (OrgDomainClaim), the
      // gate governance.ts documents for INVOICE funding but had no caller.
      await assertVerifiedDomainOrThrow(prisma, org.id, "INVOICE_FUNDING");

      const explicitLimit = org.billingAccount?.creditLimit ?? null;
      const isVerified = org.status === "ACTIVE";
      const governanceLimit = isVerified ? null : getInvoiceCreditLimitPaise();
      const effectiveLimit =
        explicitLimit === null
          ? governanceLimit
          : governanceLimit === null
            ? explicitLimit
            : Math.min(explicitLimit, governanceLimit);
      creditEffectiveLimit = effectiveLimit;

      if (effectiveLimit !== null) {
        const [accrualAgg, outstandingAgg] = await Promise.all([
          prisma.paymentLeg.aggregate({
            where: {
              source: { in: ["INVOICE_ACCRUAL", "OVERAGE_INVOICE_ACCRUAL"] },
              payment: {
                organizationId: org.id,
                paymentStatus: "SUCCEEDED",
                billableToOrgInvoiceId: null,
              },
            },
            _sum: { amountPaise: true },
          }),
          prisma.organizationInvoice.aggregate({
            where: {
              organizationId: org.id,
              status: { in: ["ISSUED", "OVERDUE"] },
            },
            _sum: { totalPaise: true },
          }),
        ]);
        const exposure =
          sumPaise(accrualAgg._sum.amountPaise) +
          sumPaise(outstandingAgg._sum.totalPaise);
        if (exposure >= effectiveLimit) {
          throw new Error(
            `Organization has reached its invoice credit limit (${effectiveLimit} paise). Outstanding invoices must be paid before new bookings.`,
          );
        }
      }
    }

    // Resolve a currently-active ProgramAssignment for this member that
    // covers the appointment type. The assignment's Program must be
    // ACTIVE and attached to an ACTIVE contract still within its
    // effectiveFrom..effectiveTo window. The Program's
    // `coveredPlanTypes` array filters which appointment types it
    // sponsors (empty array = covers everything).
    if (fundingSource !== "PERSONAL") {
      const now = new Date();
      const assignment = await prisma.programAssignment.findFirst({
        where: {
          membershipId: callerMembership.id,
          // #1132 follow-up — only a live assignment may sponsor new spend.
          // The period window alone matched ROLLED / CLOSED / CANCELLED rows
          // whose periods a stale PATCH could extend.
          status: "ACTIVE",
          periodStart: { lte: now },
          periodEnd: { gte: now },
          program: {
            status: "ACTIVE",
            OR: [
              { coveredPlanTypes: { isEmpty: true } },
              { coveredPlanTypes: { has: appointmentType } },
            ],
            contract: {
              organizationId: org.id,
              status: "ACTIVE",
              effectiveFrom: { lte: now },
              OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }],
            },
          },
        },
        orderBy: { periodEnd: "desc" },
        select: { id: true, programId: true },
      });

      if (!assignment) {
        // #1467 — a lapsed contract or a closed programme is a routine refusal
        // the member's own admin can undo, but the bare Error matched nothing in
        // BUSINESS_ERROR_PATTERNS and classifyError answered 500 UNKNOWN_ERROR:
        // the buyer could not tell it from a crash and Sentry logged a false
        // incident. 409 because the request is well-formed and the org's
        // entitlement state is what conflicts with it.
        throw Object.assign(
          new Error(
            "No active program assignment covers this booking. Ask your organization admin to assign you to a Program that covers " +
              appointmentType +
              ".",
          ),
          { httpStatus: 409, code: "PROGRAM_ASSIGNMENT_INACTIVE" },
        );
      }
      programAssignmentId = assignment.id;

      // ADR 18 — the Program is resolved HERE, but the authoritative
      // curated-panel check runs inside revalidateInsideLock, where the
      // plan's consultant is loaded and the distributed lock closes the
      // TOCTOU window: allowlist rows exist for the resolved Program ⇒ the
      // booked plan's consultant must be listed. Absent rows keep the
      // network open — sponsors fund any marketplace consultant by design.
      fundingProgramId = assignment.programId;
    }
  }

  try {
    // STEP 1: Calculate amount and fetch plan data (OUTSIDE LOCK - just pricing)
    const {
      amount,
      originalAmount,
      taxAmount,
      currency,
      discountCodeId,
      consulteeProfileId,
      consulteeBillingStateCode,
      creditsApplied,
      buyerCountry: detectedBuyerCountry,
      isInternational,
    } = await calculateAmountAndValidate(
      validatedData,
      userId,
      buyerCountry,
      // #1465-triage — resolved and membership-verified above; the slot gate
      // needs it to scope the self-hold exclusion to a resumable hold.
      organizationId,
    );

    const displayCurrencyAtCheckout =
      validatedData.displayCurrency?.toUpperCase() || currency;

    // Snapshot the displayed exchange rate for auditability.
    let exchangeRateAtCheckout: number | null = null;
    if (displayCurrencyAtCheckout !== "INR") {
      try {
        const rates = await getExchangeRates();
        exchangeRateAtCheckout = rates[displayCurrencyAtCheckout] ?? null;
      } catch {
        // Non-critical — don't block checkout if rate fetch fails
      }
    }

    // Get plan data for consultant ID (needed for lock acquisition)
    const planData = await getPlanDataForLock(validatedData);

    // STEP 2: ACQUIRE DISTRIBUTED LOCK (prevents race conditions)
    // #898 follow-up — also serialize on the consultee so the SAME person can't
    // book two DIFFERENT consultants at overlapping times via concurrent direct
    // checkout. The GiST overlap guard is consultant-keyed, so the consultee-slot
    // conflict in revalidateInsideLock below is otherwise a check-then-write
    // (TOCTOU) window. Global lock order (a total order ⇒ deadlock-free):
    // event/consultant → consultee → slot. So for a slot-based checkout
    // (consultation) the consultee lock is taken BEFORE the slot lock; for an
    // event-based checkout it is taken AFTER the event lock.
    const isSlotBasedCheckout = !!validatedData.startsAt;
    if (isSlotBasedCheckout) {
      consulteeLock = await lockConsulteeBooking(
        userId,
        undefined,
        CHECKOUT_WAIT_RETRY_CONFIG,
      );
    }
    lock = await acquireCheckoutLock(validatedData, planData);
    lockType = validatedData.startsAt ? "slot-based" : "event-based";
    if (!isSlotBasedCheckout) {
      consulteeLock = await lockConsulteeBooking(
        userId,
        undefined,
        CHECKOUT_WAIT_RETRY_CONFIG,
      );
    }

    console.log(
      JSON.stringify({
        event: "checkout_lock_acquired",
        lockType,
        appointmentType: validatedData.appointmentType,
        timestamp: new Date().toISOString(),
      }),
    );

    // STEP 3: RE-VALIDATE INSIDE LOCK (critical for preventing TOCTOU race conditions)
    await revalidateInsideLock(
      validatedData,
      userId,
      fundingProgramId,
      organizationId && callerMembershipId
        ? {
            organizationId,
            callerMembershipId,
            programAssignmentId,
            appointmentType,
          }
        : null,
    );

    console.log(
      JSON.stringify({
        event: "checkout_revalidation_passed",
        appointmentType: validatedData.appointmentType,
        timestamp: new Date().toISOString(),
      }),
    );

    // Enterprise funding derived from BillingAccount.fundingSource +
    // ProgramAssignment (both resolved above). These booleans gate the
    // "skip the gateway entirely" path — org-funded bookings never go
    // through Stripe/Razorpay at checkout time.
    const isOrgWalletPayment =
      fundingSource === "WALLET" && !!programAssignmentId;
    const isOrgInvoicedPayment =
      fundingSource === "INVOICE" && !!programAssignmentId;
    const isOrgLicensedPayment =
      fundingSource === "LICENSE" && !!programAssignmentId;
    const isOrgSponsoredPayment =
      isOrgWalletPayment || isOrgInvoicedPayment || isOrgLicensedPayment;

    // FIX #520: Detect zero-amount payments (credits fully cover cost)
    // Both Stripe and Razorpay reject amount <= 0, so we skip the gateway
    // entirely and treat this like a "free" payment that succeeds immediately.
    const isZeroAmountPayment = amount === 0 && creditsApplied > 0;

    // STEP 4: Create payment intent (INSIDE LOCK)

    // Rec C — adopt an open fresh PENDING order for this user+plan(+org)
    // BEFORE minting anything at the gateway. Runs under the checkout lock
    // (see findReusablePendingOrderPayment for the race-safety argument), so
    // a remount/new tab converges on the first attempt's order instead of
    // charging in parallel. Mock/zero-amount/org-sponsored flows are never
    // PENDING, so the lookup can only ever match a real gateway hold.
    //
    // #1220-triage — candidates are additionally gated on the slot window
    // (a different appointment time must never resume) and on priced-input
    // parity (amount must equal THIS request's computation). Rejections are
    // superseded to EXPIRED so they can neither be resumed later nor re-minted
    // into a parallel charge by a third tab.
    const { reusable: reusableOrder, supersede: supersededOrders } =
      await findReusablePendingOrderPayment(prisma, {
        userId,
        appointmentType,
        planId: validatedData.planId,
        eventId: validatedData.eventId,
        organizationId,
        paymentGateway: validatedData.paymentGateway,
        expectedAmountPaise: amount,
        ...(appointmentType === "CONSULTATION" &&
        validatedData.startsAt &&
        validatedData.endsAt
          ? {
              slotWindow: {
                startsAt: new Date(validatedData.startsAt),
                endsAt: new Date(validatedData.endsAt),
              },
            }
          : {}),
        ...(appointmentType === "SUBSCRIPTION"
          ? {
              schedulingPeriod:
                validatedData.schedulingPeriodStartsAt &&
                validatedData.schedulingPeriodEndsAt
                  ? {
                      startsAt: new Date(
                        validatedData.schedulingPeriodStartsAt,
                      ),
                      endsAt: new Date(validatedData.schedulingPeriodEndsAt),
                    }
                  : null,
            }
          : {}),
      });
    if (supersededOrders.length > 0) {
      // #1463 — expiring the payment is only half of it; the hold it minted has
      // to come off the calendar in the same transaction or this buyer's next
      // attempt walls itself out again. See releaseSupersededHolds.
      await releaseSupersededHolds({
        paymentIds: supersededOrders.map((s) => s.id),
        userId,
      });
      console.log(
        JSON.stringify({
          event: "checkout_open_order_superseded",
          appointmentType,
          count: supersededOrders.length,
          reason: supersededOrders[0].reason,
          timestamp: new Date().toISOString(),
        }),
      );
    }
    if (reusableOrder) {
      console.log(
        JSON.stringify({
          event: "checkout_open_order_reused",
          appointmentType,
          orderId: reusableOrder.paymentIntent,
          // #1220-triage — payment row id, not raw userId (no PII pairing in logs).
          paymentRowId: reusableOrder.id,
          timestamp: new Date().toISOString(),
        }),
      );
      // Same shape as replayByIdempotencyKey's PENDING branch so clients
      // handle both resume paths identically.
      return {
        success: true,
        reused: true,
        orderId: reusableOrder.paymentIntent,
        paymentIntent: {
          id: reusableOrder.paymentIntent,
          client_secret: null,
        },
        amount: Number(reusableOrder.amount),
        currency: reusableOrder.currency,
        isMockPayment: reusableOrder.isMockPayment,
        // #1437 — PENDING reuse is always a real gateway hold (mock/zero/
        // org-sponsored payments never land in PENDING, see the comment
        // above findReusablePendingOrderPayment), so the page must open it.
        skipPayment: reusableOrder.isMockPayment,
        message: "Resuming your in-progress checkout.",
      };
    }

    // #832 — one checked renewal at the long-latency boundary (gateway call
    // + tentative-booking tx still ahead). A false return means the lock
    // already expired and another buyer may hold it; proceeding is exactly
    // the double-booking hazard the lock exists to prevent. A timer-based
    // heartbeat is deliberately avoided: serverless freeze makes intervals
    // unreliable, and the message must contain "already in progress" so
    // classifyError maps it to LOCK_CONTENTION → 409.
    // #1319 (R8) — one renewal here did not cover the Serializable retry loop
    // below: four 25 s attempts outlive a 60 s CONSULTATION grant, and the
    // lock silently lapsed mid-payment. Renew at the top of EVERY attempt
    // with a grant sized to one attempt plus slack, so elapsed time stops
    // mattering; only per-attempt duration does. Ownership lost → abort the
    // attempt (not a P2034, so the retry helper rethrows immediately).
    const checkoutTxTimeoutMs = 25_000;
    const perAttemptTtl = Math.max(
      CHECKOUT_LOCK_TTL_MS[validatedData.appointmentType] ?? 60_000,
      checkoutTxTimeoutMs + 10_000,
    );
    const renewOrAbort = async (ttl: number): Promise<void> => {
      if (!lock) return;
      const renewed = Array.isArray(lock)
        ? await extendSlotInterval(lock, ttl)
        : await extendLock(lock, ttl);
      if (!renewed) {
        throw new Error(
          "Checkout took too long and its hold expired — another checkout for this slot may be already in progress. Please try again.",
        );
      }
    };
    await renewOrAbort(perAttemptTtl);

    // Enterprise org funding skips the gateway entirely.
    if (isOrgSponsoredPayment) {
      const prefix = isOrgWalletPayment
        ? "org_wallet"
        : isOrgLicensedPayment
          ? "org_license"
          : "org_invoice";
      const syntheticId = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      paymentResponse = { id: syntheticId, client_secret: null };
    } else if (isZeroAmountPayment) {
      const freePaymentId = `free_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      paymentResponse = { id: freePaymentId, client_secret: null };
      console.log(
        JSON.stringify({
          event: "zero_amount_payment_detected",
          creditsApplied,
          originalAmount,
          userId,
          timestamp: new Date().toISOString(),
        }),
      );
    } else {
      try {
        paymentResponse = await PaymentIntentManager.createWithCleanup({
          amount,
          currency,
          metadata: buildPaymentMetadata(validatedData, userId, {
            organizationId,
            fundingSource,
          }),
          paymentGateway: validatedData.paymentGateway,
          isMockPayment,
        });
      } catch (paymentError) {
        console.error("Payment intent creation failed:", paymentError);
        reportSentryError(paymentError, { subsystem: "payments" });
        // Typed gateway errors keep their code for the route's classifier.
        if (paymentError instanceof PaymentError) throw paymentError;
        throw new Error(
          "Failed to create payment intent. Please try again later.",
        );
      }
    }

    // STEP 5: Create tentative appointment + payment record (INSIDE LOCK)
    // This prevents race conditions by making validation see tentative bookings
    try {
      // #1093 tail — the ONLY Serializable site that wasn't retried: a P2034
      // under hot-webinar contention surfaced as a generic failure instead of
      // being retried into the sibling's committed state.
      //
      // #1435 — so the body no longer touches the OUTER prisma client at all.
      // Every org-programme bell is CAPTURED inside the transaction and rung
      // once it has settled. The two success-path bells travel out on the
      // transaction's return value, which by construction is the committing
      // attempt's, so a P2034 retry cannot ring them twice; the cap-exhausted
      // bell cannot (it throws), so it rides out on this holder instead.
      const exhaustedBell: { programAssignmentId: string | null } = {
        programAssignmentId: null,
      };

      // #1513 review — provision the platform policy row HERE, on the global
      // client, not from inside the transaction below. The provisioner recovers
      // from a P2002 by re-reading the winner's row, and inside a Serializable
      // transaction a P2002 aborts the transaction, so that re-read would fail
      // and take the sale with it. On the global client every statement is its
      // own autocommit unit, so the loser of the race really does get to re-read.
      // It must also stay OUTSIDE any `$transaction` callback: PG_POOL_MAX=1
      // means a global-client query issued while a transaction holds the single
      // connection deadlocks (#1435, see lib/prisma.ts).
      await ensurePlatformCancellationPolicy(prisma);

      const result = await withSerializableRetry(async () => {
        await renewOrAbort(perAttemptTtl);
        return prisma.$transaction(
          async (tx) => {
            // #1435 — this attempt's bells, returned below and rung post-commit.
            let capNearBell: {
              programAssignmentId: string;
              engagementsUsed: number;
              cap: number;
              usedPct: number;
            } | null = null;
            let overageBell: PendingOverageNotification | null = null;

            // #785 B6 — re-check the INVOICE credit limit INSIDE the Serializable
            // tx. The pre-lock check ran on the global client before this tx, so
            // two concurrent disjoint-slot bookings (which take different per-slot
            // locks) could both pass it. Reading the accrual set here — the same
            // rows this tx is about to add to — makes SSI abort one of a racing
            // pair; the retry then sees the sibling's committed accrual.
            if (
              isOrgInvoicedPayment &&
              creditEffectiveLimit !== null &&
              organizationId
            ) {
              const [accrualAgg, outstandingAgg] = await Promise.all([
                tx.paymentLeg.aggregate({
                  where: {
                    source: {
                      in: ["INVOICE_ACCRUAL", "OVERAGE_INVOICE_ACCRUAL"],
                    },
                    payment: {
                      organizationId,
                      paymentStatus: "SUCCEEDED",
                      billableToOrgInvoiceId: null,
                    },
                  },
                  _sum: { amountPaise: true },
                }),
                tx.organizationInvoice.aggregate({
                  where: {
                    organizationId,
                    status: { in: ["ISSUED", "OVERDUE"] },
                  },
                  _sum: { totalPaise: true },
                }),
              ]);
              const exposure =
                sumPaise(accrualAgg._sum.amountPaise) +
                sumPaise(outstandingAgg._sum.totalPaise);
              // Same gate as the pre-lock check (>= limit), re-run inside the tx so
              // a concurrent sibling's just-committed accrual is visible — SSI then
              // aborts the loser of a racing pair instead of both straddling the cap.
              if (exposure >= creditEffectiveLimit) {
                throw new Error(
                  `Organization has reached its invoice credit limit (${creditEffectiveLimit} paise). Outstanding invoices must be paid before new bookings.`,
                );
              }
            }

            let createdAppointment;
            // Engagement count for enterprise cap (issue #710). One
            // engagement = one Appointment row = one calendar occurrence.
            //   - CONSULTATION/WEBINAR: 1 (single Appointment created here)
            //   - CLASS: N (count of appointments the learner enrolled in,
            //     all known at checkout because consultant pre-allocated)
            //   - SUBSCRIPTION: null → SKIP recordBookingUtilization at
            //     checkout. Slots are allocated lazily by the consultant;
            //     debits land in SlotAllocationService.createAppointments,
            //     1 per allocation batch.
            let engagementsForCap: number | null = null;

            // FIX #520: Zero-amount payments (credits cover full cost) skip the
            // gateway, so slots should be confirmed immediately just like mock payments.
            // Enterprise: org-sponsored payments also skip the gateway.
            const skipPayment =
              isMockPayment || isZeroAmountPayment || isOrgSponsoredPayment;

            // #1499 — whose ladder governs this sale, resolved once inside the
            // booking transaction. Org-funded means the ORG'S MONEY moves on a
            // refund, so the org's published version binds; a personal booking
            // merely tagged to an org keeps the platform ladder.
            const cancellationPolicyId =
              await resolveCheckoutCancellationPolicyId(tx, {
                organizationId: isOrgSponsoredPayment ? organizationId : null,
              });

            // Create appointment based on type (with isTentative flag)
            switch (validatedData.appointmentType) {
              case "CONSULTATION": {
                const consultationResult = await handleConsultationCheckout(
                  tx,
                  validatedData,
                  consulteeProfileId,
                  userId,
                  skipPayment,
                  organizationId,
                  cancellationPolicyId,
                );
                createdAppointment = consultationResult.appointment;
                engagementsForCap = 1;
                break;
              }

              case "SUBSCRIPTION": {
                const subscriptionResult = await handleSubscriptionCheckout(
                  tx,
                  validatedData,
                  consulteeProfileId,
                  skipPayment,
                  organizationId,
                  cancellationPolicyId,
                );
                // Use placeholder appointment for payment linkage
                // This ensures webhook uses NEW FLOW (confirm) not LEGACY FLOW (create duplicate)
                createdAppointment = subscriptionResult.appointment;
                // engagementsForCap stays null — debit happens at
                // SlotAllocationService.createAppointments time.
                break;
              }

              case "WEBINAR": {
                const webinarResult = await handleWebinarCheckout(
                  tx,
                  validatedData,
                  userId,
                  skipPayment,
                );
                createdAppointment = webinarResult.appointment;
                engagementsForCap = 1;
                break;
              }

              case "CLASS": {
                const classResult = await handleClassCheckout(
                  tx,
                  validatedData,
                  userId,
                  skipPayment,
                );
                // Class creates slots across multiple appointments
                // Use first appointment for payment linkage
                createdAppointment = classResult.appointment || null;
                engagementsForCap = classResult.engagementsConsumed;
                break;
              }

              default:
                throw new Error(
                  `Unsupported appointment type: ${validatedData.appointmentType}`,
                );
            }

            // Create payment record linked to appointment (if created)
            // paymentResponse is guaranteed to be set at this point (we'd have thrown in the try-catch above)
            const payment = await tx.payment.create({
              data: {
                amount,
                originalAmount,
                taxAmount,
                currency,
                paymentMethod: isOrgWalletPayment
                  ? "WALLET"
                  : isOrgInvoicedPayment
                    ? "INVOICE"
                    : isOrgLicensedPayment
                      ? "LICENSE"
                      : isZeroAmountPayment
                        ? "CREDITS"
                        : "CARD",
                paymentIntent: paymentResponse!.id,
                // #828 — unique; a concurrent duplicate attempt dies on P2002
                // and the route replays this payment's original response.
                clientIdempotencyKey:
                  validatedData.clientIdempotencyKey ?? null,
                paymentGateway: validatedData.paymentGateway,
                // FIX #520: Zero-amount and mock payments succeed immediately (no webhook)
                paymentStatus: skipPayment
                  ? PaymentStatus.SUCCEEDED
                  : PaymentStatus.PENDING,
                isMockPayment:
                  isMockPayment || isZeroAmountPayment || isOrgSponsoredPayment,
                userId: userId,
                appointmentId: createdAppointment?.id || null,
                discountCodeId,
                expiresAt: skipPayment
                  ? null
                  : new Date(Date.now() + 30 * 60 * 1000), // 30 minutes
                buyerCountry: detectedBuyerCountry,
                isInternational,
                displayCurrencyAtCheckout,
                exchangeRateAtCheckout,
                // #1365 — GST place of supply for the tax invoice: what the
                // buyer declared here, else what their profile already holds,
                // else null (the s.12(2)(b) supplier-state default).
                consumerStateCode:
                  validatedData.consumerStateCode ??
                  consulteeBillingStateCode ??
                  null,
                // Enterprise (Arch 4): org tag for reporting / billing.
                organizationId,
                billingAccountId,
              },
            });

            // #1365 — remember a newly declared billing state on the profile so
            // a repeat buyer is never asked for it twice. Same transaction as
            // the Payment: the declaration and the supply it applies to are one
            // fact. updateMany, so a missing profile is a no-op, not a throw.
            if (
              validatedData.consumerStateCode &&
              validatedData.consumerStateCode !== consulteeBillingStateCode
            ) {
              await tx.consulteeProfile.updateMany({
                where: { userId },
                data: { billingStateCode: validatedData.consumerStateCode },
              });
            }

            // #1319 A9 — stamp the funding Payment on the participant rows and,
            // when no gateway leg follows (mock / zero-amount / org-sponsored),
            // confirm them here since no capture webhook ever will.
            if (createdAppointment) {
              const participantWhere =
                validatedData.appointmentType === "CLASS" &&
                validatedData.eventId
                  ? { appointment: { classId: validatedData.eventId }, userId }
                  : validatedData.appointmentType === "WEBINAR"
                    ? { appointmentId: createdAppointment.id, userId }
                    : { appointmentId: createdAppointment.id };
              if (
                validatedData.appointmentType === "CLASS" &&
                validatedData.eventId
              ) {
                // Cross-appointment scope (every session of the class); the
                // helper is per-appointment.
                await tx.appointmentParticipant.updateMany({
                  where: { ...participantWhere, paymentId: null },
                  data: { paymentId: payment.id },
                });
              } else {
                await linkParticipantsToPayment(
                  tx,
                  createdAppointment.id,
                  payment.id,
                  validatedData.appointmentType === "WEBINAR"
                    ? userId
                    : undefined,
                );
              }
              if (skipPayment) {
                await setParticipantStatus(tx, participantWhere, "CONFIRMED");
              }
            }

            // Enterprise: WALLET fundingSource — debit from BillingAccount
            // atomically via the wallet helper (raw-SQL conditional UPDATE).
            // Triggered only when we also have a resolved program assignment,
            // which guarantees the booking is actually sponsored.
            if (isOrgWalletPayment && billingAccountId) {
              // #837 — refuse to spend a wallet whose cache drifted from the
              // journal (frozen by the ledger-reconcile job): the balance can't
              // be trusted until ops reconciles. Chargeback recovery is NOT gated
              // (see wallet-freeze.ts).
              if (await isWalletFrozen(tx, billingAccountId)) {
                throw new WalletFrozenError(billingAccountId);
              }
              await walletDebit(tx, {
                billingAccountId,
                amountPaise: amount,
                reason: "BOOKING",
                paymentId: payment.id,
                membershipId: callerMembershipId ?? undefined,
              });
            }

            // Enterprise: write the Program utilization row + a PaymentLeg
            // that describes where the money (or commitment) actually came
            // from. This is the runtime source of truth for sponsorship
            // attribution — analytics / invoicing / cap enforcement all read
            // these rows rather than back-deriving from `paymentMethod`.
            //
            // E2E-audit F-1 fix — the FUNDING LEG is written for every
            // org-sponsored payment, INCLUDING SUBSCRIPTION. Subscriptions
            // meter engagements lazily (at allocation), but their money moves
            // HERE: the wallet debit above journals against the WALLET leg in
            // the ledger, the invoice rollup only collects INVOICE_ACCRUAL
            // legs, and refunds credit wallets back leg-proportionally.
            // Skipping the leg made (SUBSCRIPTION × WALLET) journal real
            // money as platform CASH (guaranteed WALLET_BALANCE_DRIFT →
            // auto-frozen wallet), left (SUBSCRIPTION × INVOICE) permanently
            // unbilled, and gave (SUBSCRIPTION × LICENSE) no fulfillment
            // proof. Utilization metering stays gated on engagementsForCap.
            if (programAssignmentId && isOrgSponsoredPayment) {
              await tx.paymentLeg.create({
                data: {
                  paymentId: payment.id,
                  source: isOrgWalletPayment
                    ? "WALLET"
                    : isOrgLicensedPayment
                      ? "LICENSE"
                      : "INVOICE_ACCRUAL",
                  // LICENSE absorbs the cost entirely at the contract level
                  // — the per-booking leg is zero so totals across all legs
                  // still reconcile to the Payment amount.
                  amountPaise: isOrgLicensedPayment ? 0 : amount,
                  sourceRef: programAssignmentId,
                },
              });
            }

            if (
              programAssignmentId &&
              isOrgSponsoredPayment &&
              engagementsForCap !== null
            ) {
              let utilizationResult: Awaited<
                ReturnType<typeof recordBookingUtilization>
              > = {
                wasOverage: false,
                engagementsConsumedDelta: 0,
                engagementsUsedAfter: 0,
                cap: null,
                programType: "LICENSED_SEAT",
                consumedPaiseAfter: 0,
                creditBudgetPaise: null,
              };
              try {
                utilizationResult = await recordBookingUtilization(tx, {
                  programAssignmentId,
                  paymentId: payment.id,
                  engagementsConsumed: engagementsForCap,
                  priceAtBookingPaise: amount,
                  // PR-1e (G3) — the helper's set-diff idempotency guard only
                  // arms itself when the caller NAMES the appointments.
                  // Omitting them left every checkout debit unguarded, so a
                  // replay against the same Payment (retried webhook, resumed
                  // order) incremented the meter a second time.
                  // CONSULTATION/WEBINAR are one engagement on the appointment
                  // just created; CLASS meters one per class session, which is
                  // exactly the set handleClassCheckout counted.
                  appointmentIds:
                    validatedData.appointmentType === "CLASS"
                      ? (
                          await tx.appointment.findMany({
                            where: { classId: validatedData.eventId },
                            select: { id: true },
                          })
                        ).map((a) => a.id)
                      : createdAppointment
                        ? [createdAppointment.id]
                        : [],
                });
              } catch (err) {
                if (err instanceof ProgramAssignmentLimitError) {
                  // The assignee + org operators are told the programme is
                  // spent. This is the one bell that belongs on the ROLLBACK
                  // path — the refusal IS the news — so it is rung from the
                  // retry wrapper's catch rather than after a commit that
                  // never happens.
                  exhaustedBell.programAssignmentId = programAssignmentId;

                  // #1458 — a stable code, because the message-preservation
                  // list below never matched this sentence and the buyer got
                  // "Failed to record payment information" for a cap they can
                  // ask an admin to raise.
                  throw Object.assign(
                    new Error(
                      "Your program has hit its session cap for this cycle. Ask your organization admin to upgrade the program or wait for the next cycle.",
                    ),
                    { httpStatus: 402, code: "PROGRAM_SESSION_CAP_REACHED" },
                  );
                }
                throw err;
              }

              // #768 #22 — 80% cap-near early warning. Fire ONCE per cycle on
              // the <80% → >=80% transition (not on every booking past 80%).
              // Integer-only threshold cross: before/cap < 0.8 (before*5 <
              // cap*4) AND after/cap >= 0.8 (after*5 >= cap*4). Skipped when
              // cap is null (unlimited) or 0. Captured for post-commit
              // delivery + same roster as the 100% event.
              {
                // #775 — LICENSED_SEAT meters in engagements, CREDIT_POOL in
                // paise (consumedPaise vs creditBudgetPaise). The 80% transition
                // math is unit-agnostic; the Novu payload reports credits for
                // pools (÷100) and engagements for seats.
                const isCredit =
                  utilizationResult.programType === "CREDIT_POOL";
                const capAfter = isCredit
                  ? utilizationResult.creditBudgetPaise
                  : utilizationResult.cap;
                const after = isCredit
                  ? utilizationResult.consumedPaiseAfter
                  : utilizationResult.engagementsUsedAfter;
                const before = isCredit
                  ? after - amount
                  : after - utilizationResult.engagementsConsumedDelta;
                if (
                  capAfter != null &&
                  capAfter > 0 &&
                  before * 5 < capAfter * 4 &&
                  after * 5 >= capAfter * 4
                ) {
                  // #1169 PR 2 — the bell must ring once per booking, not once
                  // per Serializable attempt. The slot is a local of this
                  // attempt and only the committing attempt's is returned,
                  // which is what enforces that now.
                  capNearBell = {
                    programAssignmentId,
                    engagementsUsed: isCredit ? Math.round(after / 100) : after,
                    cap: isCredit ? Math.round(capAfter / 100) : capAfter,
                    usedPct: Math.round((after / capAfter) * 100),
                  };
                }
              }

              // C2: overage charging. recordBookingUtilization above flagged
              // `wasOverage = true` if the increment crossed the cap (only
              // possible when overageBehavior is CHARGE_MEMBER or CHARGE_ORG;
              // BLOCK throws inside the helper). Branch on the program's
              // configured behavior (#775):
              //   - CHARGE_ORG: write an OVERAGE_INVOICE_ACCRUAL PaymentLeg +
              //     OverageEvent(PENDING). The monthly invoice rollup picks it
              //     up (→ ACCRUED) and the invoice-paid handler marks it CHARGED.
              //   - CHARGE_MEMBER: the booking proceeds; the member owes the
              //     marginal. Create a parent-linked PENDING side-Payment +
              //     OverageEvent(PENDING). The member completes it via the
              //     resume-checkout surface (order created there, not in this TX)
              //     and the gateway webhook transitions it → CHARGED.
              //   - BLOCK behavior: never reaches here (helper already threw).
              //     The circuit-breaker veto is the only BLOCK decision here.
              if (utilizationResult.wasOverage) {
                // #778 elegance — extracted to recordOverageAtCheckout (resolves
                // the behaviour via computeOverage, enforces the circuit breaker,
                // persists the OverageEvent + CHARGE_MEMBER side-Payment /
                // CHARGE_ORG accrual leg). Throws PROGRAM_CAP_EXHAUSTED (402) on
                // the breaker veto.
                overageBell = await recordOverageAtCheckout({
                  tx,
                  programAssignmentId,
                  utilization: {
                    programType: utilizationResult.programType,
                    engagementsConsumedDelta:
                      utilizationResult.engagementsConsumedDelta,
                    engagementsUsedAfter:
                      utilizationResult.engagementsUsedAfter,
                    consumedPaiseAfter: utilizationResult.consumedPaiseAfter,
                    creditBudgetPaise: utilizationResult.creditBudgetPaise,
                  },
                  bookingPricePaise: amount,
                  currency,
                  paymentId: payment.id,
                  userId,
                  organizationId,
                  paymentGateway: validatedData.paymentGateway,
                });
              }
            }

            // Enterprise: every successful Payment must have at least one
            // PaymentLeg (`docs/enterprise/10-money-and-ledger/09-payment-legs.md`). For non-
            // org-sponsored learner-pays-via-gateway flows that's the CARD
            // leg, written here so the invariant holds whether or not the
            // payment ever transitions to SUCCEEDED. We record the gateway
            // payment-intent id in `sourceRef` so refund / reconciliation
            // jobs can join back to the gateway txn without scanning the
            // Payment table. `amount` is the post-credit gateway charge,
            // mirroring the field-level comment on `Payment.amount`, so this
            // one leg alone carries the funding identity: the REFERRAL_CREDIT
            // leg `applyCreditsToPayment` writes further down in this same TX
            // is excluded from the sum rather than added to it (#1347).
            if (!isOrgSponsoredPayment && amount > 0) {
              await tx.paymentLeg.create({
                data: {
                  paymentId: payment.id,
                  source: "CARD",
                  amountPaise: amount,
                  sourceRef: paymentResponse!.id,
                },
              });
            }

            // Increment discount code usage count atomically (only after payment is created)
            // This ensures count only increases when payment is successfully created.
            // Re-validate maxUses inside the Serializable TX: two concurrent checkouts could
            // both pass the check in calculateAmountAndValidate (non-Serializable TX) and
            // both reach here. The Serializable re-read ensures only one succeeds.
            if (discountCodeId) {
              const discountForIncrement = await tx.discountCode.findUnique({
                where: { id: discountCodeId },
                select: { maxUses: true, currentUses: true },
              });

              if (!discountForIncrement) {
                throw new Error(
                  "Discount code is no longer available. Please remove the code and try again.",
                );
              }

              if (
                discountForIncrement.maxUses !== null &&
                discountForIncrement.currentUses >= discountForIncrement.maxUses
              ) {
                throw new Error(
                  "Discount code has reached maximum uses — please remove the code and try again.",
                );
              }
              await tx.discountCode.update({
                where: { id: discountCodeId },
                data: { currentUses: { increment: 1 } },
              });
            }

            // FIX A3: Re-read credits inside the main transaction to prevent stale reads.
            // creditsApplied was calculated in TX1 (calculateAmountAndValidate), but between
            // TX1 and TX2, concurrent checkouts may have consumed the credits.
            let actualCreditsApplied = 0;
            if (creditsApplied > 0) {
              const { totalAvailable } = await getUserCredits(userId, tx);
              // Both creditsApplied and totalAvailable are in paise — direct comparison
              const actualCredits = Math.min(totalAvailable, creditsApplied);

              if (actualCredits > 0) {
                await applyCreditsToPayment(
                  userId,
                  actualCredits,
                  tx,
                  payment.id,
                );
                console.log(
                  `🎁 Applied ${actualCredits} paise referral credits for user ${userId}` +
                    (actualCredits !== creditsApplied
                      ? ` (requested ${creditsApplied} paise, available ${totalAvailable} paise)`
                      : ""),
                );
              }

              // FIX #2: If fewer credits were available than expected (due to concurrent
              // checkout consuming them between TX1 and TX2), abort the transaction.
              // The payment intent was created with a reduced amount based on TX1's
              // credit calculation, so proceeding would undercharge the user.
              if (actualCredits < creditsApplied) {
                throw new Error(
                  `CREDIT_SHORTFALL: expected ${creditsApplied} paise credits but only ${actualCredits} available. ` +
                    `Payment ${payment.id} amount is stale. Aborting for retry.`,
                );
              }
              actualCreditsApplied = creditsApplied; // In paise
            }

            // Invariant sweep: every Payment should have legs that sum to
            // `Payment.amount`, excluding REFERRAL_CREDIT, which is already
            // netted out of it (#1347) —
            // `docs/enterprise/10-money-and-ledger/09-payment-legs.md`. We
            // log-only here rather than throw because the hot checkout
            // path is the worst place to discover a leg-accounting drift
            // — a surprise 500 blocks real bookings. A mismatch signals
            // either (a) an org branch above wrote the wrong amount, or
            // (b) a future PaymentLegSource was added without updating
            // its write site. Reconciliation jobs + tests call the
            // hard-throwing `assertPaymentLegsSumToAmount` instead.
            if (!isMockPayment) {
              const writtenLegs = await tx.paymentLeg.findMany({
                where: { paymentId: payment.id },
                select: { source: true, amountPaise: true },
              });
              const legMismatch = checkPaymentLegsSumToAmount({
                paymentAmountPaise: payment.amount,
                legs: writtenLegs,
              });
              if (legMismatch) {
                console.warn(
                  JSON.stringify({
                    event: "payment_leg_sum_mismatch",
                    paymentId: payment.id,
                    organizationId: validatedData.organizationId ?? null,
                    appointmentType: validatedData.appointmentType,
                    ...legMismatch,
                  }),
                );
              }
            }

            return {
              appointmentId: createdAppointment?.id,
              creditsApplied: actualCreditsApplied,
              capNearBell,
              overageBell,
            };
          },
          {
            timeout: checkoutTxTimeoutMs,
            // H6 FIX: Use Serializable isolation for booking transactions to prevent
            // phantom reads on capacity-limited events (webinars, classes). The
            // distributed lock serializes per-event, but Serializable adds DB-level
            // safety for edge cases like lock expiry under high load.
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          },
        );
      }).catch((err) => {
        // #1435 — post-rollback delivery for the one bell whose news IS the
        // refusal. Nothing else below is reached when the transaction fails.
        if (exhaustedBell.programAssignmentId) {
          dispatchProgramBell(exhaustedBell.programAssignmentId, {
            kind: "EXHAUSTED",
          });
        }
        throw err;
      });

      // #1435 — post-COMMIT delivery for the bells that describe a booking that
      // actually happened. See dispatchProgramBell for why neither lookup can
      // run inside the transaction.
      if (result.capNearBell) {
        dispatchProgramBell(result.capNearBell.programAssignmentId, {
          kind: "CAP_NEAR",
          engagementsUsed: result.capNearBell.engagementsUsed,
          cap: result.capNearBell.cap,
          usedPct: result.capNearBell.usedPct,
        });
      }
      if (result.overageBell) {
        notifyOverageDueAfterCommit(result.overageBell);
      }

      const logMessage = isZeroAmountPayment
        ? `🎁 Zero-amount payment (credits covered full cost) + appointment created: ${paymentResponse.id}`
        : isMockPayment
          ? `🎭 Mock payment + tentative appointment created: ${paymentResponse.id}`
          : `💳 Payment intent + tentative appointment created: ${paymentResponse.id} - Waiting for payment confirmation`;

      console.log(logMessage);
      console.log(
        JSON.stringify({
          event: "checkout_appointment_created",
          appointmentType: validatedData.appointmentType,
          appointmentId: result.appointmentId,
          isMockPayment,
          timestamp: new Date().toISOString(),
        }),
      );

      // Mock/zero-amount/org-sponsored payment post-processing: referral
      // qualifying action. Real payments handle this via
      // handlePaymentSuccess() in the webhook, but these flows bypass
      // webhooks entirely.
      if (isMockPayment || isZeroAmountPayment || isOrgSponsoredPayment) {
        // Trigger referral reward if this is the user's first paid booking
        try {
          await processQualifyingAction(userId, "first_paid_booking");
        } catch (referralError) {
          console.error(
            `⚠️ Failed to process referral qualifying action for user ${userId}:`,
            referralError,
          );
          reportSentryError(referralError, {
            subsystem: "payments",
            level: "warning",
          });
        }

        // Create consultant earnings (mock payments bypass webhooks, so earnings must be created here)
        try {
          const resolved = await resolvePaymentForEarnings(
            { paymentIntent: paymentResponse!.id },
            validatedData.appointmentType,
          );

          if (resolved) {
            await createEarningsFromPayment({
              payment: resolved.paymentForEarnings,
              appointmentType: resolved.earningsAppointmentType,
            });

            console.log(
              `💰 Mock payment earnings created for consultant ${resolved.consultantProfileId}`,
            );
          }
        } catch (earningsError) {
          // C-01 #837 — payment + booking are committed but earnings + the
          // BOOKING journal are not. Real money moved, so we don't roll back
          // and we don't pretend success with a silent warning: page (ERROR)
          // and durably record the ledger gap. The healer is the data-state
          // sync-payment-earnings scan (SUCCEEDED payment + earnings:none),
          // keyed on row state — not on this marker — so it's guaranteed and
          // idempotent even if this alert is lost.
          await recordSystemError({
            category: "PAYOUT",
            summary: `Earnings + booking journal not written for committed payment ${paymentResponse!.id} (checkout mock/zero/sponsored path)`,
            err: earningsError,
            correlationId: paymentResponse!.id,
            context: {
              paymentIntent: paymentResponse!.id,
              userId,
              appointmentType: validatedData.appointmentType,
              path: "checkout",
            },
          });
          console.error(
            `⚠️ Failed to create earnings for mock payment:`,
            earningsError,
          );
        }

        // #1365 — these payments never see a capture webhook, so the tax
        // invoice has to be minted here too. Org-sponsored payments no-op
        // inside the minter by design; they are invoiced on the org series.
        await mintConsumerInvoiceBestEffort({
          paymentIntent: paymentResponse!.id,
        });

        // FIX #437: Consultant qualifying action (receiving first paid booking)
        try {
          await processConsultantBookingReferral(
            { paymentIntent: paymentResponse!.id },
            userId,
          );
        } catch (consultantRefError) {
          console.error(
            `⚠️ Failed to process consultant referral qualifying action:`,
            consultantRefError,
          );
          reportSentryError(consultantRefError, {
            subsystem: "payments",
            level: "warning",
          });
        }
      }

      return {
        success: true,
        paymentIntent: paymentResponse,
        message: isZeroAmountPayment
          ? "Payment completed via referral credits. Appointment booked successfully."
          : isMockPayment
            ? "Mock payment completed and appointment created successfully"
            : isOrgSponsoredPayment
              ? "Payment completed via organization funding. Appointment booked successfully."
              : "Payment intent created. Complete payment to book appointment.",
        amount,
        currency,
        isMockPayment: isMockPayment || isZeroAmountPayment,
        isZeroAmountPayment,
        // #1437 — WALLET/INVOICE/LICENSE org funding also confirms
        // synchronously with a synthetic org_* id and no gateway order;
        // isMockPayment/isZeroAmountPayment don't cover it, so the client
        // was opening Razorpay on an id the gateway had never heard of.
        // Matches checkout-replay.ts's SUCCEEDED-branch field name.
        skipPayment:
          isMockPayment || isZeroAmountPayment || isOrgSponsoredPayment,
      };
    } catch (dbError) {
      console.error("Failed to create payment record:", dbError);
      // Classification for Sentry tagging ONLY — deliberately NOT the same
      // list `preservedMessages` below uses for the rethrow decision, so
      // adding a tagging-only pattern here can never change which message
      // reaches the caller.
      const modelledOutcomePatterns = [
        "already registered",
        "already enrolled",
        "full",
        "cancelled",
        "ended",
        "not been scheduled",
        "already have a pending or active subscription",
        "already have a session booked", // consultee double-book (FAMILIARISE_WEB-P)
        "overlapping dates",
        "insufficient credits",
        "session cap", // ProgramAssignmentLimitError-derived message, above
        // #1132 — slot contention is a modelled outcome, not a fault. These
        // were added to `preservedMessages` below so the user gets a real
        // message, but tagging is a separate list by design (see comment
        // above), so without them here every lost slot raced to Sentry as
        // `expected: false` and normal contention looked like a payment
        // incident.
        "already booked",
        "no longer available",
      ];
      // Typed errors and stable codes first — a substring is a last resort,
      // not the mechanism. recordOverageAtCheckout stamps
      // code: "PROGRAM_CAP_EXHAUSTED" on its 402, which this used to miss
      // entirely and report as a fault.
      const dbErrorCode = (dbError as { code?: unknown } | null)?.code;
      const isModelledOutcome =
        dbError instanceof WalletFrozenError ||
        dbError instanceof ProgramAssignmentLimitError ||
        dbErrorCode === "PROGRAM_CAP_EXHAUSTED" ||
        // #1458 — the per-assignment session cap is the same class of modelled
        // refusal as the per-cycle overage ceiling above. The overage funding
        // codes are deliberately NOT here: they mean a programme was configured
        // in a shape we cannot collect on, which has to keep paging.
        dbErrorCode === "PROGRAM_SESSION_CAP_REACHED" ||
        // #1477 — an org that has spent its wallet down is refusing the
        // booking, not faulting on it. The rethrow below already lets it
        // through on its registered code; tagging is a separate list by
        // design, so without this line the routine refusal kept paging.
        dbErrorCode === "WALLET_INSUFFICIENT_FUNDS" ||
        (dbError instanceof Error &&
          modelledOutcomePatterns.some((msg) =>
            // Word-bounded: bare `includes` let "full" match "successful" and
            // "ended" match "unintended", tagging real faults as routine.
            new RegExp(`\\b${msg}\\b`, "i").test(dbError.message),
          ));
      reportSentryError(dbError, {
        subsystem: "payments",
        expected: isModelledOutcome,
      });

      // CRITICAL: Cancel payment intent since DB operation failed
      // (Skip cleanup for zero-amount payments — they have no real gateway intent)
      if (paymentResponse && !isZeroAmountPayment) {
        await PaymentIntentManager.cleanup(
          paymentResponse.id,
          "Database operation failed - preventing orphaned payment intent",
        );
      }

      // #837 — WalletFrozenError carries httpStatus=409 + an actionable reason;
      // don't let it collapse into the generic "Failed to record payment
      // information" below. Rethrow so the route surfaces the 409.
      if (dbError instanceof WalletFrozenError) {
        throw dbError;
      }

      // #1458 — an error carrying a registered business code already resolves
      // to its own status and toast in the classifier, so rewriting it to the
      // generic message below is pure loss: PROGRAM_CAP_EXHAUSTED was thrown as
      // a 402 with actionable copy and reached the buyer as a 500
      // "Something Went Wrong". Codes are checked before messages because a
      // code survives a reworded sentence and a substring does not.
      if (dbError instanceof Error && isBusinessErrorCode(dbErrorCode)) {
        throw dbError;
      }

      // Preserve specific error messages (duplicate registration, full capacity, etc.)
      if (dbError instanceof Error) {
        const preservedMessages = [
          "already registered",
          "already enrolled",
          "full",
          "cancelled",
          "ended",
          "not been scheduled",
          "already have a pending or active subscription",
          "already have a session booked", // consultee double-book (FAMILIARISE_WEB-P)
          "overlapping dates",
          "insufficient credits",
          // #1132 — validateSlotAvailability throws these from INSIDE the
          // transaction, so without them here a genuine slot conflict was
          // rewritten to "Failed to record payment information" → UNKNOWN →
          // "Something Went Wrong", and the user had no idea to pick another
          // slot. ADR 16's clean-error claim only held for the pre-transaction
          // check.
          "already booked",
          "no longer available",
        ];
        if (
          preservedMessages.some((msg) =>
            dbError.message.toLowerCase().includes(msg),
          )
        ) {
          throw dbError;
        }
      }

      throw new Error(
        "Failed to record payment information. Please try again.",
      );
    }
  } catch (error) {
    // Outermost boundary — also catches validation errors from
    // calculateAmountAndValidate/acquireCheckoutLock/revalidateInsideLock
    // (steps 1-3, above the STEP-5 try/catch that already reports) which
    // otherwise reach here uncaptured. Lock contention is a modelled,
    // expected race between two concurrent checkouts; consultee double-book
    // from revalidateInsideLock is the same class of rejection (FAMILIARISE_WEB-P).
    // Anything else here is unclassified and reported as a fault by default.
    const isLockContention =
      error instanceof Error &&
      (error.message.includes("currently checking out") ||
        error.message.includes("currently being booked"));
    // Tag-only: the explicit lock-expiry throw above ("...already in
    // progress...") is the same modelled race, but is NOT folded into
    // isLockContention — that variable also picks the rethrow message below,
    // and this message already classifies correctly downstream (LOCK_CONTENTION
    // via payment-error-classification.ts), so changing it would misroute it
    // to AVAILABILITY instead.
    const isModeledLockRace =
      isLockContention ||
      (error instanceof Error && error.message.includes("already in progress"));
    const isConsulteeDoubleBook =
      error instanceof Error &&
      error.message.toLowerCase().includes("already have a session booked");
    // #1477 — the inner catch rethrows anything carrying a registered business
    // code, so every one of those refusals arrives here too and was re-reported
    // as a fault, undoing the `expected: true` it had just been given. Asking
    // the classifier the same question it will answer for the response keeps
    // the two verdicts from disagreeing.
    const isBusinessRefusal = isBusinessErrorCode(
      (error as { code?: unknown } | null)?.code,
    );
    reportSentryError(error, {
      subsystem: "payments",
      expected: isModeledLockRace || isConsulteeDoubleBook || isBusinessRefusal,
    });
    // Enhanced error handling with lock-specific errors
    if (isLockContention) {
      throw new Error(
        "Another user is currently booking this slot. Please wait a few seconds and try again.",
      );
    }
    throw error;
  } finally {
    // ALWAYS RELEASE LOCKS (even on error). Release order doesn't affect
    // deadlock-freedom (only acquisition order does), so both are freed here.
    if (lock) {
      await releaseCheckoutLock(lock, lockType);
    }
    if (consulteeLock) {
      await unlockConsulteeBooking(consulteeLock);
    }
  }
}
