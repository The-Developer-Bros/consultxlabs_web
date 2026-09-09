/**
 * Runtime guard for gateway values a money path must not use: ones that exist
 * in the schema with no implementation behind them, and ones that are
 * implemented but switched off for this deployment (#1351).
 *
 * Without this, a stub value reaching a money path falls through whatever
 * `default:` branch is nearest and gets treated as a working gateway — which
 * for a refund or a payout means silently doing nothing while the surrounding
 * code reports success. Failing loudly is the only safe behaviour: there is no
 * sensible fallback for "refund this through a gateway that does not exist".
 */
import { PaymentError } from "@/lib/payments/core/types";
import { isPostMvpGatewayStub } from "@/lib/payments/constants";

export class UnsupportedGatewayError extends PaymentError {
  constructor(gateway: string, operation: string) {
    super(
      `Payment gateway "${gateway}" has no implementation — cannot ${operation}. ` +
        `It exists in the PaymentGateway enum as a post-MVP placeholder only ` +
        `(see POST_MVP_GATEWAY_STUBS in lib/payments/constants.ts).`,
      "UNSUPPORTED_GATEWAY",
    );
    this.name = "UnsupportedGatewayError";
  }
}

/**
 * Thrown when a gateway is implemented but switched off for this deployment.
 *
 * #1351 — Stripe is a contingency rail, not a live one: Razorpay handles both
 * domestic and international collections, and Dodo Payments is the sanctioned
 * post-MVP international gateway. Stripe stays in the tree only in case RBI
 * rules change, so it must be impossible to charge a customer through it by
 * accident. Same shape as UnsupportedGatewayError so every caller that already
 * handles a PaymentError keeps working; a distinct code so an operator reading
 * the log can tell "switched off" from "never existed".
 */
export class DisabledGatewayError extends PaymentError {
  constructor(gateway: string, operation: string) {
    super(
      `Payment gateway "${gateway}" is disabled — cannot ${operation}. ` +
        `Set STRIPE_ENABLED=true (server) and NEXT_PUBLIC_STRIPE_ENABLED=true ` +
        `(checkout UI) to turn the contingency rail on.`,
      "GATEWAY_DISABLED",
    );
    this.name = "DisabledGatewayError";
  }
}

/**
 * Throw if `gateway` is a schema-only placeholder, or implemented but fenced
 * off for this deployment.
 *
 * `operation` completes the sentence "cannot ..." — e.g. "issue a refund".
 *
 * Guards the paths that START new money movement (routing a checkout, minting
 * a payment intent). It deliberately does NOT guard refunds, refund lookups or
 * dispute reads: a Payment row already written against Stripe must stay
 * refundable after the fence goes up, otherwise turning the flag off would
 * strand real customer money.
 *
 * The env read is per call, not per module load — gateway cores are loaded
 * lazily at call time (#1376) and jest flips the flag between cases.
 */
export function assertGatewayUsable(gateway: string, operation: string): void {
  if (isPostMvpGatewayStub(gateway)) {
    throw new UnsupportedGatewayError(gateway, operation);
  }
  if (gateway === "STRIPE" && process.env.STRIPE_ENABLED !== "true") {
    throw new DisabledGatewayError(gateway, operation);
  }
}
