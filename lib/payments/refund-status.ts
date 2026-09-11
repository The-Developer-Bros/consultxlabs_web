/**
 * The single gateway-refund-status mapping.
 *
 * This existed in three places — `mapRazorpayRefundStatus` in
 * lib/payments/core/razorpay.ts, `mapRefundStatus` in
 * app/api/webhooks/utils.ts, and `mapGatewayRefundStatus` in
 * scripts/refunds/reconcile-pending-refunds.ts — and the copies had already
 * drifted: two lowercased the incoming status and one did not, so a gateway
 * returning `"Processed"` instead of `"processed"` was read as SUCCEEDED by the
 * webhook and the reconcile cron but fell through to PENDING in the core
 * client. A refund can be marked settled by one reader and left un-settled by
 * another, which is the kind of divergence that ends in a customer being
 * refunded twice or not at all.
 *
 * Defaulting to PENDING is deliberate: an unrecognised status means "we do not
 * know yet", and PENDING keeps the reconcile cron polling. Mapping an unknown
 * to SUCCEEDED would settle money on a guess, and mapping it to FAILED would
 * strand a refund the gateway may still be processing.
 */
import { RefundStatus } from "@prisma/client";

export function mapGatewayRefundStatus(
  status: string | null | undefined,
): RefundStatus {
  switch (status?.toLowerCase()) {
    case "processed":
    case "succeeded":
      return RefundStatus.SUCCEEDED;
    case "failed":
      return RefundStatus.FAILED;
    // Razorpay and Stripe disagree on the spelling; accept both.
    case "cancelled":
    case "canceled":
      return RefundStatus.CANCELLED;
    case "pending":
      return RefundStatus.PENDING;
    default:
      return RefundStatus.PENDING;
  }
}
