"use client";

import * as Sentry from "@sentry/nextjs";
import { useToast } from "@/hooks/use-toast";
import { getErrorToast } from "@/lib/errors/mapping/payment-error-toast-map";
import { ErrorTypes } from "@/lib/errors/classification/payment-error-classification";
import { CheckoutInput, checkoutResponseSchema } from "@/schemas/checkout";
import { PaymentGateway } from "@prisma/client";

// #1396 — every checkout page and both gateway components caught an
// unexpected error the same way; centralising it removed the repeated
// three-line block flagged as duplication rather than leaving the copies.
export function reportPaymentsError(error: unknown): void {
  Sentry.captureException(
    error instanceof Error ? error : new Error(String(error)),
    {
      tags: { subsystem: "payments" },
    },
  );
}

export function loadScript(src: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve(true);
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.body.appendChild(script);
  });
}

// Common error handling logic for checkout pages
interface CheckoutApiError {
  error?: string;
  errorType?: string;
  message?: string;
}

export function createHandleApiError(
  toast: ReturnType<typeof useToast>["toast"],
) {
  return (errorData: CheckoutApiError) => {
    const errorMessage = errorData.error || "Operation failed";
    const errorType = errorData.errorType || "UNKNOWN_ERROR";

    const { title, description } = getErrorToast(errorType, errorMessage);

    toast({
      title,
      description,
      variant: "destructive",
    });
  };
}

