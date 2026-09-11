import { reportSentryError, reportSentryMessage } from "@/lib/observability/report";
import type { Tx } from "@/lib/prisma";
/**
 * Unified reversal engine (#776 §C / ARCH #4).
 *
 * Pre-MVP, "undo money" was a per-path cascade: `refund.ts` reversed a single
 * booking payment, overage/payout-clawback/invoice-void each had bespoke logic,
 * and multi-booking (CLASS) refunds — which have no single `paymentId` — were
 * skipped entirely, drifting cap counts and the ledger. This module is the one
 * front door every reversal flows through:
 *
 *   applyReversal(tx, { source, amountPaise, reason, refundId })
 *
 * Each `source` kind resolves to the right domain reversal but shares the same
 * idempotent ledger counter-posting discipline (keyed off `refundId`), so a
 * retry is always a no-op and reconcile can assert coherence
 * (REFUND_BOOKING_COHERENCE).
 *
 * The deep booking cascade still lives in `refund.ts` (`applyRefundCascade`) —
 * it's proven and heavily tested; this engine DISPATCHES to it rather than
 * re-implementing it. New capability here: CLASS_MULTI (fan a single logical
 * refund across the child payments of a consolidated CLASS purchase).
 *
 * Production callers (#776 §C):
 *   - CLASS_MULTI       — `refundWholeEventPayments` (lib/payments/operations/
 *                         event-refunds.ts), for the INTERNAL (org-funded) seats
 *                         of a cancelled class/webinar. Gateway/card seats do NOT
 *                         come here — they credit the card via `refundPayment`,
 *                         which this engine never calls (reverseClassMulti marks
 *                         its child refunds SUCCEEDED with no gateway leg).
 *   - PAYOUT_CLAWBACK   — the dispute-lost branch of handleDisputeUpdated.
 *   - BOOKING / OVERAGE — single-payment reversals still flow through
 *                         `refundPayment` (it owns the gateway phases); nothing
 *                         calls applyReversal for those from a route.
 */

import { Prisma, RefundStatus } from "@prisma/client";
import { applyRefundCascade, type ApplyRefundCascadeResult } from "./refund";
import { postLedgerTxn } from "@/lib/payments/ledger/post";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { recordSystemError } from "@/lib/enterprise/system-events";

type ReversalSource =
  // A single booking payment (the common case).
  | { kind: "BOOKING"; paymentId: string }
  // An overage side-charge — itself a Payment (parentPaymentId-linked), so it
  // reverses through the booking cascade on that payment id.
  | { kind: "OVERAGE"; overagePaymentId: string }
  // Gateway-side payout clawback (e.g. a lost dispute on an org-funded booking).
  | { kind: "PAYOUT_CLAWBACK"; orgPayoutId: string; organizationId: string }
  // A consolidated CLASS purchase: many child payments, no single paymentId.
  | { kind: "CLASS_MULTI"; paymentIds: string[] };

export interface ApplyReversalInput {
  source: ReversalSource;
  /** Total paise to reverse. For CLASS_MULTI it's split across children. */
  amountPaise: number;
  reason: string;
  /** Existing Refund row id when one drives this reversal; else null. */
  refundId: string;
  initiatedByUserId?: string | null;
}

export interface ApplyReversalResult {
  kind: ReversalSource["kind"];
  /** Per-cascade results (one per payment touched). */
  cascades: ApplyRefundCascadeResult[];
  /** Child Refund row ids created by CLASS_MULTI (one per reversed child). */
  childRefundIds: string[];
  /** True if a payout clawback ledger posting was made. */
  clawbackPosted: boolean;
}

/**
 * The single reversal front door. Must be called inside a Serializable tx
 * (the booking cascade requires it for race-safety).
 */
