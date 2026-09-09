/**
 * Refund ONE booking payment, whatever rail funded it (#1003, #1020).
 *
 * `refundPayment` calls the gateway unconditionally, and an org-funded booking
 * carries a synthetic `org_wallet_` / `org_license_` / `org_invoice_`
 * paymentIntent that no gateway can resolve. So every org-funded 1:1
 * cancellation died on UNKNOWN_GATEWAY in Phase 2 — before the cascade ran —
 * and the caller swallowed it as "refunded 0". Nothing was reversed: the org
 * wallet was never credited back, the invoice accrual never netted down, the
 * program engagement never returned to the cap, the consultant's earnings
 * stayed payable and no ledger entry was written.
 *
 * `refundWholeEventPayments` already splits the two rails for class/webinar
 * seats. 1:1 bookings had no equivalent; this is that split.
 *
 *   - GATEWAY / MOCK — real card money, must credit the card, so it keeps
 *     going through `refundPayment` (which owns the two-phase gateway
 *     discipline and its own overage credit-back).
 *   - INTERNAL org-funded — no card was ever charged; the money lives in the
 *     wallet / invoice accrual / license ledger, so it reverses purely
 *     in-ledger through the reversal engine's BOOKING source.
 *
 * #1161 — this IS the universal front door now. The third rail, a booking
 * fully covered by referral credits (`free_` intent, `Payment.amount === 0`),
 * settles here: no gateway leg, and no card money to move — but not nothing.
 * The booking-time posting debited PLATFORM_PROMO for the credit funding and
 * credited the consultant/org payables, GST and the platform fee, and
 * ConsultantEarnings accrued on the gross, so cancellation mirrors that
 * journal in-ledger (payables debited, earnings netted, PLATFORM_PROMO back
 * to credit), reverses BookingUtilization (a defensive no-op for personal
 * bookings — credits are refused on org-funded checkouts), and restores the
 * credits in full. Callers must stop filtering on `amount > 0` and send every
 * SUCCEEDED payment through.
 */

import {
  EarningStatus,
  Prisma,
  PaymentStatus,
  RefundStatus,
} from "@prisma/client";
import { setParticipantStatus } from "@/lib/booking/participants";

