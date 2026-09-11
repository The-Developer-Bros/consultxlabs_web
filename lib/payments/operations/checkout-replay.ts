import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

// #828 — replay the original checkout response for a duplicate attempt. The
// stored Payment carries enough for the client to reopen the gateway with the
// SAME order instead of minting (and possibly paying) a second one. Scoped to
// the caller's userId so a guessed key can't read someone else's payment.
// Exported for the #828 regression tests; the checkout route is the prod caller.
export async function replayByIdempotencyKey(userId: string, key: string) {
  const existing = await prisma.payment.findFirst({
    where: { clientIdempotencyKey: key, userId },
    select: {
      paymentIntent: true,
      paymentStatus: true,
      paymentGateway: true,
      amount: true,
      currency: true,
      appointmentId: true,
      isMockPayment: true,
    },
  });
  if (!existing) return null;
  if (existing.paymentStatus === "SUCCEEDED") {
    return NextResponse.json({
      success: true,
      reused: true,
      skipPayment: true,
      appointmentId: existing.appointmentId ?? undefined,
      message: "This checkout was already completed.",
    });
  }
  // Stripe stores the hosted checkout URL in client_secret (see
  // StripeCheckout.tsx); we don't persist it, so a Stripe PENDING replay
  // can't be resumed — fall through to the fresh-key 409 below instead of
  // returning a null secret the client can't redirect with.
  if (
    existing.paymentStatus === "PENDING" &&
    existing.paymentGateway !== "STRIPE"
  ) {
    return NextResponse.json({
      success: true,
      reused: true,
      orderId: existing.paymentIntent,
      paymentIntent: { id: existing.paymentIntent, client_secret: null },
      amount: Number(existing.amount),
      currency: existing.currency,
      isMockPayment: existing.isMockPayment,
      message: "Resuming your in-progress checkout.",
    });
  }
  // Terminal (FAILED/CANCELED/...) — this logical attempt is dead; the client
  // must mint a fresh key for a new attempt (the wallet top-up contract).
  return NextResponse.json(
    {
      error:
        "A previous attempt for this checkout already failed. Refresh and try again.",
      errorType: "IDEMPOTENT_REPLAY_TERMINAL",
      timestamp: new Date().toISOString(),
    },
    { status: 409 },
  );
}