// #828 — one key per logical checkout attempt (stable across double-clicks
// and network retries within a mount; a fresh mount = a fresh attempt). The
// server CASes on Payment.clientIdempotencyKey and replays the original
// response instead of minting a duplicate order.
export function mintClientIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID
    ? `ck_${globalThis.crypto.randomUUID().replace(/-/g, "")}`
    : `ck_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

// Common API request logic for checkout
export async function makeCheckoutRequest(
  checkoutData: CheckoutInput,
  isMockPayment: boolean = false,
  clientIdempotencyKey?: string,
): Promise<Response> {
  return fetch("/api/checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...checkoutData,
      isMockPayment,
      ...(clientIdempotencyKey && { clientIdempotencyKey }),
    }),
  });
}

// ============================================================================
// B5 (booking-journey audit) — flash-sale busy retry
// ============================================================================

/**
 * The two structured 409s the checkout locks return when someone ELSE holds
 * the gate: another buyer holds an event's mutex, or this same account is
 * mid-checkout from another device. Both are transient by design — the holder
 * commits or releases within seconds — yet they used to dead-end as terminal
 * error toasts while the buyer watched a hot slot slip away.
 */
const BUSY_ERROR_TYPES = new Set([
  "EVENT_CHECKOUT_BUSY",
  "CONSULTEE_BOOKING_BUSY",
]);

/** Never wait longer than this server-advised pause (function-ceiling friendly). */
const MAX_BUSY_WAIT_SECONDS = 20;

interface BusyBody {
  errorType?: string;
  retryAfter?: number;
}

/**
 * Runs one checkout attempt; on a structured BUSY 409, tells the user what is
 * happening, waits the advised pause (capped), and retries EXACTLY ONCE.
 *
 * The single-retry discipline matters: the same clientIdempotencyKey rides
 * both attempts and the server CASes on it, so the retry can never mint a
 * duplicate order — but hammering the endpoint would, so no exponential loop.
 * The caller's `attempt` closure supplies its own headers/key unchanged.
 */
export async function fetchCheckoutWithBusyRetry(
  attempt: () => Promise<Response>,
  notifyBusy: (waitSeconds: number) => void,
): Promise<Response> {
  const response = await attempt();
  if (response.status !== 409) return response;

  let body: BusyBody;
  try {
    body = (await response.clone().json()) as BusyBody;
  } catch {
    return response;
  }
  const retryAfter = Number(body?.retryAfter);
  if (
    !body?.errorType ||
    !BUSY_ERROR_TYPES.has(body.errorType) ||
    !Number.isFinite(retryAfter)
  ) {
    return response;
  }

  const waitSeconds = Math.min(
    Math.max(1, Math.round(retryAfter)),
    MAX_BUSY_WAIT_SECONDS,
  );
  notifyBusy(waitSeconds);
  await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));

  // One automatic retry — the idempotency key in `attempt` makes this safe.
  return attempt();
}

/** Shared copy for the during-wait notice so all four surfaces sound alike. */
export function busyRetryToast(waitSeconds: number): {
  title: string;
  description: string;
} {
  return {
    title: "Almost got it — someone is one step ahead",
    description: `Your card has not been charged. Retrying automatically in ${waitSeconds}s…`,
  };
}

// Common success handling logic for different appointment types
export function createHandleCheckoutSuccess(
  toast: ReturnType<typeof useToast>["toast"],
  appointmentType:
    | "CONSULTATION"
    | "WEBINAR"
    | "CLASS"
    | "SUBSCRIPTION"
    | "TRIAL",
) {
  return (
    data: { skipPayment?: boolean; [key: string]: unknown },
    isDevMode: boolean = false,
    isMockPayment: boolean = false,
  ) => {
    const typeMessages = {
      CONSULTATION: {
        dev: "Your consultation has been confirmed. Check your dashboard for details.",
        mock: "Mock payment processed. Your consultation has been confirmed. Check your dashboard for details.",
        prod: "Redirecting to secure payment gateway. Complete your payment to confirm the consultation.",
        successTitle: "✅ Consultation Booked Successfully!",
      },
      WEBINAR: {
        dev: "You're registered for the webinar. Check your dashboard for details.",
        mock: "Mock payment processed. Your webinar has been confirmed. Check your dashboard for details.",
        prod: "Redirecting to secure payment gateway. Complete your payment to confirm the registration.",
        successTitle: "✅ Webinar Booked Successfully!",
      },
      CLASS: {
        dev: "You're registered for the class. Check your dashboard for details.",
        mock: "Mock payment processed. Your class has been confirmed. Check your dashboard for details.",
        prod: "Redirecting to secure payment gateway. Complete your payment to confirm the registration.",
        successTitle: "✅ Class Booked Successfully!",
      },
      SUBSCRIPTION: {
        dev: "Your subscription has been activated. Check your dashboard for details.",
        mock: "Mock payment processed. Your subscription has been activated. Check your dashboard for details.",
        prod: "Redirecting to secure payment gateway. Complete your payment to activate the subscription.",
        successTitle: "✅ Subscription Activated Successfully!",
      },
      // #1429 — TRIAL is the fifth AppointmentsType and now reaches the
      // branded checkout like the other four, so the lookup below must resolve
      // for it; an absent arm would read `undefined.successTitle` the moment
      // the trial page mints its own order instead of handing off a pay-link.
      TRIAL: {
        dev: "Your trial session is confirmed. Check your dashboard for details.",
        mock: "Mock payment processed. Your trial session is confirmed. Check your dashboard for details.",
        prod: "Redirecting to secure payment gateway. Complete your payment to confirm the trial session.",
        successTitle: "✅ Trial Session Booked Successfully!",
      },
    };

    const messages = typeMessages[appointmentType];

    if (isDevMode || isMockPayment) {
      // Development mode or mock payment - direct booking success
      toast({
        title: messages.successTitle,
        description: isMockPayment
          ? messages.mock
          : data.skipPayment
            ? messages.dev
            : `Payment processed successfully. ${messages.dev}`,
        variant: "default",
      });

      // Redirect after a short delay
      setTimeout(() => {
        window.location.href = "/dashboard";
      }, 2000);
    } else {
      // Production mode - payment initiated success
      toast({
        title: "🚀 Payment Initiated!",
        description: messages.prod,
        variant: "default",
      });
    }
  };
}

// Unified workflow - payment gateway processing with mock payment support
export async function handleUnifiedCheckout(
  checkoutData: CheckoutInput,
  gateway: PaymentGateway,
  handleApiError: (errorData: CheckoutApiError) => void,
  handleCheckoutSuccess: (
    data: { skipPayment?: boolean; [key: string]: unknown },
    isDevMode?: boolean,
    isMockPayment?: boolean,
  ) => void,
  isMockPayment: boolean = false,
): Promise<void> {
  const response = await makeCheckoutRequest(checkoutData, isMockPayment);

  if (!response.ok) {
    const errorData = await response.json();
    handleApiError(errorData);
    return; // Toast already shown — don't throw to avoid double toast + console overlay
  }

  const rawData = await response.json();

  // Validate response using schema
  const validationResult = checkoutResponseSchema.safeParse(rawData);
  if (!validationResult.success) {
    console.error("Invalid checkout response:", validationResult.error);
    throw new Error("Invalid response from server");
  }

  const data = validationResult.data;

  // handleUnifiedCheckout is only invoked by the dev-only Mock Pay button (isMockPayment=true).
  // Real payments go through StripeCheckout/RazorpayCheckout components.
  if (data.success && (data.skipPayment || isMockPayment)) {
    handleCheckoutSuccess(data, data.skipPayment, isMockPayment);
  } else if (!data.success) {
    handleApiError({ error: data.error, errorType: data.errorType });
  }
}

// #1437 — WALLET/INVOICE/LICENSE org funding, zero-amount (credits) and mock
// payments all confirm synchronously server-side with a synthetic id and no
// gateway order/client secret. Opening Razorpay/Stripe on that id 400s and
// shows a false "Payment Failed" alert over a booking that already
// succeeded, so every gateway component must check this before opening.
export function checkoutNeedsGateway(data: {
  skipPayment?: boolean;
  isZeroAmountPayment?: boolean;
  [key: string]: unknown;
}): boolean {
  return !(data.skipPayment || data.isZeroAmountPayment);
}

// Gateway configuration for UI rendering. The four checkout pages each carried
// their own copy of this array with `isActive: true` hardcoded on both entries,
// so the fence had to be applied in four places to hold. One list now.
//
// #1351 — Stripe is a contingency rail kept in the tree in case RBI rules
// change, not a live payment method: without NEXT_PUBLIC_STRIPE_ENABLED=true
// the card renders the disabled "Coming Soon" button and no StripeCheckout
// mounts. The server-side fence (STRIPE_ENABLED, assertGatewayUsable) is the
// one that actually protects money; this only keeps the UI honest, because a
// NEXT_PUBLIC_ value is inlined into the client bundle and a buyer can edit it.
export const paymentGateways = [
  {
    name: "Stripe",
    description: "Card payments (international)",
    gateway: "STRIPE" as const,
    isActive: process.env.NEXT_PUBLIC_STRIPE_ENABLED === "true",
  },
  {
    name: "Razorpay",
    description: "UPI, cards & bank transfer",
    gateway: "RAZORPAY" as const,
    isActive: true,
  },
];

// Default success and error handlers for StripeCheckout component
export function createStripeCheckoutHandlers(
  toast: ReturnType<typeof useToast>["toast"],
) {
  return {
    onPaymentSuccess: (_response: { message: string }) => {
      toast({
        title: "Payment Successful",
        description:
          "Your payment has been confirmed! Redirecting to your confirmation page...",
      });
      window.location.href = "/checkout/checkout-success";
    },
    onPaymentError: (error: {
      message?: string;
      code?: string;
      errorType?: string;
      error?: string;
    }) => {
      // Booking-conflict errors from /api/checkout (slot taken/relinquished,
      // event expired) carry our own errorType — route them through the precise
      // toast map instead of the gateway card-decline heuristics.
      const conflictCode = error.errorType ?? error.code;
      if (
        conflictCode &&
        (Object.values(ErrorTypes) as string[]).includes(conflictCode)
      ) {
        const { title, description } = getErrorToast(
          conflictCode,
          error.message ?? error.error,
        );
        toast({ title, description, variant: "destructive" });
        return;
      }
      const errorMessage =
        error.message || error.code || "An unexpected error occurred";
      const userFriendlyMessage =
        errorMessage.includes("card") || errorMessage.includes("payment_method")
          ? "Your card was declined. Please check your card details or try a different payment method."
          : errorMessage.includes("insufficient")
            ? "Your card has insufficient funds. Please use a different card or payment method."
            : errorMessage.includes("expired")
              ? "Your card has expired. Please use a different card."
              : errorMessage.includes("network")
                ? "Connection error. Please check your internet connection and try again."
                : `Payment failed: ${errorMessage}. Please try again or contact your bank if the problem persists.`;

      toast({
        title: "Payment Failed",
        description: userFriendlyMessage,
        variant: "destructive",
      });
    },
  };
}

// Default success and error handlers for RazorpayCheckout component
export function createRazorpayCheckoutHandlers(
  toast: ReturnType<typeof useToast>["toast"],
) {
  return {
    onPaymentSuccess: (response: {
      razorpay_order_id?: string;
      razorpay_payment_id?: string;
      message?: string;
    }) => {
      // Booking confirmation is webhook-driven, so at this instant the money is
      // captured and the appointment may not exist yet. Razorpay used to land
      // on /dashboard, where that gap reads as "I paid and got nothing" —
      // Stripe has always gone to /checkout/checkout-success, which polls
      // /api/checkout/verify, drives the pipeline synchronously and says
      // "payment received, confirming". Same surface for both gateways now.
      //
      // `Payment.paymentIntent` IS the Razorpay order id (the verify route
      // keys on `order_` for its sync branch), so that is the id to hand over.
      if (response.razorpay_order_id) {
        window.location.href = `/checkout/checkout-success?payment_intent=${encodeURIComponent(
          response.razorpay_order_id,
        )}`;
        return;
      }
      // No order id = credits covered the whole price, so there is nothing to
      // verify and the booking is already confirmed.
      toast({
        title: "Payment Successful",
        description:
          response.message ??
          "Your booking is confirmed. Redirecting to your dashboard...",
      });
      window.location.href = "/dashboard";
    },
    onPaymentError: (error: {
      description?: string;
      code?: string;
      reason?: string;
      message?: string;
    }) => {
      // Booking-conflict errors from /api/checkout (slot taken/relinquished,
      // event expired) carry our own errorType in `code` — surface the precise
      // toast instead of the gateway card-decline heuristics.
      if (
        error.code &&
        (Object.values(ErrorTypes) as string[]).includes(error.code)
      ) {
        const { title, description } = getErrorToast(
          error.code,
          error.description ?? error.message,
        );
        toast({ title, description, variant: "destructive" });
        return;
      }
      const errorDescription =
        error.description || error.reason || "An unexpected error occurred";
      const userFriendlyMessage =
        errorDescription.includes("payment failed") ||
        errorDescription.includes("declined")
          ? "Your payment was declined by the bank. Please check your payment details or try a different payment method."
          : errorDescription.includes("cancelled") ||
              errorDescription.includes("canceled")
            ? "Payment was cancelled. You can try again when you're ready."
            : errorDescription.includes("insufficient")
              ? "Insufficient funds in your account. Please use a different payment method."
              : errorDescription.includes("timeout") ||
                  errorDescription.includes("network")
                ? "Payment timed out due to a connection issue. Please check your internet and try again."
                : errorDescription.includes("invalid")
                  ? "Invalid payment details. Please check your information and try again."
                  : `${errorDescription}. Please try again or contact your bank for assistance.`;

      toast({
        title: "Payment Failed",
        description: userFriendlyMessage,
        variant: "destructive",
      });
    },
  };
}
