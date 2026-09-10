import { reportSentryError } from "@/lib/observability/report";
import Stripe from "stripe";
import {
  PaymentIntentParams,
  PaymentIntent,
  RefundParams,
  RefundResult,
  DisputeParams,
  DisputeResult,
  PaymentError,
  RefundError,
  DisputeError,
} from "./types";
import { RefundStatus, DisputeStatus } from "@prisma/client";
import { getAppUrl } from "@/lib/url";
import { assertInrSettlement } from "@/lib/payments/validation/currency-guards";

/**
 * Convert Stripe's complex Evidence object to a plain record.
 * Avoids repeating `as unknown as Record<string, unknown>` at every call site.
 */
function toEvidenceRecord(
  evidence: Stripe.Dispute.Evidence,
): Record<string, unknown> {
  return evidence as unknown as Record<string, unknown>;
}

// ============================================================================
// Stripe Client Initialization
// ============================================================================

const initializeStripeClient = () => {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) {
    console.warn("STRIPE_SECRET_KEY not found in environment variables");
    return null;
  }

  // #1351, mirroring the PM-10 guard in core/razorpay.ts. Nothing downstream
  // distinguishes test mode from live mode, so a TEST key in a production
  // posture boots cleanly and fails only at the first customer: charges
  // decline, refunds dead-end, webhooks never verify, while every Payment row
  // still reads as gateway-authoritative. Razorpay fails at module load
  // because its guard predates the lazy client; Stripe's lives here instead,
  // because #1376 made gateway cores load at call time and a module-scope
  // throw would fire on any import of this file.
  //
  // EXCEPT during `next build`: builds run with NODE_ENV=production and CI /
  // Netlify build environments legitimately hold test keys — a build moves no
  // money. Before launch the production site also legitimately runs on test
  // keys, so STRIPE_ALLOW_TEST_KEYS_IN_PRODUCTION=true downgrades the throw to
  // a loud error log; the variable must go away with the first LIVE keys.
  //
  // Both test-mode prefixes count: `rk_test_` is a RESTRICTED test key, which
  // Stripe recommends for exactly this server-side use, so it is the prefix a
  // security-conscious operator is most likely to paste in. Matching only
  // `sk_test_` would let the more careful mistake through the guard.
  const isTestModeKey =
    apiKey.startsWith("sk_test_") || apiKey.startsWith("rk_test_");
  if (
    process.env.NODE_ENV === "production" &&
    process.env.NEXT_PHASE !== "phase-production-build" &&
    isTestModeKey
  ) {
    if (process.env.STRIPE_ALLOW_TEST_KEYS_IN_PRODUCTION === "true") {
      console.error(
        "[stripe] STRIPE_ALLOW_TEST_KEYS_IN_PRODUCTION=true: the production posture is running on a Stripe TEST secret key. " +
          "No real money can move. Delete the variable and set a LIVE key before Stripe is enabled for customers.",
      );
    } else {
      throw new PaymentError(
        "STRIPE_SECRET_KEY is set to a Stripe TEST key (sk_test_… / rk_test_…) while NODE_ENV=production. " +
          "Live checkout, refunds and webhooks cannot run against Stripe test mode. " +
          "Fix: replace STRIPE_SECRET_KEY with the account's LIVE key " +
          "(dashboard.stripe.com → Developers → API keys, live mode) and redeploy.",
        "STRIPE_TEST_KEY_IN_PRODUCTION",
        "STRIPE",
      );
    }
  }

  return new Stripe(apiKey, {
    apiVersion: "2026-02-25.clover",
    // Parity with the explicit 30 s budget withRazorpaySdkTimeout enforces:
    // webhook after() callbacks and every refund phase await these calls, so
    // an unbounded hang is a correctness problem, not just a latency one.
    timeout: 30_000,
    maxNetworkRetries: 2,
  });
};

// Lazy singleton (lib/email.ts getResendClient convention). Instantiating at
// module scope put the SDK constructor on every cold boot of any route whose
// import graph reaches this file. MEASURED 2026-08-23 (#1221): this does NOT
// shrink the #1124 concurrent-instance event-loop stall — that reproduced
// 12/12 at full strength on a build carrying exactly this change. Keep the
// lazy pattern as boot hygiene; do not cite it as stall mitigation.
// `undefined` = not yet attempted; `null` = attempted and missing credentials
// (cached, like the original module-scope init, so the warning logs once).
// `undefined` = not yet attempted; `null` = attempted and missing credentials
// (cached, like the original module-scope init, so the warning logs once).
let stripeClientInstance: Stripe | null | undefined;

