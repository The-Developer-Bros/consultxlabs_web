"use client";

import { useState } from "react";
import { loadScript } from "@/app/checkout/plans/utils";

/**
 * Minimal replay-purchase checkout (#366). Mints the order via
 * /api/recordings/[id]/purchase, then opens Razorpay Checkout with that
 * order_id. Entitlement settles server-side from the capture webhook — the
 * success handler here only refreshes UI.
 */

interface BuyButtonProps {
  recordingId: string;
  listPricePaise: number;
  formattedPrice: string;
}

export function RecordingBuyButton({
  recordingId,
  listPricePaise,
  formattedPrice,
}: Readonly<BuyButtonProps>) {
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleBuy() {
    setStatus("loading");
    setMessage(null);
    try {
      const res = await fetch(
        `/api/recordings/${recordingId}/purchase`,
        { method: "POST" },
      );
      const body = await res.json();
      if (!res.ok) {
        setMessage(body.error ?? "Could not start checkout");
        setStatus("error");
        return;
      }

      const ok = await loadScript("https://checkout.razorpay.com/v1/checkout.js");
      if (!ok || !window.Razorpay || !process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID) {
        setMessage("Payment gateway unavailable. Please retry shortly.");
        setStatus("error");
        return;
      }

      const rzp = new window.Razorpay({
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        amount: listPricePaise,
        currency: body.data.currency,
        name: "Familiarise Recordings",
        description: body.data.description ?? "Recording purchase",
        order_id: body.data.orderId,
        prefill: {},
        theme: { color: "#6366f1" },
        modal: {
          ondismiss: () => {
            setStatus("idle");
            setMessage("Checkout closed — nothing was charged.");
          },
        },
        handler: () => {
          // Entitlement is written by the capture webhook, which may land a
          // beat after this client callback — don't promise instant access.
          setStatus("idle");
          setMessage(
            "Payment successful! Your recording will appear in your dashboard library within a few minutes.",
          );
        },
      });
      rzp.open();
    } catch {
      setMessage("Something went wrong. Please try again.");
      setStatus("error");
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleBuy}
        disabled={status === "loading"}
        className="w-full rounded-lg bg-primary px-6 py-3 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
      >
        {status === "loading" ? "Opening checkout…" : `Buy for ${formattedPrice}`}
      </button>
      {message && (
        <p
          className={`text-sm ${status === "error" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
