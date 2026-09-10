import * as Sentry from "@sentry/nextjs";
import { reportSentryError } from "@/lib/observability/report";
import Razorpay from "razorpay";
import {
  PaymentIntentParams,
  PaymentIntent,
  RefundParams,
  RefundResult,
  PaymentError,
  RefundError,
} from "./types";
import { mapGatewayRefundStatus } from "@/lib/payments/refund-status";
import { assertInrSettlement } from "@/lib/payments/validation/currency-guards";

// ============================================================================
// Razorpay Client Initialization
// ============================================================================

// PM-10 — nothing downstream distinguishes test mode from live mode, so a
// TEST key in a production posture boots cleanly and fails only at the first
// customer: charges decline, refunds dead-end, webhooks never verify, while
// every Payment row still reads as gateway-authoritative. Fail the boot
// loudly instead. Dev / preview / test keep legitimate access to test keys —
// this fires on the production posture only.
//
// This guard runs AT MODULE LOAD — it is an env read, not SDK construction,
// so #1221's lazy-client change keeps its cost at microseconds. Do NOT move
// it inside the lazy initializer: the fail-fast contract (razorpay-test-key-
// guard.test.ts) is that a misconfigured production posture dies at require
// time, before any route boots.
//
// EXCEPT during `next build`: builds run with NODE_ENV=production (and CI /
// Netlify build environments legitimately hold test keys — a build moves no
// money), and this module loads while Next collects page data, so an
// unconditional throw broke every deploy preview + the CI build job. The
// guard still fires on the first real runtime boot in production, which is
// where the customer-facing failure it exists for would happen. Before
// launch the production site legitimately runs on test keys (signup is
// closed, checkout is exercised with test cards), so
// RAZORPAY_ALLOW_TEST_KEYS_IN_PRODUCTION=true downgrades the throw to a loud
// error log; the variable must go away with the first LIVE keys. (The
// RazorpayX payouts client carries the same guard keyed to
// ENABLE_LIVE_PAYOUTS instead of NODE_ENV — see getRazorpayPayoutsService
// in lib/payments/payouts/razorpay-payouts.ts.)
{
  const guardKeyId = process.env.RAZORPAY_KEY_ID;
  if (
    process.env.NODE_ENV === "production" &&
    process.env.NEXT_PHASE !== "phase-production-build" &&
    guardKeyId &&
    /^rzp_test_/.test(guardKeyId)
  ) {
    if (process.env.RAZORPAY_ALLOW_TEST_KEYS_IN_PRODUCTION === "true") {
      console.error(
        `[razorpay] RAZORPAY_ALLOW_TEST_KEYS_IN_PRODUCTION=true: the production posture is running on Razorpay TEST key ${guardKeyId}. ` +
          "No real money can move. Delete the variable and set LIVE keys before signup opens.",
      );
    } else {
      throw new PaymentError(
        `RAZORPAY_KEY_ID is set to a Razorpay TEST key (${guardKeyId}) while NODE_ENV=production. ` +
          "Live checkout, refunds and webhooks cannot run against Razorpay test mode. " +
          "Fix: replace RAZORPAY_KEY_ID and RAZORPAY_SECRET with the account's LIVE keys " +
          "(dashboard.razorpay.com → Settings → API Keys → Live mode) and redeploy.",
        "RAZORPAY_TEST_KEY_IN_PRODUCTION",
        "RAZORPAY",
      );
    }
  }
}

// L2 FIX: Removed module-load console.warn — per-call errors are more actionable
const initializeRazorpayClient = () => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_SECRET;
  if (!keyId || !keySecret) {
    return null;
  }

  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
};

// Lazy singleton (lib/email.ts getResendClient convention). Instantiating at
// module scope put the SDK constructor on every cold boot of any route whose
// import graph reaches this file. MEASURED 2026-08-23 (#1221): this does NOT
// shrink the #1124 concurrent-instance event-loop stall — that reproduced
// 12/12 at full strength on a build carrying exactly this change. Keep the
// lazy pattern as boot hygiene; do not cite it as stall mitigation.
let razorpayClientInstance: Razorpay | null | undefined;

