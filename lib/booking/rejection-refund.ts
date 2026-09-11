/**
 * Refund a paid request the consultant declined (#1004).
 *
 * `REJECTED` is legally reachable from `PENDING` and
 * `APPROVED_PENDING_PAYMENT` (lib/booking/transitions.ts), and the
 * direct-checkout flow captures the money BEFORE the request is created — it
 * lands `PENDING` with a `SUCCEEDED` payment already attached. So a consultant
 * declining a direct-checkout booking left the buyer paid-up with nothing to
 * show for it, and no way out: `REJECTED` is not in `CANCELLABLE_FROM`, so the
 * cancel route 409s and the money simply stayed captured.
 *
 * A rejection is the consultant's act and nothing has been delivered, so the
 * policy's consultant-initiated percentage applies to the whole amount — the
 * same rule trials already use when a consultant rejects
 * (`lib/trials/cancellation.ts`).
 *
 * Deliberately never throws: the rejection has already committed by the time
 * this runs and a gateway failure must not roll it back. Failures surface in
 * Sentry and as `failed` on the result.
 *
 * WHO may trigger this is a security property, not a detail: the percentage is
 * 100 and ignores every notice tier, so a buyer able to reach it has a
 * self-service full refund. See the actor guard below.
 *
 * At-most-once rests on the caller: the allowed-from guard on the REJECTED
 * transition means a second reject answers 409 before reaching here. Note that
 * the refund amount is *also* self-limiting today only because
 * `consultantInitiatedPct` is 100 — a full reversal leaves no refundable
 * balance, so a hypothetical second call would be rejected by the balance
 * re-derivation. Drop that percentage below 100 and the transition guard
 * becomes the only thing standing between a double reject and a double refund.
 */

import * as Sentry from "@sentry/nextjs";

import prisma from "@/lib/prisma";
import { getAppUrl } from "@/lib/url";
import { recordSystemError } from "@/lib/enterprise/system-events";
import { notifyRefundProcessed } from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { computeRefundPct } from "@/lib/payments/operations/cancellation-policy";
import {
  isFreeCreditIntent,
  refundBookingPayment,
} from "@/lib/payments/operations/booking-refund";
import { resolveBookingRefundContext } from "./cancellation-scope";

export type RejectionRefundOutcome = {
  refundPct: number;
  amountRefundedPaise: number;
  /** Set when the refund leg failed; the rejection still stands. */
  failed?: boolean;
};

export async function refundRejectedRequest(args: {
  kind: "consultation" | "subscription";
  requestId: string;
  initiatedByUserId: string;
  /**
   * Who declined. `CONSULTEE` must never reach here — the PATCH routes reject
   * it with a 403 — and this is the second lock on that door, not the first.
   */
  actor: "CONSULTANT" | "PLATFORM" | "CONSULTEE";
}): Promise<RejectionRefundOutcome | null> {
  // A rejection refund settles at the consultant-initiated percentage, which
  // is 100% and ignores every notice tier. Reachable by the buyer, that is a
  // self-service full refund on demand: `REJECTED` is legal from `PENDING` and
  // `APPROVED_PENDING_PAYMENT`, both PATCH routes authorize any participant,
  // and the transition guard enforces only the from-state, never the actor. So
  // the actor is checked here as well as at the route — one missed guard on a
  // future caller must not be enough to hand out the platform's money.
  if (args.actor === "CONSULTEE") {
    void recordSystemError({
      organizationId: null,
      category: "PAYMENT",
      summary:
        `A consultee-initiated REJECT reached the rejection refund for ` +
        `${args.kind} ${args.requestId}; refusing to refund at the ` +
        `consultant-initiated tier`,
      err: new Error("REJECTION_REFUND_WRONG_ACTOR"),
      context: { ...args },
    }).catch(() => {});
    return null;
  }

  try {
    const ctx = await resolveBookingRefundContext(
      args.kind === "consultation"
        ? { consultationId: args.requestId }
        : { subscriptionId: args.requestId },
    );
    if (!ctx.paidPayment) return null;

    const refundPct = computeRefundPct(
      ctx.policy,
      // Irrelevant on the consultant-initiated branch, but pass the real value
      // so a future policy that tiers consultant cancellations still works.
      ctx.hoursUntilNextSession ?? -1,
      true,
    );
    // #1161 — a fully-credit-funded payment carries amount 0, so the clamp
    // below reads 0 and used to skip the front door entirely: rejecting such a
    // booking restored no credits. The credits rail accepts no partial amount
    // anyway, so it routes around the clamp at 100% instead of through it.
    if (isFreeCreditIntent(ctx.paidPayment.paymentIntent)) {
      const result = await refundBookingPayment({
        paymentId: ctx.paidPayment.id,
        reason: `${args.kind} request rejected by consultant (${refundPct}%)`,
        initiatedByUserId: args.initiatedByUserId,
      });
      return { refundPct, amountRefundedPaise: result.amountRefundedPaise };
    }
    // Clamp to what is actually still refundable. A percentage of the gross
    // overshoots on a payment with an earlier partial refund, and the refund
    // operation rejects the whole request rather than paying the remainder.
    const amountPaise = Math.min(
      Math.floor((ctx.paidPayment.amountPaise * refundPct) / 100),
      ctx.paidPayment.refundablePaise,
    );
    if (amountPaise <= 0) return { refundPct, amountRefundedPaise: 0 };

    const result = await refundBookingPayment({
      paymentId: ctx.paidPayment.id,
      amountPaise,
      reason: `${args.kind} request rejected by consultant (${refundPct}%)`,
      initiatedByUserId: args.initiatedByUserId,
    });

    // Only the gateway rail returns money the payer can see. On the internal
    // rail the value went back to the org's wallet, accrual or licence — the
    // requester never paid, so promising them a refund would be false.
    // The CONFIRMED amount, not the requested one. Nothing forces the two to
    // agree, and quoting a figure the buyer never receives is worse than
    // quoting none.
    if (result.rail === "GATEWAY") {
      void notifyRejectedRequestPayer(
        ctx.paidPayment.id,
        result.amountRefundedPaise,
      );
    }

    return { refundPct, amountRefundedPaise: result.amountRefundedPaise };
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      {
        tags: { subsystem: "bookings" },
        extra: { kind: args.kind, requestId: args.requestId },
      },
    );
    console.error(
      `[reject] refund failed for ${args.kind} ${args.requestId}:`,
      error,
    );
    return { refundPct: 0, amountRefundedPaise: 0, failed: true };
  }
}

async function notifyRejectedRequestPayer(
  paymentId: string,
  amountPaise: number,
): Promise<void> {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { userId: true, currency: true, organizationId: true },
    });
    if (!payment) return;
    await notifyRefundProcessed(payment.userId, {
      ...notificationScope(payment.organizationId),
      amount: amountPaise,
      currency: payment.currency,
      reason: "Your booking request was declined by the consultant.",
      dashboardUrl: `${getAppUrl()}/dashboard`,
    });
  } catch (error) {
    // A missed notification must never fail a settled refund.
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
  }
}
