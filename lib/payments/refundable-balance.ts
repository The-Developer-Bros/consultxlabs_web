/**
 * How much of a captured payment is still refundable (#1003).
 *
 * Every caller that tiers a refund needs this, and every caller that skips it
 * computes an amount `refundPayment` will reject outright with
 * `AMOUNT_EXCEEDS_REFUNDABLE` — which the callers then swallow as "refunded 0",
 * so a buyer owed the remainder of a partly-refunded payment gets nothing at
 * all. Three call sites derived it independently or not at all; this is the one
 * implementation, mirroring the refund operation's own balance maths.
 *
 * A FAILED or CANCELLED refund moved no money and must not reduce the balance.
 * A lost chargeback did move money, via the bank rather than an app refund, so
 * it must. A dispute still under review has pulled nothing yet.
 */

/** Refund rows that have taken money out, or are about to. */
const RETURNED_REFUND_STATUSES = new Set(["SUCCEEDED", "PENDING"]);

/** Dispute verdicts where the bank has already pulled the funds. */
const RETURNED_DISPUTE_STATUSES = new Set(["LOST", "CHARGE_REFUNDED"]);

type AmountWithStatus = { amountPaise: number; status: string };

/** The select every caller needs; keeps the query shape with the maths. */
export const REFUNDABLE_BALANCE_SELECT = {
  refunds: { select: { amountPaise: true, status: true } },
  disputes: { select: { amountPaise: true, status: true } },
} as const;

export function refundableBalancePaise(
  grossPaise: number,
  rows: { refunds: AmountWithStatus[]; disputes: AmountWithStatus[] },
): number {
  const alreadyReturned =
    rows.refunds
      .filter((r) => RETURNED_REFUND_STATUSES.has(r.status))
      .reduce((a, r) => a + r.amountPaise, 0) +
    rows.disputes
      .filter((d) => RETURNED_DISPUTE_STATUSES.has(d.status))
      .reduce((a, d) => a + d.amountPaise, 0);
  return Math.max(0, grossPaise - alreadyReturned);
}