export function getRazorpayClient(): Razorpay | null {
  if (razorpayClientInstance === undefined) {
    razorpayClientInstance = initializeRazorpayClient();
  }
  return razorpayClientInstance;
}

// ============================================================================
// SDK call timeout
// ============================================================================

// razorpay-node exposes no timeout option — a hung connection to
// api.razorpay.com would hang the caller forever. Webhook after() callbacks
// and the refund phases all await these calls, and the stuck-event sweeper
// re-drives any event whose callback outlives its 6-minute staleness window,
// so an unbounded hang is a correctness problem, not just a latency one.
// Bound every SDK call; the raw-HTTP refund path already uses AbortSignal.
const SDK_CALL_TIMEOUT_MS = 30_000;

export function withRazorpaySdkTimeout<T>(
  op: string,
  call: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Razorpay SDK ${op} timed out after ${SDK_CALL_TIMEOUT_MS}ms`,
          ),
        ),
      SDK_CALL_TIMEOUT_MS,
    );
    try {
      call().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    } catch (err) {
      // call() threw SYNCHRONOUSLY — .then never attached, so the timer
      // would linger for the full window. Clear and propagate.
      clearTimeout(timer);
      throw err;
    }
  });
}

// ============================================================================
// Helper Functions
// ============================================================================

// After paise migration, all amounts in the DB are already in smallest currency unit (paise/cents).
// No conversion needed — amounts pass through directly to Razorpay.

// ============================================================================
// Checkout/Order Operations
// ============================================================================

/**
 * Create a Razorpay Order
 */
export async function createRazorpayOrder({
  amount,
  currency,
  metadata,
}: PaymentIntentParams): Promise<PaymentIntent> {
  // #1396 — first statement in the function, ahead of the client lookup, so a
  // non-INR currency cannot reach the SDK even on a misconfigured instance.
  // Only the booking checkout was guarded upstream; the org wallet top-up
  // minted `{ amount: paise, currency: BillingAccount.currency }`, so a USD
  // billing account turned a ₹1,000 top-up into a $1,000 order.
  // #1396 — use the canonical code the guard just normalised, not the raw
  // (possibly padded/lowercased) input, so the SDK always sees "INR".
  const settlementCurrency = assertInrSettlement(
    currency,
    "create a Razorpay order",
    "RAZORPAY",
  );

  const razorpayClient = getRazorpayClient();
  if (!razorpayClient) {
    throw new PaymentError(
      "Razorpay client not initialized - check RAZORPAY_KEY_ID and RAZORPAY_SECRET environment variables",
      "RAZORPAY_NOT_INITIALIZED",
      "RAZORPAY",
    );
  }

  // BUG-C: Validate amount is positive before creating payment order
  if (amount <= 0) {
    throw new PaymentError(
      "Payment amount must be greater than zero",
      "INVALID_AMOUNT",
      "RAZORPAY",
    );
  }

  try {
    const order = await Sentry.startSpan(
      { op: "http.client", name: "razorpay.createOrder" },
      () =>
        withRazorpaySdkTimeout("orders.create", () =>
          razorpayClient.orders.create({
            amount: amount, // already in smallest currency unit (paise)
            currency: settlementCurrency,
            notes: metadata,
            // PM-11 — Date.now() collides for two orders in the same ms; the uuid
            // suffix keeps the receipt unique so Razorpay doesn't reject the dupe.
            receipt: `receipt_${Date.now()}_${globalThis.crypto.randomUUID().slice(0, 8)}`,
          }),
        ),
    );

    return {
      id: order.id,
      client_secret: order.id, // Razorpay uses order ID as client secret
      amount: Number(order.amount), // already in smallest currency unit
      currency: order.currency,
      status: order.status,
    };
  } catch (error) {
    console.error("Razorpay order creation failed:", error);
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "razorpay" },
      contexts: { payment: { amount, currency } },
    });
    throw handleRazorpayError(error);
  }
}

/**
 * Cancel a Razorpay order (best effort - cannot actually cancel after payment)
 */
export async function cancelRazorpayOrder(orderId: string): Promise<void> {
  const razorpayClient = getRazorpayClient();
  if (!razorpayClient) {
    console.warn("Razorpay client not initialized - cannot cancel order");
    return;
  }

  try {
    // Check if there are any payments for this order
    const payments = await withRazorpaySdkTimeout("orders.fetchPayments", () =>
      razorpayClient.orders.fetchPayments(orderId),
    );
    if (payments.count === 0) {
      console.log(
        `✅ Razorpay order had no payments, safe to ignore: ${orderId}`,
      );
      return;
    }
    console.warn(
      `⚠️ Cannot cancel Razorpay order with existing payments: ${orderId}`,
    );
  } catch (error) {
    // If we can't fetch payments, assume it's safe to ignore — best-effort
    // cancel, and a stray order with no payment costs nothing.
    console.log(
      `✅ Razorpay order fetch failed (likely safe to ignore): ${orderId}`,
    );
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "razorpay" },
      expected: true,
    });
  }
}

// ============================================================================
// Refund Operations
// ============================================================================

const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";
const REFUND_TIMEOUT_MS = 30_000;

/** Razorpay: at least 10 chars, only letters, digits, hyphens and underscores. */
const IDEMPOTENCY_KEY_MIN_LENGTH = 10;
/** That documented rule as a whole-string match, so a key is accepted or refused, never rewritten. */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{10,}$/;

type RazorpayRefundResponse = {
  id: string;
  amount: number;
  currency?: string;
  status: string | null;
  notes?: Record<string, unknown>;
};

/**
 * POST /v1/payments/:id/refund over raw HTTP instead of the SDK.
 *
 * `X-Refund-Idempotency` is the only thing between a network-error retry and a
 * second refund landing on the customer's card, and razorpay-node cannot send
 * it at all: `getValidHeaders()` whitelists exactly `X-Razorpay-Account` and
 * `Content-Type` and silently drops everything else, so the header is
 * unreachable per-request *and* per-client. Raw HTTP is the only path.
 * https://razorpay.com/docs/api/refunds/normal-refunds-idempotent/
 *
 * #1352 — the key is required, not optional. The caller must supply one that it
 * can reproduce on a retry; deriving one here from paymentId+amount would make
 * two legitimate partial refunds of equal amount collide, and the second would
 * silently return the first refund instead of moving any money.
 */
async function postRefund({
  paymentId,
  amount,
  notes,
  idempotencyKey,
}: {
  paymentId: string;
  amount?: number;
  notes: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<RazorpayRefundResponse> {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_SECRET;
  if (!keyId || !keySecret) {
    throw new RefundError(
      "Razorpay credentials missing - cannot process refund",
      "RAZORPAY_NOT_INITIALIZED",
      "RAZORPAY",
    );
  }

  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
    "Content-Type": "application/json",
  };
  // Every refund is asking for exactly-once semantics, so the header is never
  // optional, and a bad key is rejected rather than repaired. Rewriting it is
  // the more dangerous option: stripping the characters Razorpay rejects is
  // lossy, so two distinct keys can collapse onto one header value and the
  // second refund would come back as a replay of the first. Sending nothing is
  // worse still — that downgrades a refund to at-least-once delivery against a
  // customer's card with no signal it happened. So fail closed; every real
  // caller passes `Refund.id`, so this only fires on a programming error. #1352
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new RefundError(
      `Refund idempotency key "${idempotencyKey}" is not a valid Razorpay key ` +
        `(at least ${IDEMPOTENCY_KEY_MIN_LENGTH} chars of letters, digits, ` +
        `hyphens and underscores only). ` +
        `Refusing to issue a non-idempotent refund.`,
      "REFUND_IDEMPOTENCY_KEY_INVALID",
      "RAZORPAY",
    );
  }
  headers["X-Refund-Idempotency"] = idempotencyKey;

  const body = JSON.stringify({ ...(amount ? { amount } : {}), notes });
  const url = `${RAZORPAY_API_BASE}/payments/${encodeURIComponent(paymentId)}/refund`;

  // Razorpay answers a *concurrent* duplicate of the same key with 409 while the
  // original is still in flight; once it settles the same key returns the
  // original refund. One bounded retry converts that race into the right answer.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(REFUND_TIMEOUT_MS),
    });

    if (res.ok) {
      return (await res.json()) as RazorpayRefundResponse;
    }

    // #1451 — Razorpay answers 409 for TWO conditions and only one of them is
    // worth waiting on: "Another request with the same idempotency key is
    // still in progress" (the concurrent duplicate this loop exists for)
    // versus "Different request with the same idempotency key has already been
    // processed" — a key collision that will answer 409 for as long as the key
    // lives, so retrying it only buys a second wasted second and reports the
    // wrong cause. The key material itself is never rewritten (see above); the
    // collision is surfaced under its own code so it reads as our bug.
    if (res.status === 409) {
      const conflict = await res.json().catch(() => null);
      const conflictBody = readRazorpayErrorBody(conflict);
      const keyReused = /different request/i.test(
        conflictBody?.description ?? "",
      );
      if (attempt === 0 && !keyReused) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      throw new RefundError(
        conflictBody?.description ??
          "Razorpay refund is still in flight for this idempotency key",
        keyReused ? "REFUND_IDEMPOTENCY_KEY_REUSED" : "REFUND_IN_FLIGHT",
        "RAZORPAY",
      );
    }

    // Razorpay's error body is `{ error: { code, description } }` — the shape
    // handleRazorpayRefundError already parses, so throw it through unchanged.
    const parsed = await res.json().catch(() => null);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      throw parsed;
    }
    throw new RefundError(
      `Razorpay refund failed with HTTP ${res.status}`,
      "UNKNOWN_ERROR",
      "RAZORPAY",
    );
  }
}

/**
 * Create a refund for a Razorpay payment
 * Note: Razorpay refunds are created on payment IDs, not order IDs
 */
export async function createRazorpayRefund({
  paymentIntentId,
  amount,
  reason,
  metadata,
  idempotencyKey,
}: RefundParams): Promise<RefundResult> {
  const razorpayClient = getRazorpayClient();
  if (!razorpayClient) {
    throw new RefundError(
      "Razorpay client not initialized - cannot process refund",
      "RAZORPAY_NOT_INITIALIZED",
      "RAZORPAY",
    );
  }

  try {
    // First, get the payment ID from the order
    const payments = await withRazorpaySdkTimeout("orders.fetchPayments", () =>
      razorpayClient.orders.fetchPayments(paymentIntentId),
    );

    if (payments.count === 0) {
      throw new RefundError(
        "No payment found for this order",
        "NO_PAYMENT_FOUND",
        "RAZORPAY",
      );
    }

    // PM-12 — an order can carry failed attempts before the captured one;
    // items[0] is creation-ordered, so refunding it blindly can target a
    // non-captured payment. Prefer the captured payment.
    const payment =
      payments.items.find((p) => p.status === "captured") ?? payments.items[0];

    // Create refund on the payment. Raw HTTP, not the SDK — see postRefund.
    const refund = await postRefund({
      paymentId: payment.id,
      amount: amount || undefined, // already in smallest currency unit (paise)
      notes: {
        reason: reason || "requested_by_customer",
        ...metadata,
      },
      idempotencyKey,
    });

    return {
      refundId: refund.id,
      amount: Number(refund.amount), // already in smallest currency unit
      currency: refund.currency?.toUpperCase() || "INR",
      status: mapGatewayRefundStatus(refund.status),
      metadata: refund.notes
        ? (refund.notes as Record<string, unknown>)
        : undefined,
    };
  } catch (error) {
    console.error("Razorpay refund creation failed:", error);
    // NO_PAYMENT_FOUND/etc are our own pre-gateway validation (thrown above in
    // this same try), not a gateway fault — tag by origin so the dashboard
    // doesn't conflate "Razorpay is down" with "this order has no payment".
    const isModelledValidation =
      error instanceof RefundError && error.code !== "UNKNOWN_ERROR";
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "razorpay" },
      expected: isModelledValidation,
    });
    throw handleRazorpayRefundError(error);
  }
}

/**
 * Get refund status from Razorpay
 */
export async function getRazorpayRefund(
  refundId: string,
): Promise<RefundResult> {
  const razorpayClient = getRazorpayClient();
  if (!razorpayClient) {
    throw new RefundError(
      "Razorpay client not initialized",
      "RAZORPAY_NOT_INITIALIZED",
      "RAZORPAY",
    );
  }

  try {
    const refund = await withRazorpaySdkTimeout("refunds.fetch", () =>
      razorpayClient.refunds.fetch(refundId),
    );

    return {
      refundId: refund.id,
      amount: Number(refund.amount), // already in smallest currency unit
      currency: refund.currency?.toUpperCase() || "INR",
      status: mapGatewayRefundStatus(refund.status),
      metadata: refund.notes
        ? (refund.notes as Record<string, unknown>)
        : undefined,
    };
  } catch (error) {
    console.error("Razorpay refund retrieval failed:", error);
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "razorpay" },
    });
    throw handleRazorpayRefundError(error);
  }
}

/**
 * List all refunds for a payment
 * Note: This function receives an orderId, not a paymentId
 */
export async function listRazorpayRefunds(
  orderId: string,
  limit: number = 10,
): Promise<RefundResult[]> {
  const razorpayClient = getRazorpayClient();
  if (!razorpayClient) {
    throw new RefundError(
      "Razorpay client not initialized",
      "RAZORPAY_NOT_INITIALIZED",
      "RAZORPAY",
    );
  }

  try {
    // First, get the payment ID from the order ID
    const payments = await withRazorpaySdkTimeout("orders.fetchPayments", () =>
      razorpayClient.orders.fetchPayments(orderId),
    );
    if (payments.count === 0) {
      return []; // No payments for this order, so no refunds
    }
    // PM-12 — prefer the captured payment over a failed earlier attempt.
    const paymentId = (
      payments.items.find((p) => p.status === "captured") ?? payments.items[0]
    ).id;

    // Fetch refunds for the specific payment using the SDK method
    const refundsResponse = await withRazorpaySdkTimeout(
      "payments.fetchMultipleRefund",
      () =>
        razorpayClient.payments.fetchMultipleRefund(paymentId, {
          count: limit,
        }),
    );

    return refundsResponse.items.map((refund) => ({
      refundId: refund.id,
      amount: Number(refund.amount), // already in smallest currency unit
      currency: refund.currency?.toUpperCase() || "INR",
      status: mapGatewayRefundStatus(refund.status),
      metadata: refund.notes || undefined,
    }));
  } catch (error) {
    console.error("Razorpay refunds list failed:", error);
    reportSentryError(error, {
      subsystem: "payments",
      tags: { provider: "razorpay" },
    });
    throw handleRazorpayRefundError(error);
  }
}

// ============================================================================
// Dispute Operations (Webhook-only)
// ============================================================================

/**
 * Note: Razorpay does not have a direct API for managing disputes.
 * Disputes are handled through the Razorpay dashboard and webhook events.
 *
 * Webhook events to listen for:
 * - payment.dispute.created
 * - payment.dispute.won
 * - payment.dispute.lost
 * - payment.dispute.closed
 *
 * These events will be handled in the webhook route.
 */

// ============================================================================
// Mapping Helpers
// ============================================================================

// ============================================================================
// Error Handlers
// ============================================================================

/**
 * #1353 — `"error" in error` also passes for `{ error: undefined }`, and the
 * envelope really does arrive that way; reading `.code` off it then throws a
 * TypeError that escapes the handler entirely (E2E 2026-09-04: reconcile-refunds
 * lost 4 of 8 rows to it instead of classifying them). Returns the body only
 * when its fields are readable, so callers fall through to their generic error.
 */
function readRazorpayErrorBody(
  error: unknown,
): { code?: string; description?: string; reason?: string } | null {
  if (!error || typeof error !== "object" || !("error" in error)) {
    return null;
  }

  const body = (error as { error: unknown }).error;
  if (!body || typeof body !== "object") {
    return null;
  }

  const { code, description, reason } = body as {
    code?: unknown;
    description?: unknown;
    reason?: unknown;
  };

  return {
    // A non-string code would break the `.includes` branching below.
    code: typeof code === "string" ? code : undefined,
    description: typeof description === "string" ? description : undefined,
    // #1437 — the auth-shape test below reads it; same string guard.
    reason: typeof reason === "string" ? reason : undefined,
  };
}

function handleRazorpayError(error: unknown): PaymentError {
  const razorpayError = readRazorpayErrorBody(error);
  if (razorpayError) {
    const code = razorpayError.code || "UNKNOWN_ERROR";
    const description = razorpayError.description || "Failed to create order";

    // #1437 — BAD_REQUEST_ERROR is Razorpay's generic 4xx class: a bad
    // amount, an over-long note, a malformed receipt and genuinely bad
    // credentials all arrive under it. Reporting every one of them as an
    // auth failure sent operators to rotate keys that were fine, and hid the
    // one field the gateway actually named. Only the auth-shaped payloads
    // (HTTP 401, or a description/reason that says so) keep that wording.
    if (code.includes("BAD_REQUEST_ERROR")) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      const reason = razorpayError.reason || "";
      const looksLikeAuthFailure =
        statusCode === 401 ||
        /authentic/i.test(description) ||
        /authentic/i.test(reason);

      if (looksLikeAuthFailure) {
        return new PaymentError(
          "Authentication failed - Invalid Razorpay credentials",
          "AUTH_ERROR",
          "RAZORPAY",
          error,
        );
      }

      return new PaymentError(
        `Razorpay rejected the request: ${description}`,
        "GATEWAY_REJECTED",
        "RAZORPAY",
        error,
      );
    }

    if (code.includes("GATEWAY_ERROR")) {
      return new PaymentError(
        "Payment gateway temporarily unavailable",
        "GATEWAY_ERROR",
        "RAZORPAY",
        error,
      );
    }

    return new PaymentError(description, code, "RAZORPAY", error);
  }

  return new PaymentError(
    "Failed to create payment order",
    "UNKNOWN_ERROR",
    "RAZORPAY",
    error,
  );
}

function handleRazorpayRefundError(error: unknown): RefundError {
  // Already classified upstream (NO_PAYMENT_FOUND, REFUND_IN_FLIGHT,
  // RAZORPAY_NOT_INITIALIZED) — re-wrapping would flatten it to UNKNOWN_ERROR
  // and lose the code callers branch on.
  if (error instanceof RefundError) {
    return error;
  }

  const razorpayError = readRazorpayErrorBody(error);
  if (razorpayError) {
    const code = razorpayError.code || "UNKNOWN_ERROR";
    const description = razorpayError.description || "Failed to process refund";

    return new RefundError(description, code, "RAZORPAY", error);
  }

  return new RefundError(
    "Failed to process refund",
    "UNKNOWN_ERROR",
    "RAZORPAY",
    error,
  );
}