export async function applyReversal(
  tx: Tx,
  input: ApplyReversalInput,
): Promise<ApplyReversalResult> {
  switch (input.source.kind) {
    case "BOOKING": {
      const cascade = await applyRefundCascade(tx, {
        paymentId: input.source.paymentId,
        refundId: input.refundId,
        amountPaise: input.amountPaise,
        reason: input.reason,
        initiatedByUserId: input.initiatedByUserId ?? null,
      });
      return {
        kind: "BOOKING",
        cascades: [cascade],
        childRefundIds: [],
        clawbackPosted: false,
      };
    }

    case "OVERAGE": {
      // The overage charge IS a Payment; reverse it like any booking.
      const cascade = await applyRefundCascade(tx, {
        paymentId: input.source.overagePaymentId,
        refundId: input.refundId,
        amountPaise: input.amountPaise,
        reason: input.reason,
        initiatedByUserId: input.initiatedByUserId ?? null,
      });
      return {
        kind: "OVERAGE",
        cascades: [cascade],
        childRefundIds: [],
        clawbackPosted: false,
      };
    }

    case "CLASS_MULTI": {
      const { cascades, childRefundIds } = await reverseClassMulti(
        tx,
        input,
        input.source.paymentIds,
      );
      return {
        kind: "CLASS_MULTI",
        cascades,
        childRefundIds,
        clawbackPosted: false,
      };
    }

    case "PAYOUT_CLAWBACK": {
      const posted = await reversePayoutClawback(
        tx,
        input,
        input.source.orgPayoutId,
        input.source.organizationId,
      );
      return {
        kind: "PAYOUT_CLAWBACK",
        cascades: [],
        childRefundIds: [],
        clawbackPosted: posted,
      };
    }

    default: {
      const _exhaustive: never = input.source;
      throw new Error(
        `Unhandled ReversalSource: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

/**
 * Fan a single logical refund across the child payments of a consolidated
 * CLASS purchase. The caller resolves the group → `paymentIds`; we distribute
 * `amountPaise` proportionally by each payment's own amount, create one Refund
 * row per child (so each carries its own gateway/ledger trail), and run the
 * proven cascade on each. Last child absorbs the rounding remainder so the
 * children sum exactly to `amountPaise`.
 */
async function reverseClassMulti(
  tx: Tx,
  input: ApplyReversalInput,
  paymentIds: string[],
): Promise<{
  cascades: ApplyRefundCascadeResult[];
  childRefundIds: string[];
}> {
  if (paymentIds.length === 0) return { cascades: [], childRefundIds: [] };

  const payments = await tx.payment.findMany({
    where: { id: { in: paymentIds } },
    select: {
      id: true,
      amount: true,
      currency: true,
      paymentGateway: true,
      // #781 §C — carry the FX snapshot onto each child refund (mirrors refund.ts).
      displayCurrencyAtCheckout: true,
      exchangeRateAtCheckout: true,
    },
  });
  const totalAmount = payments.reduce((s, p) => s + p.amount, 0);
  if (totalAmount <= 0) return { cascades: [], childRefundIds: [] };

  // Fail fast on an over-refund. Without this the per-child floor shares would
  // exceed their own amounts and crash deep inside a child cascade (after some
  // children already processed) — a clear upfront error is far easier to debug.
  if (input.amountPaise > totalAmount) {
    throw new Error(
      `CLASS_MULTI reversal amount ${input.amountPaise} exceeds class total ${totalAmount}`,
    );
  }

  // Proportional split by payment amount. The floor() per child loses up to
  // <1 paise each, so distribute the rounding remainder one paise at a time to
  // children that still have headroom (share < amount) — never dump it all on
  // the last child, which could be tiny/zero and overflow its own amount,
  // tripping applyRefundCascade's `requested > refundable` guard and crashing
  // the whole reversal. Total headroom (totalAmount − assigned) always covers
  // the remainder for any amountPaise <= totalAmount, so one pass suffices.
  const shares = payments.map((p) => ({
    payment: p,
    share: Math.floor((input.amountPaise * p.amount) / totalAmount),
  }));
  let remainder = input.amountPaise - shares.reduce((s, x) => s + x.share, 0);
  for (let i = 0; remainder > 0 && i < shares.length; i++) {
    const headroom = shares[i].payment.amount - shares[i].share;
    const add = Math.min(headroom, remainder);
    shares[i].share += add;
    remainder -= add;
  }

  const results: ApplyRefundCascadeResult[] = [];
  const childRefundIds: string[] = [];
  for (const { payment, share } of shares) {
    if (share <= 0) continue;
    // One Refund row per child so partial-class refunds reverse cleanly and a
    // later reconcile can tie each child's reversal to its own row.
    const childRefund = await tx.refund.create({
      data: {
        paymentId: payment.id,
        amountPaise: share,
        currency: payment.currency,
        reason: input.reason,
        status: RefundStatus.PENDING,
        refundId: `app_${globalThis.crypto.randomUUID()}`,
        paymentGateway: payment.paymentGateway,
        // #781 §C — preserve the buyer's FX snapshot on the child refund row.
        exchangeRateAtRefund: payment.exchangeRateAtCheckout,
        displayCurrency: payment.displayCurrencyAtCheckout,
        metadata: {
          initiatedByUserId: input.initiatedByUserId ?? null,
          source: "class-multi",
          parentRefundId: input.refundId,
        } as Prisma.InputJsonValue,
      },
    });
    const cascade = await applyRefundCascade(tx, {
      paymentId: payment.id,
      refundId: childRefund.id,
      amountPaise: share,
      reason: input.reason,
      initiatedByUserId: input.initiatedByUserId ?? null,
    });
    await tx.refund.update({
      where: { id: childRefund.id },
      data: { status: RefundStatus.SUCCEEDED },
    });
    results.push(cascade);
    childRefundIds.push(childRefund.id);
  }
  return { cascades: results, childRefundIds };
}

/**
 * Gateway-side payout clawback. The original payout posted
 * `Dr ORG_PAYABLE / Cr CASH`; clawback recovers cash:
 * `Dr CASH / Cr ORG_PAYABLE`. Idempotent on `clawback:<refundId>:<payoutId>`.
 * Stamps the clawback amount/timestamp on the payout and writes an audit row.
 */
async function reversePayoutClawback(
  tx: Tx,
  input: ApplyReversalInput,
  orgPayoutId: string,
  organizationId: string,
): Promise<boolean> {
  if (input.amountPaise <= 0) return false;

  const payout = await tx.organizationPayout.findUnique({
    where: { id: orgPayoutId },
    select: { id: true, clawbackInitiatedAt: true },
  });
  if (!payout) {
    reportSentryMessage("reversePayoutClawback: target OrganizationPayout not found", {
      subsystem: "payments",
      level: "warning",
      extra: { orgPayoutId, refundId: input.refundId },
    });
    return false;
  }

  await tx.organizationPayout.update({
    where: { id: orgPayoutId },
    data: {
      clawbackAmountPaise: { increment: input.amountPaise },
      clawbackInitiatedAt: payout.clawbackInitiatedAt ? undefined : new Date(),
    },
  });

  await tx.orgAuditLog.create({
    data: {
      organizationId,
      actorMembershipId: null,
      category: "PAYOUT",
      action: AUDIT_ACTIONS.PAYOUT.PAYOUT_CLAWBACK,
      description: `Payout clawback: ${input.amountPaise} paise from payout ${orgPayoutId} (${input.reason})`,
      details: {
        refundId: input.refundId,
        orgPayoutId,
        amountPaise: input.amountPaise,
        initiatedByUserId: input.initiatedByUserId ?? null,
      } as Prisma.InputJsonValue,
    },
  });

  // Best-effort ledger counter-post (mirrors refund.ts dual-write safety).
  try {
    await postLedgerTxn(tx, {
      idempotencyKey: `clawback:${input.refundId}:${orgPayoutId}`,
      kind: "ORG_PAYOUT",
      payoutId: orgPayoutId,
      postings: [
        {
          account: { kind: "CASH" },
          direction: "DEBIT",
          amountPaise: input.amountPaise,
        },
        {
          account: { kind: "ORG_PAYABLE", organizationId },
          direction: "CREDIT",
          amountPaise: input.amountPaise,
        },
      ],
    });
  } catch (err) {
    reportSentryError(err, { subsystem: "payments", level: "fatal" });
    console.error(
      `[ledger] payout clawback posting FAILED for payout ${orgPayoutId} (reconcile will flag): ${err instanceof Error ? err.message : String(err)}`,
    );
    // #776 — page immediately on dual-write drift; fire-and-forget.
    void recordSystemError({
      organizationId,
      category: "LEDGER",
      summary: `Payout clawback ledger posting failed for payout ${orgPayoutId}`,
      err,
      context: { orgPayoutId, refundId: input.refundId },
    }).catch(() => {});
  }

  return true;
}
