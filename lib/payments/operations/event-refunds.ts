import { reportSentryError } from "@/lib/observability/report";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { recordSystemError } from "@/lib/enterprise/system-events";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
import { getAppUrl } from "@/lib/url";
import { notifyRefundProcessed } from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { applyReversal } from "./reversal-engine";
import { refundPayment, RefundValidationError } from "./refund";
import {
  isFreeCreditIntent,
  isInternalFundedIntent,
  refundBookingPayment,
  type FundingRail,
} from "./booking-refund";
import { computeRefundPct } from "./cancellation-policy";
import {
  POLICY_TERMS_INCLUDE,
  termsFromPolicyRow,
} from "./cancellation-policy-store";
import { findLiveEventSlot } from "@/lib/appointments/live-event-slot";

/**
 * Whole-event refund (#776 §C) — the production front door for the reversal
 * engine's CLASS_MULTI path.
 *
 * A cancelled class/webinar must refund EVERY attendee. Those attendees paid
 * through two very different rails, and each needs its own reversal:
 *
 *   - GATEWAY / MOCK seats (paymentIntent pi_/cs_/order_/pay_/…_mock_) — real
 *     card money. They must credit the card, so they go through `refundPayment`
 *     (which owns the gateway phases + its own overage credit-back). Routing
 *     them through the engine would strand the customer's money — the engine
 *     never calls the gateway.
 *   - INTERNAL org-funded seats (paymentIntent org_wallet/org_license/
 *     org_invoice) — no card ever charged; the money lives in the wallet /
 *     invoice accrual / license ledger. `refundPayment` can't refund these
 *     (createRefund throws UNKNOWN_GATEWAY on a synthetic id), so they reverse
 *     purely in-ledger via one CLASS_MULTI transaction.
 *
 * Idempotency: callers still gate on the appointment-cancel CAS / moderation
 * `moved === 0` guard, but a second call is now structurally harmless too —
 * every rail re-derives the refundable balance under Serializable isolation,
 * so an already-refunded seat surfaces as a skip, not a second payout
 * (#1169 PR 3; the old "a second call would double-refund" note predated the
 * balance clamps).
 */

