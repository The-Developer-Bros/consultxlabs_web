/**
 * Shared Prisma select shapes for the payment-reading surfaces.
 *
 * The admin payment routes and the consultee's own payment history ask for
 * overlapping slices of the same row, and they had drifted into copies of each
 * other. Copies matter here for a specific reason: these selects are the
 * privacy boundary. `Dispute` carries `internalNotes` and `evidence` and
 * `Refund` carries `metadata` and `failureReason`, none of which is rendered
 * and none of which should reach a browser because a route happened to
 * over-fetch. Naming the columns once means a new column is not silently
 * exposed by whichever copy someone forgot to update.
 *
 * These are plain literal objects rather than `Prisma.validator` calls so they
 * can be spread into either an `include` or a nested `select`; the call sites
 * still type-check against the generated client.
 */

/** #1365 — the statutory B2C tax invoice attached to a payment. Number and
 *  date only; the document itself is behind the signed-URL download route. */
export const CONSUMER_INVOICE_SUMMARY_SELECT = {
  id: true,
  invoiceNumber: true,
  issuedAt: true,
} as const;

/** The discount actually applied, as both payment surfaces render it. */
export const DISCOUNT_CODE_SUMMARY_SELECT = {
  code: true,
  discountType: true,
  discountValue: true,
} as const;

/** #776 — refund visibility. Without it a cancelled-with-refund booking reads
 *  "SUCCEEDED" in the payment history forever. These are the columns every
 *  surface renders; operator-only fields are deliberately absent. */
export const REFUND_SUMMARY_SELECT = {
  id: true,
  amountPaise: true,
  status: true,
  reason: true,
  createdAt: true,
} as const;

/** The operator view adds the gateway's own refund id, the currency and the
 *  rail, which the buyer's history has no use for. */
export const ADMIN_REFUND_SELECT = {
  ...REFUND_SUMMARY_SELECT,
  refundId: true,
  currency: true,
  paymentGateway: true,
} as const;

/** Operator dispute view. `internalNotes` and `evidence` stay out. */
export const ADMIN_DISPUTE_SELECT = {
  id: true,
  disputeId: true,
  amountPaise: true,
  currency: true,
  status: true,
  reason: true,
  createdAt: true,
} as const;
