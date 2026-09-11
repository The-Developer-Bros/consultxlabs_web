"use client";

import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { z } from "zod";

import { loadScript } from "@/app/checkout/plans/utils";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const chargeSchema = z.object({
  id: z.string(),
  amountPaise: z.number(),
  currency: z.string(),
  status: z.enum(["PENDING", "FAILED"]),
  programName: z.string(),
  orgName: z.string(),
  createdAt: z.string(),
});
const chargesResponseSchema = z.object({ charges: z.array(chargeSchema) });
type Charge = z.infer<typeof chargeSchema>;

const orderResponseSchema = z.object({
  orderId: z.string(),
  amount: z.number(),
  currency: z.string(),
  keyId: z.string().nullable(),
});

// Settlement is webhook-driven (Payment → SUCCEEDED, OverageEvent → CHARGED),
// so the charge only drops out of this list once the webhook lands. Poll a few
// times to reflect it without a manual refresh — mirrors WalletTab's shape.
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 5;

async function fetchCharges(): Promise<Charge[]> {
  const res = await fetch("/api/overage");
  if (!res.ok) throw new Error("Failed to load overage charges");
  return chargesResponseSchema.parse(await res.json()).charges;
}

async function createOrder(id: string) {
  const res = await fetch(`/api/overage/${id}/order`, { method: "POST" });
  const raw = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      (raw && typeof raw.error === "string" && raw.error) ||
        "Failed to start payment",
    );
  }
  return orderResponseSchema.parse(raw);
}

function formatAmount(amountPaise: number, currency: string): string {
  if (currency === "INR") return `₹${(amountPaise / 100).toFixed(2)}`;
  return `${currency} ${(amountPaise / 100).toFixed(2)}`;
}

export default function OveragePage() {
  const searchParams = useSearchParams();
  const highlightId = searchParams.get("charge");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const highlightRef = useRef<HTMLDivElement | null>(null);

  const {
    data: charges,
    isLoading,
    isFetching,
    dataUpdatedAt,
  } = useQuery({
    queryKey: ["member-overages"],
    queryFn: fetchCharges,
  });

  // Novu deep-link nicety: scroll the targeted charge into view once loaded.
  useEffect(() => {
    if (highlightId && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlightId, charges]);

  const payMutation = useMutation({
    mutationFn: async (id: string): Promise<boolean> => {
      const order = await createOrder(id);

      const loaded = await loadScript(
        "https://checkout.razorpay.com/v1/checkout.js",
      ).catch(() => false);
      if (!loaded || !window.Razorpay) {
        throw new Error(
          "Razorpay checkout failed to load. Please disable ad-blockers and retry.",
        );
      }

      return new Promise<boolean>((resolve) => {
        const rzp = new window.Razorpay({
          // keyId can be null when RAZORPAY_KEY_ID is unset; Razorpay's type
          // wants string | undefined, so coerce.
          key: order.keyId ?? undefined,
          amount: order.amount,
          currency: order.currency,
          order_id: order.orderId,
          name: "Familiarise",
          description: "Program overage charge",
          handler: () => {
            resolve(true);
          },
          theme: { color: "#2563EB" },
        });
        rzp.on("payment.failed", () => {
          toast({
            title: "Payment failed",
            description:
              "Your card was declined or the payment timed out. Please try again.",
            variant: "destructive",
          });
          resolve(false);
        });
        rzp.open();
      });
    },
    onSuccess: async (paid) => {
      if (!paid) return;
      toast({
        title: "Payment received — confirming…",
        description:
          "Your charge will clear automatically once Razorpay confirms it.",
      });
      // Poll until the webhook flips it to CHARGED and it falls off the list.
      for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        await queryClient.invalidateQueries({ queryKey: ["member-overages"] });
      }
    },
    onError: (err) => {
      toast({
        title: "Could not start payment",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const payingId = payMutation.isPending ? payMutation.variables : null;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      {/* This route deliberately renders outside any dashboard shell — it's a
          focused settlement task, like /checkout, and the notification deep
          link (`/dashboard/overage?charge=<id>`) carries no org context to
          route into an org dashboard with. Without a way out, though, anyone
          arriving from that notification was stranded on a chrome-less page.
          /dashboard re-routes each role to their own home. */}
      <Link
        href="/dashboard"
        className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to dashboard
      </Link>

      <h1 className="text-xl font-semibold text-zinc-900 mb-1">
        Outstanding charges
      </h1>
      <p className="text-sm text-zinc-500 mb-2">
        Program bookings that exceeded their sponsor&apos;s cap. Settle them to
        keep your access active.
      </p>

      {/* #777 §F — settlement is webhook-driven and we poll after pay; surface
          a freshness affordance so a charge clearing isn't mistaken for a stale
          list. `dataUpdatedAt` bumps on every successful (re)fetch. */}
      {!isLoading && dataUpdatedAt > 0 && (
        <p className="text-xs text-zinc-400 mb-6" aria-live="polite">
          {isFetching
            ? "Checking for settlement…"
            : `Last updated ${new Date(dataUpdatedAt).toLocaleTimeString("en-IN")}`}
        </p>
      )}

      {isLoading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : !charges || charges.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-zinc-500">
            You have no outstanding overage charges.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {charges.map((charge) => (
            <Card
              key={charge.id}
              ref={charge.id === highlightId ? highlightRef : undefined}
              className={
                charge.id === highlightId ? "ring-2 ring-blue-500" : undefined
              }
            >
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base">
                    {charge.programName}
                  </CardTitle>
                  {charge.status === "FAILED" && (
                    <Badge variant="destructive">Failed</Badge>
                  )}
                </div>
                <CardDescription>{charge.orgName}</CardDescription>
              </CardHeader>
              <CardContent className="flex items-center justify-between">
                <span className="text-lg font-semibold text-zinc-900">
                  {formatAmount(charge.amountPaise, charge.currency)}
                </span>
                <Button
                  onClick={() => payMutation.mutate(charge.id)}
                  disabled={payMutation.isPending}
                >
                  {payingId === charge.id ? "Opening…" : "Pay"}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
