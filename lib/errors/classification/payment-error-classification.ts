/**
 * Centralized error classification for payment-related API routes.
 *
 * Separates *business-logic rejections* (expected, clean one-liner log)
 * from *infrastructure failures* (unexpected, full stack trace for debugging).
 *
 * Usage:
 *   import { classifyError, logClassifiedError } from "@/lib/payments/error-classification";
 *
 *   const classified = classifyError(error);
 *   logClassifiedError("Checkout", classified, error);
 */

import * as Sentry from "@sentry/nextjs";

// ============================================================================
// Error Types — used by both server routes and frontend toast mapping
// ============================================================================

export const ErrorTypes = {
  // Business-logic rejections (expected — user can fix or retry differently)
  EVENT_EXPIRED: "EVENT_EXPIRED_ERROR",
  AVAILABILITY: "AVAILABILITY_ERROR",
  DUPLICATE_REGISTRATION: "DUPLICATE_REGISTRATION_ERROR",
  NOT_FOUND: "NOT_FOUND_ERROR",
  REFUND_BLOCKED: "REFUND_BLOCKED_ERROR",
  LOCK_CONTENTION: "LOCK_CONTENTION_ERROR",
  UNSUPPORTED_CONFIG: "UNSUPPORTED_CONFIG_ERROR",
  GATEWAY_UNAVAILABLE: "GATEWAY_UNAVAILABLE_ERROR",
  // #1426 — CONSENT_REQUIRED/CONSENT_WITHDRAWN flow through classifyByErrorCode
  // below, so their value only has to be unique. WALLET_FROZEN never reaches
  // classifyByErrorCode (app/api/checkout/route.ts intercepts WalletFrozenError
  // by instanceof and hardcodes `errorType: "WALLET_FROZEN"` in the response
  // JSON), so this value must equal that literal or the toast map misses it.
  WALLET_FROZEN: "WALLET_FROZEN",
  CONSENT_REQUIRED: "CONSENT_REQUIRED_ERROR",
  CONSENT_WITHDRAWN: "CONSENT_WITHDRAWN_ERROR",
  // Same literal-equality rule as WALLET_FROZEN above: the checkout route
  // intercepts DomainVerificationRequiredError by instanceof and hardcodes this
  // string in the response JSON.
  DOMAIN_VERIFICATION_REQUIRED: "DOMAIN_VERIFICATION_REQUIRED",
  // #1458 — the three org-programme refusals checkout can raise from inside its
  // transaction. Each is a rejection the buyer or their admin can act on, so
  // each carries its own toast rather than sharing one "config" bucket.
  PROGRAM_CAP_EXHAUSTED: "PROGRAM_CAP_EXHAUSTED_ERROR",
  PROGRAM_SESSION_CAP_REACHED: "PROGRAM_SESSION_CAP_REACHED_ERROR",
  OVERAGE_CHARGE_MEMBER_UNSUPPORTED: "OVERAGE_CHARGE_MEMBER_UNSUPPORTED_ERROR",
  // #1467 — the two org-sponsorship refusals raised BEFORE checkout takes its
  // lock. They are entitlement states, not overage states, so they get their own
  // types rather than borrowing one of the three above.
  PROGRAM_ASSIGNMENT_INACTIVE: "PROGRAM_ASSIGNMENT_INACTIVE_ERROR",
  BILLING_SUSPENDED_DUNNING: "BILLING_SUSPENDED_DUNNING_ERROR",
  // #1477 — an overdrawn org wallet. Distinct from WALLET_FROZEN above: the
  // balance is trustworthy and simply too small, so the fix is a top-up rather
  // than an ops reconciliation. The checkout route reaches this through
  // `ErrorTypes`, so the value is free to keep the `_ERROR` suffix.
  WALLET_INSUFFICIENT_FUNDS: "WALLET_INSUFFICIENT_FUNDS_ERROR",

  // Infrastructure failures (unexpected — ops/dev needs to investigate)
  PAYMENT_CONFIG: "PAYMENT_CONFIG_ERROR",
  PAYMENT_PROCESSING: "PAYMENT_PROCESSING_ERROR",
  DATABASE: "DATABASE_ERROR",

  // Catch-all
  UNKNOWN: "UNKNOWN_ERROR",
} as const;

export type ErrorType = (typeof ErrorTypes)[keyof typeof ErrorTypes];

// ============================================================================
// Business-logic error patterns
// ============================================================================

