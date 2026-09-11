/**
 * POST /api/checkout/verify-signature
 *
 * H2 FIX: Server-side verification of Razorpay payment signature.
 * Verifies HMAC-SHA256(order_id|payment_id, RAZORPAY_SECRET) returned by
 * the Razorpay checkout modal, providing defense-in-depth alongside webhooks
 * and enabling instant UI feedback without waiting for the webhook.
 *
 * ADR 21 — this route drives the CANONICAL confirmation pipeline; it does not
 * write payment status itself.
 *
 * It used to flip `Payment.paymentStatus` PENDING -> SUCCEEDED with a bare
 * `updateMany` and nothing else. That created a second writer for payment
 * truth, and the client's return from the Razorpay modal normally beats the
 * webhook. When it won, the later `payment.captured` webhook hit the
 * already-SUCCEEDED early-return in `handlePaymentSuccess` and skipped the
 * entire pipeline: no appointment confirmation, no `ConsultantEarnings`, no
 * `booking:<paymentId>` ledger transaction, no GST accrual, and no
 * capture-amount parity check (which sits below that early-return). The money
 * was taken and never journalled.
 *
 * So the route now calls the same `routeCapturedPayment` the webhook calls,
 * and calls it from `after()` for the same reason the webhook does — the
 * pipeline's Phase 2 does outbound work (email, Stream channels) that must not
 * sit inside a request under Netlify's ~10s function ceiling. Every handler
 * beneath it is Serializable and idempotent, so whichever of the two arrives
 * first does the work and the other is a no-op — the race is safe in both
 * directions.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse, after } from "next/server";
import crypto from "crypto";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { getRazorpayClient } from "@/lib/payments/core/razorpay";
import { routeCapturedPayment } from "@/app/api/webhooks/razorpay-dispatch";
import { checkoutLimiter, applyRateLimit } from "@/lib/rate-limit";
import { recordSystemEvent } from "@/lib/enterprise/system-events";
import { z } from "zod";

const verifySignatureSchema = z.object({
  razorpay_order_id: z.string().startsWith("order_"),
  razorpay_payment_id: z.string().startsWith("pay_"),
  razorpay_signature: z
    .string()
    .length(64)
    .regex(/^[0-9a-fA-F]+$/),
});

export async function POST(req: NextRequest) {
  try {
    const razorpayClient = getRazorpayClient();
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // #1353 — the same 5/min budget `/api/checkout` applies, for the same
    // reason: this route makes an outbound `payments.fetch` per call and then
    // drives the whole confirmation pipeline, so an unbounded client loop here
    // is both a gateway-quota drain and a way to hammer the money path. It was
    // the one confirmation entry point with no limit at all.
    const rl = await applyRateLimit(checkoutLimiter, session.user.id);
    if (rl) return rl;

    const body = await req.json();
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      verifySignatureSchema.parse(body);

    const keySecret = process.env.RAZORPAY_SECRET;
    if (!keySecret) {
      console.error(
        "RAZORPAY_SECRET not configured for signature verification",
      );
      return NextResponse.json(
        { error: "Payment verification unavailable" },
        { status: 500 },
      );
    }

    // Verify: HMAC-SHA256(order_id + "|" + payment_id, key_secret)
    const expectedSignature = crypto
      .createHmac("sha256", keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    const sigBuf = Buffer.from(razorpay_signature, "hex");
    const expectedBuf = Buffer.from(expectedSignature, "hex");

    if (
      sigBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(sigBuf, expectedBuf)
    ) {
      return NextResponse.json(
        { verified: false, error: "Invalid payment signature" },
        { status: 400 },
      );
    }

    // Signature valid — find the payment and verify ownership
    const payment = await prisma.payment.findUnique({
      where: { paymentIntent: razorpay_order_id },
    });

    if (!payment) {
      return NextResponse.json(
        { verified: false, error: "Payment not found" },
        { status: 404 },
      );
    }

    if (payment.userId !== session.user.id) {
      return NextResponse.json(
        { verified: false, error: "Unauthorized" },
        { status: 403 },
      );
    }

    // Already confirmed by the webhook (or by an earlier call). Nothing to do —
    // report the current truth rather than re-driving.
    if (payment.paymentStatus === "SUCCEEDED") {
      return NextResponse.json({
        verified: true,
        paymentStatus: "SUCCEEDED",
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
      });
    }

    // The gateway is the authority on what was actually captured and on the
    // `notes` that select the handler. The signature only proves the pair
    // (order_id, payment_id) came from Razorpay; it carries neither amount nor
    // notes, and both are needed to run the same pipeline the webhook runs.
    let notes: Record<string, string> = {};
    let capturedAmountPaise: number | undefined;
    try {
      if (!razorpayClient) throw new Error("RAZORPAY_NOT_INITIALIZED");
      const gatewayPayment =
        await razorpayClient.payments.fetch(razorpay_payment_id);
      // Razorpay types `notes` as a string|number map; the handlers all read
      // string values, so normalize rather than cast.
      notes = Object.fromEntries(
        Object.entries(gatewayPayment.notes ?? {}).map(([k, v]) => [
          k,
          String(v),
        ]),
      );
      capturedAmountPaise = Number(gatewayPayment.amount);

      // The signature proves the id pair came from Razorpay. It says nothing
      // about capture state, and this route is the ONLY confirmation path that
      // can observe an uncaptured payment — `payment.captured` fires on capture
      // by definition.
      //
      // With a non-zero auto-capture delay configured on the account, the modal
      // handler fires while the payment is still `authorized`. Running the
      // pipeline on that would confirm the booking, create earnings, and post a
      // CASH debit for money we have not received; Razorpay then voids the
      // authorization a few days later and the journal is simply wrong.
      if (gatewayPayment.status !== "captured") {
        console.warn(
          `verify-signature: ${razorpay_payment_id} is "${gatewayPayment.status}", not captured — deferring to the webhook`,
        );
        return NextResponse.json({
          verified: true,
          paymentStatus: payment.paymentStatus,
          pendingConfirmation: true,
          orderId: razorpay_order_id,
          paymentId: razorpay_payment_id,
        });
      }
    } catch (fetchError) {
      // Do NOT fall back to confirming without gateway truth: that is exactly
      // the bare-flip behaviour this route is fixing. The webhook remains the
      // durable path and the stuck-event sweeper backstops it, so report
      // "still processing" and let the client poll.
      Sentry.captureException(
        fetchError instanceof Error
          ? fetchError
          : new Error(String(fetchError)),
        {
          tags: { subsystem: "payments" },
          contexts: {
            payment: { paymentId: payment.id, orderId: razorpay_order_id },
          },
        },
      );
      console.error(
        `verify-signature: gateway fetch failed for ${razorpay_payment_id}; deferring to webhook`,
        fetchError,
      );
      return NextResponse.json({
        verified: true,
        paymentStatus: payment.paymentStatus,
        pendingConfirmation: true,
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
      });
    }

    // Same entry point the `payment.captured` webhook uses — and, like that
    // route, driven AFTER the response rather than awaited.
    //
    // The pipeline's Phase 2 sends the success email, creates earnings,
    // processes referrals and provisions Stream chat channels, all outbound
    // work. Awaiting it here put that whole sequence inside a request under
    // Netlify's ~10 second function ceiling (the same ceiling lib/prisma.ts
    // tunes its connect budget around), where a timeout after Phase 1 commits
    // would leave a confirmed booking with no email and no chat channel and
    // nothing to re-drive them. The webhook route has always avoided that by
    // ACKing first and working in `after()`; matching it means the client path
    // has the same failure profile as the path it mirrors, rather than a worse
    // one.
    //
    // Handlers are idempotent and Serializable, so a concurrent webhook either
    // loses the SSI race and retries into a no-op or wins and makes this one.
    after(async () => {
      // #1353 3.3 — the audit trail has to distinguish a capture the CLIENT
      // confirmed from one the WEBHOOK confirmed. Both run the identical
      // pipeline, so afterwards the Payment row looks the same either way, and
      // when the two disagree — a confirmation with no matching webhook, or one
      // that arrived impossibly fast — there was no record of which door the
      // money came through.
      //
      // Inside `after()` and awaited, not floated next to the response: a
      // detached promise on Netlify races the freeze that follows the response,
      // so the very confirmations worth auditing — the slow ones — were the
      // ones whose row could be dropped. `after()` holds the invocation open,
      // and the `.catch` keeps this best-effort, so awaiting costs one insert
      // of post-response latency and can never fail a confirmation.
      await recordSystemEvent({
        category: "PAYMENT",
        message: "client-side payment confirmation",
        correlationId: razorpay_order_id,
        context: {
          paymentId: payment.id,
          gatewayPaymentId: razorpay_payment_id,
        },
      }).catch(() => {});

      try {
        await routeCapturedPayment({
          orderId: razorpay_order_id,
          notes,
          amountPaise: capturedAmountPaise,
          gatewayPaymentId: razorpay_payment_id,
        });
      } catch (err) {
        // Mirrors the webhook's posture: report and let the durable paths
        // recover. The `payment.captured` redelivery and the stuck-event
        // sweeper both still own this payment.
        Sentry.captureException(
          err instanceof Error ? err : new Error(String(err)),
          {
            tags: { subsystem: "payments" },
            contexts: {
              payment: { paymentId: payment.id, orderId: razorpay_order_id },
            },
          },
        );
        console.error(
          `verify-signature: pipeline failed for ${razorpay_order_id}`,
          err,
        );
      }
    });

    // The work is now in flight rather than done, so this is always "pending"
    // — `checkout-success` polls `/api/checkout/verify` until the appointment
    // appears and renders "confirming your booking" meanwhile (#E1).
    return NextResponse.json({
      verified: true,
      paymentStatus: payment.paymentStatus,
      pendingConfirmation: true,
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { verified: false, error: "Invalid request", details: error.errors },
        { status: 400 },
      );
    }

    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "checkout" } },
    );
    console.error("Signature verification error:", error);
    return NextResponse.json(
      { verified: false, error: "Verification failed" },
      { status: 500 },
    );
  }
}
