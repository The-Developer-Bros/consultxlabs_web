/**
 * Payment-related constants used across the application
 */

/** Time in milliseconds before an approval payment link expires (48 hours) */
export const APPROVAL_PAYMENT_EXPIRATION_MS = 48 * 60 * 60 * 1000;

/** Time in hours before an approval payment link expires */
export const APPROVAL_PAYMENT_EXPIRATION_HOURS = 48;

/** Minimum booking lead time in milliseconds (15 minutes) */
export const MINIMUM_BOOKING_LEAD_TIME_MS = 15 * 60 * 1000;

/** Minimum booking lead time in minutes */
export const MINIMUM_BOOKING_LEAD_TIME_MINUTES = 15;

/**
 * Gateways that exist in the `PaymentGateway` Prisma enum but have NO
 * implementation behind them.
 *
 * The enum is a superset of what the platform can actually transact with. It
 * has to be — Prisma enums are a database type, and a value cannot be removed
 * while any row or any historical record references it. Lemon Squeezy and XFlow
 * were retired in #984 and their code deleted, but the labels survive in the
 * live type to this day and are what broke reconcile-disputes and
 * cleanup-abandoned-payments with Prisma P2023.
 *
 * DODO_PAYMENTS is the sanctioned post-MVP second gateway. There is no
 * implementation, no timeline, and no partial support: it is a schema
 * placeholder only.
 *
 * `schemas/checkout.ts` already narrows checkout to the implemented subset, so
 * a stub cannot be selected at checkout. This list plus `assertGatewayUsable`
 * cover everything downstream — refunds, payouts, reconciliation — where a stub
 * value read back off an existing row would otherwise fall through a `default`
 * branch and be treated as a working gateway.
 */
export const POST_MVP_GATEWAY_STUBS = ["DODO_PAYMENTS"] as const;

export type PostMvpGatewayStub = (typeof POST_MVP_GATEWAY_STUBS)[number];

export function isPostMvpGatewayStub(gateway: string): boolean {
  return (POST_MVP_GATEWAY_STUBS as readonly string[]).includes(gateway);
}