/**
 * Each entry maps a keyword (matched case-insensitively against error.message)
 * to an ErrorType. Order matters — first match wins.
 */
export const BUSINESS_ERROR_PATTERNS: ReadonlyArray<{
  pattern: string;
  errorType: ErrorType;
}> = [
  // Event lifecycle
  { pattern: "already ended", errorType: ErrorTypes.EVENT_EXPIRED },
  { pattern: "has been cancelled", errorType: ErrorTypes.EVENT_EXPIRED },
  { pattern: "no longer accept", errorType: ErrorTypes.EVENT_EXPIRED },

  // Scheduling / availability
  { pattern: "has not been scheduled", errorType: ErrorTypes.AVAILABILITY },
  { pattern: "currently booking", errorType: ErrorTypes.AVAILABILITY },
  { pattern: "currently checking out", errorType: ErrorTypes.AVAILABILITY },
  // Consultee double-book (FAMILIARISE_WEB-P) — message has no "slot" substring.
  {
    pattern: "already have a session booked",
    errorType: ErrorTypes.AVAILABILITY,
  },
  { pattern: "slot", errorType: ErrorTypes.AVAILABILITY },
  { pattern: "availability", errorType: ErrorTypes.AVAILABILITY },
  { pattern: "capacity", errorType: ErrorTypes.AVAILABILITY },
  { pattern: "full", errorType: ErrorTypes.AVAILABILITY },

  // Duplicate registrations
  {
    pattern: "already registered",
    errorType: ErrorTypes.DUPLICATE_REGISTRATION,
  },
  { pattern: "already enrolled", errorType: ErrorTypes.DUPLICATE_REGISTRATION },

  // Not found
  { pattern: "not found", errorType: ErrorTypes.NOT_FOUND },

  // Refund guards
  {
    pattern: "already been paid out",
    errorType: ErrorTypes.REFUND_BLOCKED,
  },
  {
    pattern: "already been fully refunded",
    errorType: ErrorTypes.REFUND_BLOCKED,
  },
  {
    pattern: "exceeds available balance",
    errorType: ErrorTypes.REFUND_BLOCKED,
  },
  {
    pattern: "only successful payments",
    errorType: ErrorTypes.REFUND_BLOCKED,
  },

  // Discount / pricing validation
  { pattern: "discount code", errorType: ErrorTypes.AVAILABILITY },
  { pattern: "maximum uses", errorType: ErrorTypes.AVAILABILITY },
  { pattern: "minimum order", errorType: ErrorTypes.AVAILABILITY },
  { pattern: "below the", errorType: ErrorTypes.AVAILABILITY },
  { pattern: "percentage value must be", errorType: ErrorTypes.AVAILABILITY },

  // Org credit pool
  { pattern: "insufficient credits", errorType: ErrorTypes.AVAILABILITY },

  // Lock contention (payout batches, etc.)
  { pattern: "already in progress", errorType: ErrorTypes.LOCK_CONTENTION },

  // Config the schema understands but the runtime doesn't (e.g. PROJECT
  // funding source reserved for v2 — checkout must reject rather than
  // silently fall back to TAG_ONLY).
  {
    pattern: "funding source is not yet supported",
    errorType: ErrorTypes.UNSUPPORTED_CONFIG,
  },
] as const;

// ============================================================================
// Infrastructure error patterns
// ============================================================================

export const INFRA_ERROR_PATTERNS: ReadonlyArray<{
  patterns: string[];
  errorType: ErrorType;
  userMessage: string;
}> = [
  {
    patterns: ["Authentication failed", "Invalid API key"],
    errorType: ErrorTypes.PAYMENT_CONFIG,
    userMessage: "Payment gateway configuration error. Please contact support.",
  },
  // The #1219 posture guard: a Razorpay TEST key under NODE_ENV=production.
  // Reaches the route as a typed PaymentError now that the gateway loads at
  // call time; it is a configuration fault, never "try again later".
  {
    patterns: ["RAZORPAY_TEST_KEY_IN_PRODUCTION", "Razorpay TEST key"],
    errorType: ErrorTypes.PAYMENT_CONFIG,
    userMessage:
      "Payments are not available right now. Please contact support.",
  },
  {
    patterns: ["Prisma", "database"],
    errorType: ErrorTypes.DATABASE,
    userMessage: "Database error. Please try again or contact support.",
  },
  {
    patterns: ["Failed to create payment intent"],
    errorType: ErrorTypes.PAYMENT_PROCESSING,
    userMessage:
      "Payment processing unavailable. Please try again later or contact support.",
  },
] as const;