export function getStripeClient(): Stripe | null {
  if (stripeClientInstance === undefined) {
    stripeClientInstance = initializeStripeClient();
  }
  return stripeClientInstance;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the base URL for payment redirects
 */
const getBaseUrl = () => {
  return getAppUrl();
};

// After paise migration, all amounts in the DB are already in smallest currency unit (paise/cents).
// No conversion needed for INR. For non-INR currencies, the amount from checkout is already
// in the target currency's smallest unit via the checkout calculation.

// ============================================================================
// Checkout/Payment Intent Operations
// ============================================================================

/**
 * Create a Stripe Checkout Session
 */
export async function createStripeCheckoutSession({
  amount,
  currency,
  metadata,
}: PaymentIntentParams): Promise<PaymentIntent> {
  // #1396 — same boundary as the Razorpay sibling, and equally the first
  // statement here. `unit_amount` below is INR paise no matter what this
  // argument says, so lower-casing an unvalidated code into
  // `price_data.currency` would price the order in a foreign subunit.
  // #1396 — use the canonical code the guard just normalised, not the raw
  // (possibly padded/lowercased) input.
  const settlementCurrency = assertInrSettlement(
    currency,
    "create a Stripe checkout session",
    "STRIPE",
  );

  const stripeClient = getStripeClient();
  if (!stripeClient) {
    throw new PaymentError(
      "Stripe client not initialized - check STRIPE_SECRET_KEY environment variable",
      "STRIPE_NOT_INITIALIZED",
      "STRIPE",
    );
  }

  // BUG-C: Validate amount is positive before creating payment intent
  if (amount <= 0) {
    throw new PaymentError(
      "Payment amount must be greater than zero",
      "INVALID_AMOUNT",
      "STRIPE",
    );
  }

  try {
    const session = await stripeClient.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: settlementCurrency.toLowerCase(),
            product_data: {
              name: `${metadata.appointmentType} Appointment`,
              description: `Appointment booking for ${metadata.appointmentType}`,
            },
            unit_amount: amount, // already in smallest currency unit (paise/cents)
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${getBaseUrl()}/checkout/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${getBaseUrl()}/checkout/checkout-failure`,
      metadata,
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60, // 30 minutes
    });

    // Stripe types `url` as nullable and returns null for sessions in a UI
    // mode that has no hosted page. `session.url!` shipped that null to the
    // browser as the redirect target, so the buyer landed on "null" with a
    // live PENDING Payment row behind them.
    if (!session.url) {
      throw new PaymentError(
        `Stripe checkout session ${session.id} was created without a hosted checkout URL`,
        "STRIPE_SESSION_URL_MISSING",
        "STRIPE",
      );
    }

    return {
      id: session.id,
      client_secret: session.url, // Checkout URL
      amount,
      currency,
      status: session.status || "open",
    };
  } catch (error) {
    // Our own precondition failures are already precise; re-wrapping them
    // through handleStripeError would flatten them to UNKNOWN_ERROR.
    if (error instanceof PaymentError) throw error;
    console.error("Stripe checkout session creation failed:", error);
    // A declined/invalid card is an ANSWER the gateway gave us, not a fault —
    // tag it separately so the dashboard doesn't read "Stripe is down" for
    // routine card declines.
    const isCardDecline =
      error instanceof Stripe.errors.StripeError &&
      error.type === "StripeCardError";
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "stripe" },
      expected: isCardDecline,
      contexts: { payment: { amount, currency } },
    });
    throw handleStripeError(error);
  }
}

/**
 * Cancel a Stripe checkout session or payment intent
 */
export async function cancelStripePayment(
  paymentIntentId: string,
  reason: string = "requested_by_customer",
): Promise<void> {
  const stripeClient = getStripeClient();
  if (!stripeClient) {
    console.warn("Stripe client not initialized - cannot cancel payment");
    return;
  }

  try {
    if (paymentIntentId.startsWith("cs_")) {
      // Checkout session - expire it
      await stripeClient.checkout.sessions.expire(paymentIntentId);
      console.log(`✅ Stripe checkout session expired: ${paymentIntentId}`);
    } else if (paymentIntentId.startsWith("pi_")) {
      // Payment intent - cancel it
      await stripeClient.paymentIntents.cancel(paymentIntentId, {
        cancellation_reason:
          reason === "requested_by_customer"
            ? "requested_by_customer"
            : "abandoned",
      });
      console.log(`✅ Stripe payment intent cancelled: ${paymentIntentId}`);
    }
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError) {
      // Already expired/cancelled is fine
      if (
        error.code === "resource_missing" ||
        error.message.includes("already")
      ) {
        console.log(
          `✅ Payment was already expired/cancelled: ${paymentIntentId}`,
        );
        reportSentryError(error, {
          subsystem: "payments",
          tags: { provider: "stripe" },
          expected: true,
        });
        return;
      }
    }
    console.error(`Failed to cancel Stripe payment ${paymentIntentId}:`, error);
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "stripe" },
    });
  }
}

// ============================================================================
// Refund Operations
// ============================================================================

/**
 * Create a refund for a Stripe payment
 */
export async function createStripeRefund({
  paymentIntentId,
  amount,
  reason,
  metadata,
  idempotencyKey,
}: RefundParams): Promise<RefundResult> {
  const stripeClient = getStripeClient();
  if (!stripeClient) {
    throw new RefundError(
      "Stripe client not initialized - cannot process refund",
      "STRIPE_NOT_INITIALIZED",
      "STRIPE",
    );
  }

  // The Razorpay rail has carried an idempotency key since #825; this one
  // dropped it on the floor, so a Phase 2 retry after a timeout refunded the
  // customer twice. The only caller passes the Phase 1 reservation id, which
  // is the logical refund's identity, so a missing key means the caller is
  // wrong — refuse rather than issue an unkeyed refund.
  if (!idempotencyKey) {
    throw new RefundError(
      "Stripe refunds require an idempotency key — refusing to issue an unkeyed refund",
      "REFUND_IDEMPOTENCY_KEY_REQUIRED",
      "STRIPE",
    );
  }

  // `amount || undefined` turned 0 and undefined into "refund everything".
  // Every caller computes an explicit paise figure; an absent or zero one is a
  // bug upstream, and silently promoting it to a full refund spends real money.
  //
  // #1351 — `<= 0` alone still admits NaN, Infinity and fractions, none of
  // which compare false against zero. Stripe takes an integer minor unit, so
  // those reach the API and come back as a generic gateway error the caller
  // books as a rail failure rather than the upstream arithmetic bug it is.
  // Same shape as the ledger's posting guard in lib/payments/ledger/post.ts.
  if (amount === undefined || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new RefundError(
      `Refund amount must be a positive whole number of paise (got ${String(amount)})`,
      "INVALID_AMOUNT",
      "STRIPE",
    );
  }

  try {
    const paymentIntent =
      await stripeClient.paymentIntents.retrieve(paymentIntentId);

    // Refunding an intent that never captured is not a no-op: Stripe answers
    // with a generic error the caller books as a gateway failure, while an
    // uncaptured intent should be CANCELLED instead. Fail with a code that
    // says which.
    if (paymentIntent.status !== "succeeded") {
      throw new RefundError(
        `Stripe payment intent ${paymentIntentId} is ${paymentIntent.status}, not succeeded — cancel it instead of refunding`,
        "STRIPE_PAYMENT_NOT_CAPTURED",
        "STRIPE",
      );
    }

    const refund = await stripeClient.refunds.create(
      {
        payment_intent: paymentIntentId,
        amount, // already in smallest currency unit (paise/cents)
        reason: mapRefundReason(reason),
        metadata,
      },
      // Request option, NOT a body param: as a param Stripe ignores it and the
      // retry mints a second refund.
      { idempotencyKey },
    );

    return {
      refundId: refund.id,
      amount: refund.amount, // already in smallest currency unit
      currency: refund.currency?.toUpperCase() || "USD",
      status: mapStripeRefundStatus(refund.status),
      metadata: refund.metadata || undefined,
    };
  } catch (error) {
    // Our own precondition failures already carry a precise code;
    // handleStripeRefundError would flatten them to UNKNOWN_ERROR.
    if (error instanceof RefundError) throw error;
    console.error("Stripe refund creation failed:", error);
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "stripe" },
    });
    throw handleStripeRefundError(error);
  }
}

/**
 * Get refund status from Stripe
 */
export async function getStripeRefund(refundId: string): Promise<RefundResult> {
  const stripeClient = getStripeClient();
  if (!stripeClient) {
    throw new RefundError(
      "Stripe client not initialized",
      "STRIPE_NOT_INITIALIZED",
      "STRIPE",
    );
  }

  try {
    const refund = await stripeClient.refunds.retrieve(refundId);

    return {
      refundId: refund.id,
      amount: refund.amount, // already in smallest currency unit
      currency: refund.currency?.toUpperCase() || "USD",
      status: mapStripeRefundStatus(refund.status),
      metadata: refund.metadata || undefined,
    };
  } catch (error) {
    console.error("Stripe refund retrieval failed:", error);
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "stripe" },
    });
    throw handleStripeRefundError(error);
  }
}

/**
 * List all refunds for a payment intent
 */
export async function listStripeRefunds(
  paymentIntentId: string,
  limit: number = 10,
): Promise<RefundResult[]> {
  const stripeClient = getStripeClient();
  if (!stripeClient) {
    throw new RefundError(
      "Stripe client not initialized",
      "STRIPE_NOT_INITIALIZED",
      "STRIPE",
    );
  }

  try {
    const refunds = await stripeClient.refunds.list({
      payment_intent: paymentIntentId,
      limit,
    });

    return refunds.data.map((refund) => ({
      refundId: refund.id,
      amount: refund.amount, // already in smallest currency unit
      currency: refund.currency?.toUpperCase() || "USD",
      status: mapStripeRefundStatus(refund.status),
      metadata: refund.metadata || undefined,
    }));
  } catch (error) {
    console.error("Stripe refunds list failed:", error);
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "stripe" },
    });
    throw handleStripeRefundError(error);
  }
}

// ============================================================================
// Dispute Operations
// ============================================================================

/**
 * Get dispute details from Stripe
 */
export async function getStripeDispute(
  disputeId: string,
): Promise<DisputeResult> {
  const stripeClient = getStripeClient();
  if (!stripeClient) {
    throw new DisputeError(
      "Stripe client not initialized",
      "STRIPE_NOT_INITIALIZED",
      "STRIPE",
    );
  }

  try {
    const dispute = await stripeClient.disputes.retrieve(disputeId);

    return {
      disputeId: dispute.id,
      status: mapStripeDisputeStatus(dispute.status),
      evidence: toEvidenceRecord(dispute.evidence),
      isChargeRefundable: dispute.is_charge_refundable,
      dueBy: dispute.evidence_details?.due_by
        ? new Date(dispute.evidence_details.due_by * 1000)
        : undefined,
    };
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError) {
      // Only log message for cleaner output, not the full error object
      console.error(
        `Stripe dispute retrieval failed: ${error.message} (code: ${error.code})`,
      );
    } else {
      console.error("Stripe dispute retrieval failed:", error);
    }
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "stripe" },
    });
    throw handleStripeDisputeError(error);
  }
}

/**
 * Submit evidence for a Stripe dispute
 */
export async function submitStripeDisputeEvidence({
  disputeId,
  evidence,
}: DisputeParams): Promise<DisputeResult> {
  const stripeClient = getStripeClient();
  if (!stripeClient) {
    throw new DisputeError(
      "Stripe client not initialized",
      "STRIPE_NOT_INITIALIZED",
      "STRIPE",
    );
  }

  try {
    const dispute = await stripeClient.disputes.update(disputeId, {
      evidence: {
        customer_name: evidence.customerName,
        customer_email_address: evidence.customerEmailAddress,
        customer_purchase_ip: evidence.customerPurchaseIp,
        cancellation_policy: evidence.cancellationPolicy,
        cancellation_policy_disclosure: evidence.cancellationPolicyDisclosure,
        cancellation_rebuttal: evidence.cancellationRebuttal,
        duplicate_charge_id: evidence.duplicateChargeId,
        duplicate_charge_explanation: evidence.duplicateChargeExplanation,
        duplicate_charge_documentation: evidence.duplicateChargeDocumentation,
        product_description: evidence.productDescription,
        receipt: evidence.receipt,
        customer_communication: evidence.customerCommunication,
        uncategorized_text: evidence.uncategorizedText,
        uncategorized_file: evidence.uncategorizedFile,
      },
    });

    // Stripe auto-submits evidence to the card network after disputes.update().
    // Do NOT call disputes.close() — that ACCEPTS/concedes the dispute!

    return {
      disputeId: dispute.id,
      status: mapStripeDisputeStatus(dispute.status),
      evidence: toEvidenceRecord(dispute.evidence),
      isChargeRefundable: dispute.is_charge_refundable,
      dueBy: dispute.evidence_details?.due_by
        ? new Date(dispute.evidence_details.due_by * 1000)
        : undefined,
    };
  } catch (error) {
    console.error("Stripe dispute evidence submission failed:", error);
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "stripe" },
    });
    throw handleStripeDisputeError(error);
  }
}

/**
 * List all disputes (for admin dashboard)
 */
export async function listStripeDisputes(
  limit: number = 10,
): Promise<DisputeResult[]> {
  const stripeClient = getStripeClient();
  if (!stripeClient) {
    throw new DisputeError(
      "Stripe client not initialized",
      "STRIPE_NOT_INITIALIZED",
      "STRIPE",
    );
  }

  try {
    const disputes = await stripeClient.disputes.list({ limit });

    return disputes.data.map((dispute) => ({
      disputeId: dispute.id,
      status: mapStripeDisputeStatus(dispute.status),
      evidence: toEvidenceRecord(dispute.evidence),
      isChargeRefundable: dispute.is_charge_refundable,
      dueBy: dispute.evidence_details?.due_by
        ? new Date(dispute.evidence_details.due_by * 1000)
        : undefined,
    }));
  } catch (error) {
    console.error("Stripe disputes list failed:", error);
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "stripe" },
    });
    throw handleStripeDisputeError(error);
  }
}

// ============================================================================
// Mapping Helpers
// ============================================================================

function mapRefundReason(
  reason?: string,
): "duplicate" | "fraudulent" | "requested_by_customer" | undefined {
  if (!reason) return "requested_by_customer";
  if (reason.includes("duplicate")) return "duplicate";
  if (reason.includes("fraud")) return "fraudulent";
  return "requested_by_customer";
}

function mapStripeRefundStatus(status: string | null): RefundStatus {
  switch (status) {
    case "succeeded":
      return "SUCCEEDED";
    case "pending":
      return "PENDING";
    case "failed":
      return "FAILED";
    case "canceled":
      return "CANCELLED";
    default:
      // Reconcile re-polls PENDING, so an unknown status self-corrects on the
      // next pass — but the value itself must be visible, or a new Stripe
      // status ships as a silent permanent PENDING.
      console.warn(
        `[stripe] Unknown refund status "${status}" — treating as PENDING`,
      );
      return "PENDING";
  }
}

function mapStripeDisputeStatus(status: string): DisputeStatus {
  switch (status) {
    case "warning_needs_response":
      return "WARNING_NEEDS_RESPONSE";
    case "warning_under_review":
      return "WARNING_UNDER_REVIEW";
    case "warning_closed":
      return "WARNING_CLOSED";
    case "needs_response":
      return "NEEDS_RESPONSE";
    case "under_review":
      return "UNDER_REVIEW";
    case "charge_refunded":
      return "CHARGE_REFUNDED";
    case "won":
      return "WON";
    case "lost":
      return "LOST";
    default:
      return "NEEDS_RESPONSE";
  }
}

// ============================================================================
// Error Handlers
// ============================================================================

function handleStripeError(error: unknown): PaymentError {
  if (error instanceof Stripe.errors.StripeError) {
    if (error.type === "StripeAuthenticationError") {
      return new PaymentError(
        "Authentication failed - Invalid Stripe API key",
        "AUTH_ERROR",
        "STRIPE",
        error,
      );
    }
    if (error.type === "StripeCardError") {
      return new PaymentError(
        error.message || "Card was declined",
        "CARD_ERROR",
        "STRIPE",
        error,
      );
    }
    if (error.type === "StripeRateLimitError") {
      return new PaymentError(
        "Too many requests - please try again later",
        "RATE_LIMIT",
        "STRIPE",
        error,
      );
    }
  }
  return new PaymentError(
    "Failed to create payment intent",
    "UNKNOWN_ERROR",
    "STRIPE",
    error,
  );
}

function handleStripeRefundError(error: unknown): RefundError {
  if (error instanceof Stripe.errors.StripeError) {
    return new RefundError(
      error.message || "Refund failed",
      error.code || "UNKNOWN_ERROR",
      "STRIPE",
      error,
    );
  }
  return new RefundError(
    "Failed to process refund",
    "UNKNOWN_ERROR",
    "STRIPE",
    error,
  );
}

function handleStripeDisputeError(error: unknown): DisputeError {
  if (error instanceof Stripe.errors.StripeError) {
    return new DisputeError(
      error.message || "Dispute operation failed",
      error.code || "UNKNOWN_ERROR",
      "STRIPE",
      error,
    );
  }
  return new DisputeError(
    "Failed to process dispute",
    "UNKNOWN_ERROR",
    "STRIPE",
    error,
  );
}
