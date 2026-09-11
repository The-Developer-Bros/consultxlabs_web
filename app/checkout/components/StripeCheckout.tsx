"use client";

import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { CheckoutInput, checkoutResponseSchema } from "@/schemas/checkout";
import { useState } from "react";
import {
  busyRetryToast,
  checkoutNeedsGateway,
  fetchCheckoutWithBusyRetry,
  mintClientIdempotencyKey,
  reportPaymentsError,
} from "@/app/checkout/plans/utils";

// #1396 — this flow redirects to a Stripe-hosted checkoutUrl, so Stripe.js is
// never loaded and the publishable key's presence is the only thing worth
// checking here. This subsumes #1351's lazy `loadStripe` behind the fence: not
// importing the SDK at all is strictly stronger than importing it late, and
// the rail stays fenced where it matters — the gateway list hides the card
// without NEXT_PUBLIC_STRIPE_ENABLED, and `assertGatewayUsable` refuses the
// route server-side.
const stripeKey = process.env.NEXT_PUBLIC_STRIPE_KEY;

interface StripePaymentSuccess {
  message: string;
}

interface StripePaymentError {
  message?: string;
  code?: string;
  errorType?: string;
  error?: string;
}

interface StripeCheckoutProps {
  checkoutData: CheckoutInput;
  onPaymentSuccess: (response: StripePaymentSuccess) => void;
  onPaymentError: (error: StripePaymentError) => void;
  disabled?: boolean;
  /**
   * Ran on the click, before anything is charged; returning false aborts.
   *
   * A page gating a finite resource — event seats — can only re-check it here.
   * `disabled` reflects the last render, and a webinar can fill while the tab
   * sits open, so without this the buyer pays into a rejection.
   */
  onBeforeCheckout?: () => Promise<boolean>;
}

export default function StripeCheckout({
  checkoutData,
  onPaymentSuccess,
  onPaymentError,
  disabled,
  onBeforeCheckout,
}: StripeCheckoutProps) {
  const { toast } = useToast();
  const [isProcessing, setIsProcessing] = useState(false);
  // #828 — stable per-mount; the server dedupes retries on this key.
  // useState's lazy initializer runs once, unlike a useRef(arg) expression
  // which would mint a key every render.
  const [idempotencyKey] = useState(mintClientIdempotencyKey);

  const handleCheckout = async () => {
    // Before the spinner, so an abort leaves the button exactly as it was.
    if (onBeforeCheckout && !(await onBeforeCheckout())) return;
    setIsProcessing(true);
    try {
      if (!stripeKey) {
        const errorMsg =
          "The Stripe payment system is not properly configured on this website. This is a technical issue on our end. Please contact support for assistance, or try a different payment method.";
        toast({
          title: "Payment System Configuration Error",
          description: errorMsg,
          variant: "destructive",
        });
        onPaymentError({ message: errorMsg });
        return;
      }

      // Make API call to create checkout session/payment intent
      console.log("Making checkout request with data:", checkoutData);

      // B5 — same busy-retry discipline as the Razorpay path.
      const response = await fetchCheckoutWithBusyRetry(
        () =>
          fetch("/api/checkout", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...checkoutData,
              clientIdempotencyKey: idempotencyKey,
            }),
          }),
        (waitSeconds) => toast(busyRetryToast(waitSeconds)),
      );

      console.log("Response status:", response.status);

      if (!response.ok) {
        const errorData = await response.json();
        console.error("API error response:", errorData);
        onPaymentError(errorData);
        return;
      }

      const rawData = await response.json();
      console.log("Checkout API response:", rawData);

      // Validate response using schema
      const validationResult = checkoutResponseSchema.safeParse(rawData);
      if (!validationResult.success) {
        Sentry.captureException(
          validationResult.error instanceof Error
            ? validationResult.error
            : new Error(String(validationResult.error)),
          { tags: { subsystem: "payments" } },
        );
        console.error("Invalid checkout response:", validationResult.error);
        console.error("Raw response data:", rawData);
        onPaymentError({ message: "Invalid response from server" });
        return;
      }

      const data = validationResult.data;

      if (!data.success) {
        onPaymentError({ message: data.error, errorType: data.errorType });
        return;
      }

      // #1437 — mock/dev, zero-amount (credits) and org WALLET/INVOICE/
      // LICENSE funding all confirm synchronously with no gateway redirect;
      // checkoutNeedsGateway is the one place that decision is made.
      if (!checkoutNeedsGateway(data)) {
        onPaymentSuccess({
          message:
            data.message ||
            (data.isZeroAmountPayment
              ? "Payment completed via referral credits. Appointment booked successfully."
              : "Payment skipped in development mode"),
        });
        return;
      }

      // Handle payment based on what the server returns
      if (data.checkoutUrl) {
        // For hosted checkout sessions, redirect directly
        window.location.href = data.checkoutUrl;
      } else if (data.paymentIntent?.client_secret) {
        // For Stripe, client_secret now contains the checkout URL
        if (
          data.paymentIntent.client_secret.startsWith(
            "https://checkout.stripe.com",
          )
        ) {
          window.location.href = data.paymentIntent.client_secret;
        } else {
          // Fallback for other formats
          window.location.href = data.paymentIntent.client_secret;
        }
      } else if (data.clientSecret) {
        // Direct client_secret field
        if (data.clientSecret.startsWith("https://checkout.stripe.com")) {
          window.location.href = data.clientSecret;
        } else {
          // Legacy Payment Intent format (shouldn't happen with new implementation)
          onPaymentError({
            message: "Payment method requires additional setup",
          });
        }
      } else {
        onPaymentError({
          message: "No payment method available in response",
        });
      }
    } catch (error) {
      reportPaymentsError(error);
      onPaymentError({
        message:
          error instanceof Error ? error.message : "An unknown error occurred",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <Button onClick={handleCheckout} disabled={isProcessing || disabled}>
      {isProcessing ? "Processing..." : "Pay with Stripe"}
    </Button>
  );
}