export type WholeEventRefundSummary = {
  refundsIssued: number;
  refundedPaise: number;
  childRefundIds: string[];
  failures: { paymentId: string; error: string }[];
  /** Seats whose balance was already fully refunded — a re-run, not an error. */
  skippedAlreadyRefunded: number;
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function refundWholeEventPayments(
  kind: "class" | "webinar",
  eventId: string,
  reason: string,
  initiatedByUserId: string | null,
): Promise<WholeEventRefundSummary> {
  const summary: WholeEventRefundSummary = {
    refundsIssued: 0,
    refundedPaise: 0,
    childRefundIds: [],
    failures: [],
    skippedAlreadyRefunded: 0,
  };

  const payments = await prisma.payment.findMany({
    where: {
      appointment:
        kind === "webinar" ? { webinarId: eventId } : { classId: eventId },
      paymentStatus: "SUCCEEDED",
      // #1161 — no amount filter: free_ (credit-funded) seats refund too, via
      // credit restoration.
      // #781 §B — retired rows stay out: the front door refuses them, so a
      // soft-deleted seat would only surface as a false failure.
      deletedAt: null,
    },
    select: { id: true, amount: true, paymentIntent: true },
  });
  if (payments.length === 0) return summary;

  const internal = payments.filter((p) =>
    isInternalFundedIntent(p.paymentIntent),
  );
  const credits = payments.filter((p) => isFreeCreditIntent(p.paymentIntent));
  const gateway = payments.filter(
    (p) =>
      !isInternalFundedIntent(p.paymentIntent) &&
      !isFreeCreditIntent(p.paymentIntent),
  );

  // Credit-funded seats — restoration through the front door (#1161).
  for (const p of credits) {
    try {
      const r = await refundBookingPayment({
        paymentId: p.id,
        reason,
        initiatedByUserId,
      });
      summary.refundsIssued += 1;
      summary.childRefundIds.push(r.refundId);
    } catch (err) {
      if (
        err instanceof RefundValidationError &&
        err.code === "ALREADY_FULLY_REFUNDED"
      ) {
        summary.skippedAlreadyRefunded += 1;
        continue;
      }
      summary.failures.push({ paymentId: p.id, error: errMsg(err) });
      reportSentryError(err, {
        subsystem: "payments",
        tags: { feature: "whole-event-refund" },
        extra: { paymentId: p.id, eventId, kind },
      });
    }
  }

  // Gateway / mock seats — one gateway-aware refund each (refundPayment also
  // handles any CHARGE_MEMBER overage credit-back internally).
  for (const p of gateway) {
    try {
      const r = await refundPayment({
        paymentId: p.id,
        reason,
        initiatedByUserId,
      });
      summary.refundsIssued += 1;
      summary.refundedPaise += r.amountRefundedPaise;
      summary.childRefundIds.push(r.refundId);
    } catch (err) {
      if (
        err instanceof RefundValidationError &&
        err.code === "ALREADY_FULLY_REFUNDED"
      ) {
        // A re-run over an already-settled seat (e.g. maintenance freeze
        // followed by a manual cancel) — the clamp held; not a failure.
        summary.skippedAlreadyRefunded += 1;
        continue;
      }
      summary.failures.push({ paymentId: p.id, error: errMsg(err) });
      reportSentryError(err, {
        subsystem: "payments",
        tags: { feature: "whole-event-refund" },
        extra: { paymentId: p.id, eventId, kind },
      });
    }
  }

  // Internal org-funded seats — one CLASS_MULTI reversal (ledger-only). Full
  // reversal: amountPaise == Σ child amounts, so each child reverses in full.
  const memberOverageFollowUps: string[] = [];
  if (internal.length > 0) {
    const internalTotal = internal.reduce((s, p) => s + p.amount, 0);
    try {
      const result = await withSerializableRetry(() =>
        prisma.$transaction(
          (tx) =>
            applyReversal(tx, {
              source: {
                kind: "CLASS_MULTI",
                paymentIds: internal.map((p) => p.id),
              },
              amountPaise: internalTotal,
              reason,
              // Correlation tag only — reverseClassMulti mints its own child
              // Refund rows and keys idempotency off those, not this string.
              refundId: `event:${kind}:${eventId}`,
              initiatedByUserId,
            }),
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 10_000,
            timeout: 15_000,
          },
        ),
      );
      summary.refundsIssued += result.childRefundIds.length;
      summary.refundedPaise += internalTotal;
      summary.childRefundIds.push(...result.childRefundIds);
      for (const c of result.cascades) {
        if (c.memberOverageRefundDue) {
          memberOverageFollowUps.push(
            c.memberOverageRefundDue.overagePaymentId,
          );
        }
      }
    } catch (err) {
      // The whole internal batch rolled back atomically — surface each seat.
      for (const p of internal) {
        summary.failures.push({ paymentId: p.id, error: errMsg(err) });
      }
      reportSentryError(err, {
        subsystem: "payments",
        tags: { feature: "whole-event-refund" },
        extra: { eventId, kind, internalCount: internal.length },
      });
    }
  }

  // #715/#716 — CHARGE_MEMBER overages on the internal seats were collected on
  // separate gateway side-payments the CLASS_MULTI tx can't touch. Credit them
  // back now (best-effort; ops-paged on non-benign failure).
  for (const overagePaymentId of memberOverageFollowUps) {
    try {
      const r = await refundPayment({
        paymentId: overagePaymentId,
        reason: `overage credit-back — ${kind} ${eventId} cancelled`,
        initiatedByUserId,
      });
      summary.childRefundIds.push(r.refundId);
    } catch (err) {
      const benign =
        err instanceof RefundValidationError &&
        (err.code === "ALREADY_FULLY_REFUNDED" ||
          err.code === "PAYMENT_NOT_SUCCEEDED");
      if (!benign) {
        summary.failures.push({
          paymentId: overagePaymentId,
          error: errMsg(err),
        });
        void recordSystemError({
          organizationId: null,
          category: "PAYMENT",
          summary: `Overage credit-back failed for side-payment ${overagePaymentId}`,
          err,
          context: { overagePaymentId, eventId, kind },
        }).catch(() => {});
      }
    }
  }

  return summary;
}

