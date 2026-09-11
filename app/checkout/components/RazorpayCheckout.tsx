"use client";

import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { loadScript } from "../plans/utils";
import { CheckoutInput } from "@/schemas/checkout";
import { useState } from "react";
import {
  busyRetryToast,
  checkoutNeedsGateway,
  fetchCheckoutWithBusyRetry,
  mintClientIdempotencyKey,
  reportPaymentsError,
} from "@/app/checkout/plans/utils";

interface RazorpayPaymentResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayPaymentError {
  description?: string;
  code?: string;
  reason?: string;
  message?: string;
}

interface RazorpayFailedResponse {
  error: RazorpayPaymentError;
}

interface RazorpayOptions {
  key: string | undefined;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  handler: (response: RazorpayPaymentResponse) => void;
  prefill?: {
    name?: string;
    email?: string;
    contact?: string;
  };
  theme?: {
    color: string;
  };
  /**
   * Closing the gateway sheet fires neither `handler` nor `payment.failed`, so
   * without this the page sat on "Processing..." forever with no way back.
   */
  modal?: {
    ondismiss?: () => void;
  };
}

interface RazorpayInstance {
  on: (
    event: string,
    handler: (response: RazorpayFailedResponse) => void,
  ) => void;
  open: () => void;
}

declare global {
  interface Window {
    Razorpay: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

interface RazorpayCheckoutProps {
  checkoutData: CheckoutInput;
  onPaymentSuccess: (
    response: RazorpayPaymentResponse | { message: string },
  ) => void;
  onPaymentError: (error: RazorpayPaymentError) => void;
  disabled?: boolean;
  userName?: string;
  userEmail?: string;
  userPhone?: string;
  description?: string;
  /**
   * Ran on the click, before anything is charged; returning false aborts.
   *
   * A page gating a finite resource — event seats — can only re-check it here.
   * `disabled` reflects the last render, and a webinar can fill while the tab
   * sits open, so without this the buyer pays into a rejection.
   */
  onBeforeCheckout?: () => Promise<boolean>;
}

export default function RazorpayCheckout({
  checkoutData,
  onPaymentSuccess,
  onPaymentError,
  disabled,
  userName,
  userEmail,
  userPhone,
  description,
  onBeforeCheckout,
}: RazorpayCheckoutProps) {
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
    // While the gateway sheet is up it owns the button; only its own exits
    // (dismiss, failure, verified success) may re-enable it.
    let gatewayOpened = false;
    try {
      // B5 — a structured BUSY 409 (event mutex held / same account on
      // another device) auto-retries ONCE after the server-advised pause
      // instead of dead-ending; the stable idempotency key keeps the retry
      // dedupe-safe.
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

      if (!response.ok) {
        const errorData = await response.json();
        onPaymentError({
          description: errorData.error || "Payment request failed",
          code: errorData.errorType,
        });
        return;
      }

      const data = await response.json();

      if (!data.success) {
        onPaymentError({
          description: data.error || "Payment initialization failed",
          code: data.errorType,
        });
        return;
      }

      // #1437 — WALLET/INVOICE/LICENSE org funding and zero-amount/mock
      // payments confirm synchronously; the response carries no gateway
      // order, so open() must never run for them.
      if (!checkoutNeedsGateway(data)) {
        onPaymentSuccess({
          message:
            data.message ||
            "Your booking is confirmed. Redirecting to your dashboard...",
        });
        return;
      }

      if (!process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID) {
        toast({
          title: "Payment System Configuration Error",
          description:
            "The Razorpay payment system is not properly configured on this website. This is a technical issue on our end. Please contact support for assistance, or try a different payment method.",
          variant: "destructive",
        });
        return;
      }

      // #1396 — the hold already exists server-side; a CDN failure here is
      // the same state a buyer produces by closing the modal, so leave it
      // to the abandoned-payments sweep instead of cancelling client-side.
      // #1414 — loadScript REJECTS on script.onerror, so `!isLoaded` alone
      // never saw a blocked or failed CDN load; it fell through to the outer
      // catch and the buyer got the generic message instead of this one.
      let isLoaded = false;
      try {
        isLoaded = await loadScript(
          "https://checkout.razorpay.com/v1/checkout.js",
        );
      } catch (scriptError) {
        reportPaymentsError(scriptError);
      }

      if (!isLoaded) {
        toast({
          title: "Payment System Not Loading",
          description:
            "The Razorpay payment system couldn't load. This may be due to a slow connection or ad blocker. Please check your internet connection, disable any ad blockers, and try again.",
          variant: "destructive",
        });
        return;
      }

      const options = {
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        amount: data.paymentIntent.amount,
        currency: data.paymentIntent.currency,
        name: "Familiarise",
        description: description || "Service Payment",
        order_id: data.paymentIntent.id,
        handler: async function (response: RazorpayPaymentResponse) {
          // H2 FIX: Verify Razorpay signature server-side before signaling success
          try {
            const verifyRes = await fetch("/api/checkout/verify-signature", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
              }),
            });
            if (!verifyRes.ok) {
              const err = await verifyRes.json();
              console.error("Payment signature verification failed:", err);
              setIsProcessing(false);
              onPaymentError({
                description:
                  "Payment verification failed. Our team will review this transaction.",
                code: "VERIFICATION_FAILED",
              });
              return;
            }
          } catch (verifyErr) {
            // Network failure — don't block; webhook is the ultimate authority
            Sentry.captureException(
              verifyErr instanceof Error
                ? verifyErr
                : new Error(String(verifyErr)),
              { tags: { subsystem: "payments" } },
            );
            console.error("Signature verification request failed:", verifyErr);
          }
          onPaymentSuccess(response);
        },
        ...(userName || userEmail || userPhone
          ? {
              prefill: {
                ...(userName && { name: userName }),
                ...(userEmail && { email: userEmail }),
                ...(userPhone && { contact: userPhone }),
              },
            }
          : {}),
        theme: {
          color: "#2563EB", // Familiarise brand blue
        },
        modal: {
          ondismiss: () => {
            setIsProcessing(false);
            toast({
              title: "Payment not completed",
              description:
                "You closed the payment window before finishing. Your booking is still held — you can retry whenever you're ready.",
            });
          },
        },
      };

      const rzp = new window.Razorpay(options);
      rzp.on("payment.failed", function (response: RazorpayFailedResponse) {
        setIsProcessing(false);
        onPaymentError(response.error);
      });
      rzp.open();
      gatewayOpened = true;
    } catch (error) {
      reportPaymentsError(error);
      onPaymentError({
        description:
          error instanceof Error
            ? error.message
            : "An unexpected error occurred",
      });
    } finally {
      if (!gatewayOpened) setIsProcessing(false);
    }
  };

  return (
    <Button onClick={handleCheckout} disabled={isProcessing || disabled}>
      {isProcessing ? "Processing..." : "Pay with Razorpay"}
    </Button>
  );
}