// ============================================================================
// Typed error codes
// ============================================================================

/**
 * Errors that carry a machine-readable `code` are classified on that code
 * rather than on their prose, so rewording a message can never re-route it.
 *
 * #1351 — a rail this deployment fences off, and a gateway that exists in the
 * enum with nothing behind it, are both the caller asking for a payment method
 * we do not offer. That is a rejection the buyer can act on by choosing another
 * method, not the 500 the message-only classifier fell through to.
 */
export const BUSINESS_ERROR_CODES: ReadonlyArray<{
  code: string;
  errorType: ErrorType;
  httpStatus: number;
}> = [
  {
    code: "GATEWAY_DISABLED",
    errorType: ErrorTypes.GATEWAY_UNAVAILABLE,
    httpStatus: 422,
  },
  {
    code: "UNSUPPORTED_GATEWAY",
    errorType: ErrorTypes.GATEWAY_UNAVAILABLE,
    httpStatus: 422,
  },
  // #1426 — the wallet-freeze and consent guards throw with these codes
  // (lib/payments/operations/checkout.ts:881, :1556, :2538) but had no
  // BUSINESS_ERROR_CODES row, so classifyError's message-only fallback
  // mislabelled them 500 instead of the buyer-actionable rejection they are.
  {
    code: "WALLET_FROZEN",
    errorType: ErrorTypes.WALLET_FROZEN,
    httpStatus: 409,
  },
  {
    code: "CONSENT_REQUIRED",
    errorType: ErrorTypes.CONSENT_REQUIRED,
    httpStatus: 403,
  },
  {
    code: "CONSENT_WITHDRAWN",
    errorType: ErrorTypes.CONSENT_WITHDRAWN,
    httpStatus: 403,
  },
  // #1407 — invoice funding is gated on a verified domain
  // (lib/enterprise/governance.ts). The guard throws its own 403, but with no
  // row here the message-only fallback answered 500 UNKNOWN_ERROR and the buyer
  // saw "something went wrong" for a condition their admin can actually fix.
  {
    code: "DOMAIN_VERIFICATION_REQUIRED",
    errorType: ErrorTypes.DOMAIN_VERIFICATION_REQUIRED,
    httpStatus: 403,
  },
  // #1458 — all four are thrown from inside the checkout transaction, where the
  // catch used to rewrite anything it did not recognise to "Failed to record
  // payment information". With a row here the code survives the rethrow and the
  // buyer gets the status and the copy that match the actual refusal.
  {
    code: "PROGRAM_CAP_EXHAUSTED",
    errorType: ErrorTypes.PROGRAM_CAP_EXHAUSTED,
    httpStatus: 402,
  },
  {
    code: "PROGRAM_SESSION_CAP_REACHED",
    errorType: ErrorTypes.PROGRAM_SESSION_CAP_REACHED,
    httpStatus: 402,
  },
  {
    code: "OVERAGE_CHARGE_MEMBER_UNSUPPORTED",
    errorType: ErrorTypes.OVERAGE_CHARGE_MEMBER_UNSUPPORTED,
    httpStatus: 409,
  },
  {
    code: "OVERAGE_UNSUPPORTED_FUNDING",
    errorType: ErrorTypes.UNSUPPORTED_CONFIG,
    httpStatus: 409,
  },
  // #1467 — both were bare `new Error(...)` and so fell through the
  // message-only fallback to 500 UNKNOWN_ERROR. A member whose organisation's
  // contract had merely lapsed could not tell the refusal from a crash, and
  // every one of them opened a Sentry incident.
  {
    code: "PROGRAM_ASSIGNMENT_INACTIVE",
    errorType: ErrorTypes.PROGRAM_ASSIGNMENT_INACTIVE,
    httpStatus: 409,
  },
  {
    code: "BILLING_SUSPENDED_DUNNING",
    errorType: ErrorTypes.BILLING_SUSPENDED_DUNNING,
    httpStatus: 402,
  },
  // #1477 — `walletDebit`'s overdraft guard throws from inside the checkout
  // transaction, and its message ("Insufficient wallet balance on billing
  // account …") matches nothing in the prose fallback, so every low-wallet
  // booking answered 500 and paged as an unexpected fault. 402 is the same
  // "this account cannot fund it" status the programme-budget refusals use.
  {
    code: "WALLET_INSUFFICIENT_FUNDS",
    errorType: ErrorTypes.WALLET_INSUFFICIENT_FUNDS,
    httpStatus: 402,
  },
] as const;

