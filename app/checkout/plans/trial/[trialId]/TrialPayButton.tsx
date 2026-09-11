"use client";

import { CreditCard } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Hands off to the gateway pay-link minted when the consultant accepted.
 *
 * A client component only because it opens a new tab; there is no order
 * creation here. When this page eventually replaces the hosted pay-link, this
 * is where the Razorpay/Stripe checkout component would mount instead.
 */
export function TrialPayButton({ paymentUrl }: { paymentUrl: string }) {
  return (
    <Button
      className="w-full"
      size="lg"
      onClick={() => {
        // Guard the scheme — pendingPaymentUrl is gateway-supplied, and an
        // unchecked value here would be an open-redirect / javascript: sink.
        if (/^https?:\/\//.test(paymentUrl)) {
          window.open(paymentUrl, "_blank", "noopener,noreferrer");
        }
      }}
    >
      <CreditCard className="mr-2 h-4 w-4" />
      Pay to confirm
    </Button>
  );
}