/**
 * Refund ONE attendee's seat when the organiser removes them from a live
 * class/webinar (#1003).
 *
 * The participant-removal endpoints moved the roster and left the money alone:
 * a consultant could pull a paying attendee out of an event and keep the fee,
 * with no refund, no earnings reversal and no notice to the attendee. The
 * moderation bulk-cancel has always refunded a removed attendee in full; the
 * interactive endpoints were the outlier.
 *
 * ## Who initiated the removal matters for the % (#1005)
 *
 * Historically only organisers hit this helper, so it always passed
 * `isConsultantInitiated: true` into `computeRefundPct` (full
 * `consultantInitiatedPct`, clock ignored). Self-leave reused that path and
 * paid out organiser-fault money even after the session had started — the
 * dialog copy promised "under the event's cancellation policy", which is the
 * attendee notice tiers.
 *
 * Default remains `"organiser"` so existing roster/moderation callers keep the
 * full-refund behaviour without an explicit flag. Self-leave must pass
 * `"attendee"` and we resolve `hoursUntilStart` from the next future live slot
 * (`startsAt >= now`) so a mid-program class leave uses the upcoming session,
 * not a past COMPLETED/UNVERIFIED row that would force 0%.
 *
 * Never throws: the roster change has already committed.
 */
export async function refundRemovedAttendeeSeat(args: {
  kind: "class" | "webinar";
  eventId: string;
  attendeeUserId: string;
  initiatedByUserId: string | null;
  /**
   * Defaults to organiser (full tier). Pass `"attendee"` for consultee
   * self-leave so notice-window tiers apply.
   */
  initiatedBy?: "organiser" | "attendee";
}): Promise<{
  amountRefundedPaise: number;
  refundPct: number;
  /**
   * Which rail returned the seat fee, or null when nothing moved. The
   * organiser's toast has to say where the money went, and only the gateway
   * rail reaches the attendee — an org-funded seat returns to the sponsor's
   * wallet, accrual or licence, which the attendee never held.
   */
  rail: FundingRail | null;
} | null> {
  const eventFilter =
    args.kind === "webinar"
      ? { webinarId: args.eventId }
      : { classId: args.eventId };
  // Missing flag = legacy organiser path; do not flip the money default.
  const isOrganiserInitiated =
    (args.initiatedBy ?? "organiser") === "organiser";

  // Hoisted so the catch can scope its ops event to the funding organisation;
  // a failure reported against `null` never reaches the org that is owed it.
  let organizationId: string | null = null;

  try {
    const payment = await prisma.payment.findFirst({
      // Deterministic: the seat they bought first is the one being released.
      orderBy: { createdAt: "asc" },
      where: {
        userId: args.attendeeUserId,
        appointment: eventFilter,
        paymentStatus: "SUCCEEDED",
        // #1161 residual — attendee-leave refunds are TIERED by notice, and
        // partial restoration of a credit-funded (free_) seat is a product
        // call not yet made; whole-event cancellation restores such seats in
        // full via the credits bucket above.
        amount: { gt: 0 },
        deletedAt: null,
      },
      select: {
        id: true,
        amount: true,
        currency: true,
        organizationId: true,
        ...REFUNDABLE_BALANCE_SELECT,
        appointment: { select: { cancellationPolicy: POLICY_TERMS_INCLUDE } },
      },
    });
    if (!payment) return null;
    organizationId = payment.organizationId;

    // Organiser branch ignores the clock inside computeRefundPct; skip the
    // slot lookup. Attendee branch needs a real hoursUntilStart — negative
    // means already started → 0% under the tiers (and the DELETE route should
    // have 400'd before we got here for self-leave).
    let hoursUntilStart = -1;
    if (!isOrganiserInitiated) {
      const now = new Date();
      // Next upcoming session — not the earliest historical live row.
      // Past class sessions stay SCHEDULED/COMPLETED/UNVERIFIED and would
      // otherwise pin hoursUntilStart negative → permanent 0% refund.
      const nextLive = await findLiveEventSlot(eventFilter, {
        order: "asc",
        startsAtGte: now,
      });
      if (nextLive) {
        hoursUntilStart =
          (nextLive.startsAt.getTime() - now.getTime()) / (1000 * 60 * 60);
      }
    }

    const refundPct = computeRefundPct(
      termsFromPolicyRow(payment.appointment?.cancellationPolicy),
      hoursUntilStart,
      isOrganiserInitiated,
    );
    // #1396 — `refundPct` may carry two decimals (a policy can say 12.5%), so
    // multiplying paise by the float first put a binary rounding error inside a
    // money amount before the floor ever ran. Scale to integer basis points and
    // divide once, exactly as `computeBookingRefundQuote` in cancellation-policy
    // does; BigInt because the intermediate product leaves the safe-integer
    // range long before the amounts stop being real money.
    const grossPaise = Number(payment.amount);
    const policyRefundPaise = Number(
      (BigInt(grossPaise) * BigInt(Math.round(refundPct * 100))) /
        BigInt(10_000),
    );
    // Clamp to the remaining balance, exactly as the cancel route does. A seat
    // carrying an earlier partial refund would otherwise ask for more than is
    // left, `refundPayment` would reject the whole request, and the attendee
    // would receive nothing of the remainder they are owed.
    const amountPaise = Math.min(
      policyRefundPaise,
      refundableBalancePaise(grossPaise, payment),
    );
    if (amountPaise <= 0)
      return { amountRefundedPaise: 0, refundPct, rail: null };

    const actorLabel = isOrganiserInitiated ? "organiser" : "attendee";
    const result = await refundBookingPayment({
      paymentId: payment.id,
      amountPaise,
      reason: `removed from ${args.kind} ${args.eventId} by the ${actorLabel} (${refundPct}%)`,
      initiatedByUserId: args.initiatedByUserId,
    });

    // Only the gateway rail puts money back where this person can see it. On
    // the internal rail the value returned to the org's wallet, accrual or
    // licence — the member never paid, so telling them a refund is coming is
    // simply false.
    if (result.rail === "GATEWAY") {
      void notifyRefundProcessed(args.attendeeUserId, {
        ...notificationScope(payment.organizationId),
        amount: amountPaise,
        currency: payment.currency,
        reason: isOrganiserInitiated
          ? `You were removed from this ${args.kind}.`
          : `You left this ${args.kind}.`,
        dashboardUrl: `${getAppUrl()}/dashboard`,
      }).catch(() => {});
    }

    return {
      amountRefundedPaise: result.amountRefundedPaise,
      refundPct,
      rail: result.rail,
    };
  } catch (err) {
    // Benign idempotent re-drives — a seat already refunded, or a payment that
    // never captured. Paging ops for these turns every repeat click into an
    // incident. Mirrors the overage credit-back exemption above.
    // AMOUNT_EXCEEDS_REFUNDABLE is unreachable through the clamp above, but a
    // concurrent refund settling between the read and the write can still
    // produce it, and that race is the benign case too.
    const benign =
      err instanceof RefundValidationError &&
      (err.code === "ALREADY_FULLY_REFUNDED" ||
        err.code === "PAYMENT_NOT_SUCCEEDED" ||
        err.code === "AMOUNT_EXCEEDS_REFUNDABLE");
    if (benign) return { amountRefundedPaise: 0, refundPct: 0, rail: null };

    reportSentryError(err, {
      subsystem: "payments",
      tags: { feature: "attendee-removal-refund" },
      extra: { ...args },
    });
    void recordSystemError({
      organizationId,
      category: "PAYMENT",
      summary: `Seat refund failed for attendee removed from ${args.kind} ${args.eventId}`,
      err,
      context: { ...args },
    }).catch(() => {});
    return { amountRefundedPaise: 0, refundPct: 0, rail: null };
  }
}
