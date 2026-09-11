import { RefundStatus } from "@prisma/client";

/**
 * Refund-aware entitlement, shared across access-control paths (#689).
 *
 * `PaymentStatus` has no REFUNDED value — a refunded payment stays SUCCEEDED and
 * the money movement lives only in `Refund` rows. So a `paymentStatus: SUCCEEDED`
 * filter alone still matches a fully-refunded buyer; every access check that
 * grants entitlement off a SUCCEEDED payment must net the refunds too.
 */

type RefundLike = { amountPaise: number; status: RefundStatus };

/**
 * Paise already reversed on a payment. A refund counts once it's SUCCEEDED or
 * in-flight (PENDING); FAILED/CANCELLED never moved money. Mirrors the
 * refundable computation in `lib/payments/operations/refund.ts`.
 */
export function refundedPaise(refunds: RefundLike[]): number {
  return refunds
    .filter(
      (r) =>
        r.status === RefundStatus.SUCCEEDED || r.status === RefundStatus.PENDING,
    )
    .reduce((acc, r) => acc + r.amountPaise, 0);
}

/**
 * True while a SUCCEEDED payment is still a live entitlement. A full refund
 * (refunds cover the whole amount) made the buyer whole, so access is revoked;
 * a partial refund keeps access (net-positive purchase). Chargeback-driven
 * revocation (disputes LOST/CHARGE_REFUNDED) is deferred.
 */
export function isPaymentEntitled(payment: {
  amount: number;
  refunds: RefundLike[];
}): boolean {
  return refundedPaise(payment.refunds) < payment.amount;
}