async function markParticipantsRefunded(paymentId: string): Promise<void> {
  try {
    await setParticipantStatus(prisma, { paymentId }, "REFUNDED");
  } catch (error) {
    // Shadow table: never let it fail a refund that already went through.
    console.warn(
      JSON.stringify({
        event: "participant_refund_stamp_failed",
        paymentId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { reverseCreditsForPayment } from "@/lib/referrals/service";
import { reverseBookingUtilization } from "@/lib/api/organizations/program-helpers";
import { assertEarningStatusTransitionLegal } from "@/lib/payments/payouts/earning-status";
import { recordTdsReversal } from "@/lib/payments/tax/tds-service";
import { postLedgerTxn, type Posting } from "@/lib/payments/ledger/post";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { applyReversal } from "./reversal-engine";
import { RefundValidationError, refundPayment } from "./refund";

/** Which rail a booking's money travels on, in or out. */
export type FundingRail = "GATEWAY" | "INTERNAL" | "CREDITS";

export type BookingRefundResult = {
  refundId: string;
  amountRefundedPaise: number;
  /** Which rail actually returned the money (CREDITS = referral restoration). */
  rail: FundingRail;
};

/** Org-funded bookings carry a synthetic paymentIntent no gateway can refund. */
export function isInternalFundedIntent(paymentIntent: string): boolean {
  return paymentIntent.startsWith("org_");
}

/** Fully credit-funded bookings — zero gateway money, credits to restore. */
export function isFreeCreditIntent(paymentIntent: string): boolean {
  return paymentIntent.startsWith("free_");
}

/**
 * The rail a payment WILL refund on, decided before anything moves.
 *
 * `refundBookingPayment` answers the same question after the fact, from the
 * same two prefixes. The cancellation quote has to answer it beforehand — the
 * dialog was promising every learner that "refunds reach your original payment
 * method in 5–7 working days", which is a sentence about a card nobody
 * charged on the org rails. Both readings come from here so the quote and the
 * charge cannot describe different rails.
 */
export function fundingRailForIntent(
  paymentIntent: string | null | undefined,
): FundingRail {
  if (!paymentIntent) return "GATEWAY";
  if (isFreeCreditIntent(paymentIntent)) return "CREDITS";
  if (isInternalFundedIntent(paymentIntent)) return "INTERNAL";
  return "GATEWAY";
}

export async function refundBookingPayment(input: {
  paymentId: string;
  /** Defaults to the full remaining refundable balance. */
  amountPaise?: number;
  reason: string;
  initiatedByUserId?: string | null;
}): Promise<BookingRefundResult> {
  // #781 §B — soft-deleted financial rows are retired; never refund them.
  const payment = await prisma.payment.findUnique({
    where: { id: input.paymentId, deletedAt: null },
    select: { paymentIntent: true },
  });
  if (!payment) {
    throw new RefundValidationError(
      `Payment ${input.paymentId} not found`,
      "PAYMENT_NOT_FOUND",
    );
  }

  if (isFreeCreditIntent(payment.paymentIntent)) {
    // The credits rail restores in full or not at all — honouring a partial
    // amount would silently over-restore, then block the remainder forever
    // behind its own ALREADY_FULLY_REFUNDED claim (#1161).
    if (input.amountPaise !== undefined) {
      throw new RefundValidationError(
        `Payment ${input.paymentId} is credit-funded; the credits rail accepts no amount`,
        "INVALID_AMOUNT",
      );
    }
    return refundFreeCreditPayment(input);
  }

  if (!isInternalFundedIntent(payment.paymentIntent)) {
    const r = await refundPayment(input);
    // #1319 A9 — the seat this payment funded is refunded (best-effort, after
    // the gateway refund committed; the participant table is shadow-only).
    await markParticipantsRefunded(input.paymentId);
    return {
      refundId: r.refundId,
      amountRefundedPaise: r.amountRefundedPaise,
      rail: "GATEWAY",
    };
  }

  return refundInternalFundedPayment(input);
}

/**
 * #1161 — restore the referral credits behind a fully-credit-funded booking.
 *
 * There is no card money to move: `Payment.amount` is 0 and the value lives in
 * the consumed `ReferralCreditUsage` rows. But the booking was not free — the
 * booking-time posting debited PLATFORM_PROMO and credited the payables, and
 * ConsultantEarnings accrued on the gross. So alongside the credit restoration
 * this runs the same in-ledger reversal the org rail gets, minus the gateway
 * phases. A zero-amount Refund row is minted so the cancellation leaves the
 * same audit shape as every other rail, and its existence doubles as the
 * idempotency claim — a second cancellation of the same booking restores
 * nothing twice.
 */
async function refundFreeCreditPayment(input: {
  paymentId: string;
  reason: string;
  initiatedByUserId?: string | null;
}): Promise<BookingRefundResult> {
  const payment = await prisma.payment.findUnique({
    where: { id: input.paymentId, deletedAt: null },
    select: {
      id: true,
      currency: true,
      paymentStatus: true,
      paymentGateway: true,
    },
  });
  if (!payment) {
    throw new RefundValidationError(
      `Payment ${input.paymentId} not found`,
      "PAYMENT_NOT_FOUND",
    );
  }
  if (payment.paymentStatus !== PaymentStatus.SUCCEEDED) {
    throw new RefundValidationError(
      `Payment ${input.paymentId} is not SUCCEEDED (status=${payment.paymentStatus}); cannot refund`,
      "PAYMENT_NOT_SUCCEEDED",
    );
  }

  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const existing = await tx.refund.findFirst({
          where: {
            paymentId: payment.id,
            status: { in: [RefundStatus.SUCCEEDED, RefundStatus.PENDING] },
          },
          select: { id: true },
        });
        if (existing) {
          throw new RefundValidationError(
            `Payment ${payment.id} already has its credit restoration`,
            "ALREADY_FULLY_REFUNDED",
          );
        }

        const refundRow = await tx.refund.create({
          data: {
            paymentId: payment.id,
            amountPaise: 0,
            currency: payment.currency,
            reason: input.reason,
            status: RefundStatus.SUCCEEDED,
            refundId: `credits_${globalThis.crypto.randomUUID()}`,
            paymentGateway: payment.paymentGateway,
            metadata: {
              initiatedByUserId: input.initiatedByUserId ?? null,
              source: "free-credit",
            } as Prisma.InputJsonValue,
          },
        });

        // No amounts → full restoration of every usage row on the payment.
        await reverseCreditsForPayment(payment.id, tx);

        // #1003 convention (mirrors cancelPendingCheckout): utilization is
        // debited at checkout before capture, so release it here. A no-op for
        // personal bookings, which have no utilization row — referral credits
        // are refused on org-funded checkouts, so a free_ payment can only be
        // personal.
        await reverseBookingUtilization(tx, {
          paymentId: payment.id,
          reason: input.reason,
        });

        // Mirror the booking-time PLATFORM_PROMO journal: net the payables'
        // source rows and counter-post the funding. Same tx as the Refund row,
        // so a failed posting rolls the whole restoration back atomically.
        await reverseFreeCreditSettlement(tx, {
          paymentId: payment.id,
          refundId: refundRow.id,
          initiatedByUserId: input.initiatedByUserId ?? null,
        });

        await setParticipantStatus(tx, { paymentId: payment.id }, "REFUNDED");
        return {
          refundId: refundRow.id,
          amountRefundedPaise: 0,
          rail: "CREDITS" as const,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 15_000,
      },
    ),
  );
}

/**
 * In-ledger settlement of a fully-credit-funded cancellation (#1161).
 *
 * `applyRefundCascade` cannot serve this payment: its proportional machinery
 * divides by `Payment.amount`, which is 0 here (its zero-amount branch exists
 * precisely to short-circuit that, and only releases utilization). So this is
 * the ratio-1 special case, shaped like the cascade's Step 9 and mirroring —
 * leg for leg — how the credit funding was originally booked
 * (earnings-service.ts): the journal debited PLATFORM_PROMO for the
 * REFERRAL_CREDIT legs (or DISCOUNT on legacy rows without legs) and credited
 * CONSULTANT_PAYABLE per party, ORG_PAYABLE per org, GST_PAYABLE and the
 * platform fee. The reversal credits PLATFORM_PROMO back and debits those
 * payables, with PLATFORM_FEE absorbing the residual so the txn balances to
 * the paise.
 *
 * The payables' source rows net first (earnings → REFUNDED, org clawback when
 * already paid out) so payout math and ledger stay coherent — EARNINGS_LEDGER_
 * DRIFT reconciles exactly this pairing. A free_ booking carries no overage
 * side-charges and no invoice, so there is no Step-7.6 credit-back or GST
 * credit note to mirror.
 *
 * No-op when no earnings rows exist: without them neither did the consultant
 * pipeline nor the booking journal run, so there is nothing to invert —
 * posting anyway would credit PLATFORM_PROMO against a debit that never
 * happened.
 */
async function reverseFreeCreditSettlement(
  tx: Tx,
  input: {
    paymentId: string;
    refundId: string;
    initiatedByUserId: string | null;
  },
): Promise<void> {
  const payment = await tx.payment.findUniqueOrThrow({
    where: { id: input.paymentId },
    select: {
      originalAmount: true,
      taxAmount: true,
      legs: { select: { source: true, amountPaise: true } },
      earnings: {
        select: {
          id: true,
          consultantProfileId: true,
          consultantSharePaise: true,
          refundedShareAmount: true,
          status: true,
          payoutId: true,
        },
      },
      organizationEarnings: {
        select: {
          id: true,
          organizationId: true,
          orgSharePaise: true,
          refundedAmountPaise: true,
          status: true,
          orgPayoutId: true,
          orgPayout: { select: { status: true, clawbackInitiatedAt: true } },
        },
      },
    },
  });

  if (
    payment.earnings.length === 0 &&
    payment.organizationEarnings.length === 0
  )
    return;

  // Consultant earnings net in full — same cap + legal-transition guard as
  // cascade Step 6, with the identity proportion (a cancellation is total).
  for (const earnings of payment.earnings) {
    const newRefundedShare = Math.min(
      earnings.consultantSharePaise,
      earnings.refundedShareAmount + earnings.consultantSharePaise,
    );
    const fully = newRefundedShare >= earnings.consultantSharePaise;
    let nextStatus = earnings.status;
    if (fully && earnings.status !== EarningStatus.REFUNDED) {
      assertEarningStatusTransitionLegal(
        earnings.id,
        earnings.status,
        EarningStatus.REFUNDED,
      );
      nextStatus = EarningStatus.REFUNDED;
    }
    await tx.consultantEarnings.update({
      where: { id: earnings.id },
      data: { refundedShareAmount: newRefundedShare, status: nextStatus },
    });
    if (earnings.payoutId) {
      // Full reversal of this share → full TDS reversal for it; the helper's
      // own dedup + original-cap keeps a re-run bounded.
      await recordTdsReversal(tx, {
        payoutId: earnings.payoutId,
        consultantProfileId: earnings.consultantProfileId,
        earningsId: earnings.id,
        refundAmountPaise: earnings.consultantSharePaise,
        paymentAmountPaise: earnings.consultantSharePaise,
        refundId: input.refundId,
      });
    }
  }

  // Org earnings (the consultant's host org / collaborator orgs — not a
  // sponsor; referral credits never fund org-sponsored checkouts). Mirrors
  // cascade Step 7 including the COMPLETED-payout clawback record.
  for (const orgEarn of payment.organizationEarnings) {
    const newRefunded = Math.min(
      orgEarn.orgSharePaise,
      orgEarn.refundedAmountPaise + orgEarn.orgSharePaise,
    );
    const fully = newRefunded >= orgEarn.orgSharePaise;
    let nextStatus = orgEarn.status;
    if (fully && orgEarn.status !== EarningStatus.REFUNDED) {
      assertEarningStatusTransitionLegal(
        orgEarn.id,
        orgEarn.status,
        EarningStatus.REFUNDED,
      );
      nextStatus = EarningStatus.REFUNDED;
    }
    await tx.organizationEarnings.update({
      where: { id: orgEarn.id },
      data: { refundedAmountPaise: newRefunded, status: nextStatus },
    });

    if (
      orgEarn.orgPayoutId &&
      orgEarn.orgPayout?.status === "COMPLETED" &&
      orgEarn.orgSharePaise > 0
    ) {
      await tx.organizationPayout.update({
        where: { id: orgEarn.orgPayoutId },
        data: {
          clawbackAmountPaise: { increment: orgEarn.orgSharePaise },
          clawbackInitiatedAt: orgEarn.orgPayout.clawbackInitiatedAt
            ? undefined
            : new Date(),
        },
      });
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgEarn.organizationId,
          actorMembershipId: null,
          category: "PAYOUT",
          action: AUDIT_ACTIONS.PAYOUT.PAYOUT_CLAWBACK,
          description: `Credit-funded cancellation clawback: ${orgEarn.orgSharePaise} paise from payout ${orgEarn.orgPayoutId}`,
          details: {
            paymentId: input.paymentId,
            refundId: input.refundId,
            orgEarningsId: orgEarn.id,
            orgPayoutId: orgEarn.orgPayoutId,
            amountPaise: orgEarn.orgSharePaise,
            initiatedByUserId: input.initiatedByUserId,
          } as Prisma.InputJsonValue,
        },
      });
    }
  }

  // The counter-posting. Funding returns to PLATFORM_PROMO (the account the
  // REFERRAL_CREDIT legs were debited to); legacy pre-legs payments booked
  // their gross as DISCOUNT instead (#1003 shape).
  const promoTotal = payment.legs.reduce(
    (s, l) =>
      l.source === "REFERRAL_CREDIT" && l.amountPaise > 0
        ? s + l.amountPaise
        : s,
    0,
  );
  const credits: Posting[] = [];
  if (promoTotal > 0) {
    credits.push({
      account: { kind: "PLATFORM_PROMO" },
      direction: "CREDIT",
      amountPaise: promoTotal,
    });
  } else {
    const discountBack = payment.originalAmount + (payment.taxAmount ?? 0);
    if (discountBack > 0) {
      credits.push({
        account: { kind: "DISCOUNT" },
        direction: "CREDIT",
        amountPaise: discountBack,
      });
    }
  }

  const fundingTotal = credits.reduce((s, c) => s + c.amountPaise, 0);
  const consRev = payment.earnings.reduce(
    (s, e) => s + e.consultantSharePaise,
    0,
  );
  const orgRev = payment.organizationEarnings.reduce(
    (s, o) => s + o.orgSharePaise,
    0,
  );
  const gstRev = payment.taxAmount ?? 0;
  // PLATFORM_FEE is the residual plug (cascade Step 9 convention): positive →
  // the platform gives back its fee slice; negative (discount gap between the
  // funding and the shares) → the fee credit absorbs the shortfall.
  const platformPlug = fundingTotal - consRev - orgRev - gstRev;

  const debits: Posting[] = [];
  for (const earnings of payment.earnings) {
    if (earnings.consultantSharePaise > 0) {
      debits.push({
        account: {
          kind: "CONSULTANT_PAYABLE",
          consultantProfileId: earnings.consultantProfileId,
        },
        direction: "DEBIT",
        amountPaise: earnings.consultantSharePaise,
      });
    }
  }
  for (const orgEarn of payment.organizationEarnings) {
    if (orgEarn.orgSharePaise > 0) {
      debits.push({
        account: {
          kind: "ORG_PAYABLE",
          organizationId: orgEarn.organizationId,
        },
        direction: "DEBIT",
        amountPaise: orgEarn.orgSharePaise,
      });
    }
  }
  if (gstRev > 0) {
    debits.push({
      account: { kind: "GST_PAYABLE" },
      direction: "DEBIT",
      amountPaise: gstRev,
    });
  }
  if (platformPlug > 0) {
    debits.push({
      account: { kind: "PLATFORM_FEE" },
      direction: "DEBIT",
      amountPaise: platformPlug,
    });
  } else if (platformPlug < 0) {
    credits.push({
      account: { kind: "PLATFORM_FEE" },
      direction: "CREDIT",
      amountPaise: -platformPlug,
    });
  }

  const debitTotal = debits.reduce((s, d) => s + d.amountPaise, 0);
  const creditTotal = credits.reduce((s, c) => s + c.amountPaise, 0);
  // #1218-triage — a fully-zero settlement (zero-share earnings rows only)
  // produces empty postings on BOTH sides: that is a legitimate nothing-to-
  // journal outcome, not an imbalance. Only a one-sided non-empty total is
  // a real logic bug worth rolling back for.
  if (debits.length === 0 && credits.length === 0) {
    console.log(
      `ℹ️ free-credit reversal for payment ${input.paymentId}: zero-value settlement — no journal posted`,
    );
    return;
  }
  if (debitTotal === 0 || debitTotal !== creditTotal) {
    // Unreachable given the plug — a mismatch is a real logic bug. Throwing
    // rolls back the whole Serializable tx (Refund row included) for a clean
    // retry rather than half-applying the reversal.
    throw new Error(
      `free-credit reversal unbalanced for payment ${input.paymentId}: Dr ${debitTotal} Cr ${creditTotal}`,
    );
  }

  await postLedgerTxn(tx, {
    idempotencyKey: `refund:${input.refundId}`,
    kind: "REFUND",
    paymentId: input.paymentId,
    postings: [...debits, ...credits],
  });
}