/**
 * True when an error's `code` is one this module already resolves to a status
 * and a toast.
 *
 * #1458 — the checkout transaction's catch has to decide whether an error is
 * safe to rethrow unchanged. Asking "is this code registered?" is the same
 * question the classifier answers a moment later, so the two can never disagree
 * about which refusals reach the buyer intact.
 */
export function isBusinessErrorCode(code: unknown): boolean {
  return (
    typeof code === "string" &&
    BUSINESS_ERROR_CODES.some((entry) => entry.code === code)
  );
}

/**
 * Read a string `code` off an error without importing the class that set it —
 * the toast map re-exports this module into client bundles, so it must stay
 * free of server-side payment imports.
 */
function readErrorCode(error: Error): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Resolve an error's machine-readable `code` to a classification, or
 * `undefined` when the code is absent or not one we recognise. Kept out of
 * `classifyError` so that function stays under the cognitive-complexity bar.
 */
function classifyByErrorCode(error: Error): ClassifiedError | undefined {
  const code = readErrorCode(error);
  if (!code) return undefined;
  const typed = BUSINESS_ERROR_CODES.find((entry) => entry.code === code);
  if (!typed) return undefined;
  return {
    errorMessage: error.message,
    errorType: typed.errorType,
    isBusinessError: true,
    httpStatus: typed.httpStatus,
  };
}

// ============================================================================
// Classifier
// ============================================================================

export interface ClassifiedError {
  /** Message to return to the client */
  errorMessage: string;
  /** Machine-readable error type for frontend toast mapping */
  errorType: ErrorType;
  /** true = expected rejection (warn), false = unexpected (error) */
  isBusinessError: boolean;
  /** Suggested HTTP status code */
  httpStatus: number;
}

/**
 * Classify an Error into a structured result for logging and response.
 *
 * @param error  - The caught error (can be any type)
 * @param fallbackMessage - Default message if error is not an Error instance
 */
export function classifyError(
  error: unknown,
  fallbackMessage = "An unexpected error occurred",
): ClassifiedError {
  if (!(error instanceof Error)) {
    return {
      errorMessage: fallbackMessage,
      errorType: ErrorTypes.UNKNOWN,
      isBusinessError: false,
      httpStatus: 500,
    };
  }

  const msg = error.message;

  // 1. Typed errors win over every message pattern below.
  const typed = classifyByErrorCode(error);
  if (typed) return typed;

  // 2. Check infrastructure patterns (these override user message)
  for (const { patterns, errorType, userMessage } of INFRA_ERROR_PATTERNS) {
    if (patterns.some((p) => msg.includes(p))) {
      return {
        errorMessage: userMessage,
        errorType,
        isBusinessError: false,
        httpStatus: 500,
      };
    }
  }

  // 3. Check business-logic patterns (pass through original message)
  const lowerMsg = msg.toLowerCase();
  for (const { pattern, errorType } of BUSINESS_ERROR_PATTERNS) {
    if (lowerMsg.includes(pattern)) {
      return {
        errorMessage: msg,
        errorType,
        isBusinessError: true,
        httpStatus:
          errorType === ErrorTypes.LOCK_CONTENTION
            ? 409
            : errorType === ErrorTypes.UNSUPPORTED_CONFIG
              ? 422
              : 400,
      };
    }
  }

  // 4. Unrecognised — treat as unexpected
  return {
    errorMessage: msg,
    errorType: ErrorTypes.UNKNOWN,
    isBusinessError: false,
    httpStatus: 500,
  };
}

// ============================================================================
// Logger helper
// ============================================================================

/**
 * Log a classified error with the right severity.
 *
 * @param tag     - Short route identifier, e.g. "Checkout", "Refunds"
 * @param result  - Output from classifyError()
 * @param error   - The original error (only printed for unexpected errors)
 */
export function logClassifiedError(
  tag: string,
  result: ClassifiedError,
  error: unknown,
): void {
  if (result.isBusinessError) {
    console.warn(`[${tag}] Business rule blocked: ${result.errorMessage}`);
  } else {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "payments" } },
    );
    console.error(`[${tag}] Unexpected error:`, error);
  }
}