/**
 * In-ledger reversal of an org-funded booking payment.
 *
 * Mirrors the shape `reverseClassMulti` uses per child — mint the Refund row,
 * run the proven cascade against it, flip it SUCCEEDED — inside one
 * Serializable transaction, which is what `applyRefundCascade` requires for
 * race-safety. There is no gateway leg to wait on, so unlike `refundPayment`
 * this settles in a single phase.
 */
async function refundInternalFundedPayment(input: {
  paymentId: string;
  amountPaise?: number;
  reason: string;
  initiatedByUserId?: string | null;
}): Promise<BookingRefundResult> {
  const payment = await prisma.payment.findUnique({
    where: { id: input.paymentId, deletedAt: null },
    select: {
      id: true,
      amount: true,
      currency: true,
      paymentStatus: true,
      paymentGateway: true,
      displayCurrencyAtCheckout: true,
      exchangeRateAtCheckout: true,
    },
  });
  if (!payment) {
    throw new RefundValidationError(
      `Payment ${input.paymentId} not found`,
      "PAYMENT_NOT_FOUND",
    );
  }
  if (payment.paymentStatus !== PaymentStatus.SUCCEEDED) {
    throw new RefundValidationError(
      `Payment ${input.paymentId} is not SUCCEEDED (status=${payment.paymentStatus}); cannot refund`,
      "PAYMENT_NOT_SUCCEEDED",
    );
  }

  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        // Re-derive the balance inside the Serializable tx so two concurrent
        // reversals cannot oversubscribe. A synthetic intent can never carry a
        // gateway dispute, so — unlike refundPayment — there is no chargeback
        // term to net out here.
        const priorRefunds = await tx.refund.findMany({
          where: {
            paymentId: payment.id,
            status: { in: [RefundStatus.SUCCEEDED, RefundStatus.PENDING] },
          },
          select: { amountPaise: true },
        });
        const refundable =
          payment.amount - priorRefunds.reduce((a, r) => a + r.amountPaise, 0);
        if (refundable <= 0) {
          throw new RefundValidationError(
            `Payment ${payment.id} has no refundable balance`,
            "ALREADY_FULLY_REFUNDED",
          );
        }

        const requested = input.amountPaise ?? refundable;
        if (requested <= 0) {
          throw new RefundValidationError(
            `Refund amount must be positive; got ${requested}`,
            "INVALID_AMOUNT",
          );
        }
        if (requested > refundable) {
          throw new RefundValidationError(
            `Refund amount ${requested} exceeds refundable ${refundable} on payment ${payment.id}`,
            "AMOUNT_EXCEEDS_REFUNDABLE",
          );
        }

        const refundRow = await tx.refund.create({
          data: {
            paymentId: payment.id,
            amountPaise: requested,
            currency: payment.currency,
            reason: input.reason,
            status: RefundStatus.PENDING,
            // No gateway ever mints an id for these, so the row owns its own.
            refundId: `internal_${globalThis.crypto.randomUUID()}`,
            paymentGateway: payment.paymentGateway,
            exchangeRateAtRefund: payment.exchangeRateAtCheckout,
            displayCurrency: payment.displayCurrencyAtCheckout,
            metadata: {
              initiatedByUserId: input.initiatedByUserId ?? null,
              source: "internal-funded",
            } as Prisma.InputJsonValue,
          },
        });

        await applyReversal(tx, {
          source: { kind: "BOOKING", paymentId: payment.id },
          amountPaise: requested,
          reason: input.reason,
          refundId: refundRow.id,
          initiatedByUserId: input.initiatedByUserId ?? null,
        });

        await tx.refund.update({
          where: { id: refundRow.id },
          data: { status: RefundStatus.SUCCEEDED },
        });

        // Same ordering rule as refundPayment Phase 3b: credit restoration
        // reads the cumulative SUCCEEDED refund total, so it must run after
        // the flip above or it under-restores.
        await reverseCreditsForPayment(
          payment.id,
          tx,
          requested,
          payment.amount,
        );

        await setParticipantStatus(tx, { paymentId: payment.id }, "REFUNDED");
        return {
          refundId: refundRow.id,
          amountRefundedPaise: requested,
          rail: "INTERNAL" as const,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 15_000,
      },
    ),
  );
}
