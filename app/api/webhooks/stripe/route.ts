import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  handlePaymentFailure,
  handlePaymentSuccess,
  handleRefundCreated,
  handleDisputeCreated,
  handleDisputeUpdated,
  verifyWebhookSignature,
  logWebhookEvent,
  markWebhookEventProcessed,
  handleStripePayoutWebhook,
  isDbHealthy,
} from "../utils";
import { scrubWebhookPayload } from "@/lib/logging/webhook-scrub";
import {
  stripeBaseEventSchema,
  stripePaymentIntentSucceededEventSchema,
  stripePaymentIntentFailedEventSchema,
  stripeCheckoutSessionCompletedEventSchema,
  stripeCheckoutSessionExpiredEventSchema,
} from "../../../../schemas/webhooks/stripe";

export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  Sentry.setTag("subsystem", "payments");
  if (!secret) {
    console.error("STRIPE_WEBHOOK_SECRET not configured");
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 },
    );
  }

  const { isValid, body } = await verifyWebhookSignature(req, secret, "stripe");
  if (!isValid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // DB health check — return 503 if DB is unreachable so Stripe retries
  if (!(await isDbHealthy())) {
    Sentry.logger.warn("stripe webhook: db unhealthy, returning 503");
    return NextResponse.json(
      { error: "Service temporarily unavailable" },
      { status: 503 },
    );
  }

  try {
    const event = JSON.parse(body);
    // A validly-signed but structurally-invalid payload is a BAD REQUEST, not
    // a server error: returning 500 makes Stripe burn its full exponential
    // retry schedule on an event that can never succeed and eventually
    // disables the endpoint — the exact failure mode the Razorpay route
    // avoids by reserving non-2xx for transient failures.
    let eventType: string;
    try {
      eventType = stripeBaseEventSchema.parse(event).type;
    } catch (parseError) {
      console.error(
        "Stripe webhook payload failed envelope validation:",
        parseError,
      );
      Sentry.captureException(parseError, {
        tags: { subsystem: "payments", provider: "stripe" },
      });
      return NextResponse.json(
        { error: "Unrecognized webhook payload shape" },
        { status: 400 },
      );
    }

    // Log webhook event for audit trail (idempotency check).
    // Stripe always sends a unique `evt_...` id, but if it's missing we
    // derive a deterministic fallback from the body hash so replays
    // still dedup.
    const eventId =
      event.id ||
      `stripe_body_${crypto.createHash("sha256").update(body).digest("hex").slice(0, 16)}`;

    const { isNew } = await logWebhookEvent(
      "stripe",
      eventId,
      eventType,
      event.data.object,
      req.headers.get("stripe-signature") || undefined,
    );

    if (!isNew) {
      console.log(`⚠️ Duplicate webhook event ${eventId}, returning OK`);
      return NextResponse.json({ status: "ok", duplicate: true });
    }

    Sentry.logger.info(Sentry.logger.fmt`stripe webhook: ${eventType}`, { eventId });

    // PII-scrub the payload before logging — Stripe payloads can carry
    // `receipt_email`, `billing_details.name/email/phone`, and arbitrary
    // `metadata.*` fields set by the application. See
    // lib/logging/webhook-scrub.ts for the redaction rules.
    console.log(`🔔 Stripe Webhook Event: ${eventType}`, {
      eventId,
      payload: scrubWebhookPayload(event.data.object),
    });

    let processingError: string | undefined;

    try {
      switch (eventType) {
        // FIX CF-3: Checkout Session events — primary handler for Stripe Checkout flow.
        // createStripeCheckoutSession stores session.id (cs_...) in Payment.paymentIntent,
        // so we must handle checkout.session.completed to match by cs_... ID.
        // NOTE: Ensure these events are enabled in the Stripe Dashboard webhook settings.
        case "checkout.session.completed": {
          const sessionEvent =
            stripeCheckoutSessionCompletedEventSchema.parse(event);
          const session = sessionEvent.data.object;
          // Use session.id (cs_...) which matches Payment.paymentIntent
          await handlePaymentSuccess(
            session.id,
            session.metadata || {},
          );
          break;
        }

        case "checkout.session.expired": {
          const sessionEvent =
            stripeCheckoutSessionExpiredEventSchema.parse(event);
          await handlePaymentFailure(sessionEvent.data.object.id);
          break;
        }

        // Payment Intent events — kept for backward compatibility.
        // If a payment was stored with pi_... (legacy flow), this handler catches it.
        // Idempotency: handlePaymentSuccess is a no-op if already SUCCEEDED.
        case "payment_intent.succeeded": {
          const succeededEvent =
            stripePaymentIntentSucceededEventSchema.parse(event);
          await handlePaymentSuccess(
            succeededEvent.data.object.id,
            succeededEvent.data.object.metadata || {},
          );
          break;
        }

        case "payment_intent.payment_failed": {
          const failedEvent = stripePaymentIntentFailedEventSchema.parse(event);
          await handlePaymentFailure(failedEvent.data.object.id);
          break;
        }

        // Refund events
        case "charge.refunded": {
          const refundEvent = event.data.object;
          // Stripe includes the refunds array in the charge object, newest
          // first. Drive EVERY refund in the array, not just data[0]: with
          // two refunds on one charge and delayed/out-of-order delivery,
          // both events resolved data[0] to the newer refund and refund #1
          // never got a row or a cascade. handleRefundCreated is idempotent
          // per gateway refund id (unique + terminal-status guard), so
          // re-processing an already-booked entry is a no-op.
          const refunds = refundEvent.refunds?.data ?? [];
          for (const latestRefund of refunds) {
            await handleRefundCreated(
              latestRefund.id,
              refundEvent.payment_intent || refundEvent.id,
              latestRefund.amount,
              latestRefund.currency.toUpperCase(),
              latestRefund.status,
              "STRIPE",
              // 7th arg — the provider payment id the org-level branches key
              // on (WalletTopUp / OrganizationInvoice.providerPaymentId); only
              // the B2C Payment lookup uses `payment_intent`. `ch_<…>` is the
              // Stripe analogue of the `pay_<…>` razorpay-dispatch passes here.
              // Org billing mints Razorpay orders today, so nothing matches on
              // this rail yet; what it changes now is the not-found case, which
              // stopped silently ACKing (#813/#812 calls that permanent death)
              // and now 5xxs so Stripe re-delivers.
              typeof latestRefund.charge === "string"
                ? latestRefund.charge
                : (latestRefund.charge?.id ?? refundEvent.id),
            );
          }
          break;
        }

        // Dispute events
        case "charge.dispute.created": {
          const disputeCreatedEvent = event.data.object;
          await handleDisputeCreated(
            disputeCreatedEvent.id,
            disputeCreatedEvent.charge,
            disputeCreatedEvent.amount,
            disputeCreatedEvent.currency.toUpperCase(),
            disputeCreatedEvent.reason,
            disputeCreatedEvent.status,
            disputeCreatedEvent.evidence_details?.due_by || null,
            disputeCreatedEvent.is_charge_refundable,
            "STRIPE",
          );
          break;
        }

        case "charge.dispute.updated": {
          const disputeUpdatedEvent = event.data.object;
          await handleDisputeUpdated(
            disputeUpdatedEvent.id,
            disputeUpdatedEvent.status,
            disputeUpdatedEvent.evidence || null,
          );
          break;
        }

        case "charge.dispute.closed": {
          const disputeClosedEvent = event.data.object;
          await handleDisputeUpdated(
            disputeClosedEvent.id,
            disputeClosedEvent.status,
            null,
          );
          break;
        }

        // Stripe Connect Payout/Transfer events.
        //
        // Payouts are India-first via RazorpayX; Stripe Connect payout
        // integration is opt-in. Production environments that haven't
        // onboarded Connect will otherwise receive noisy webhooks (e.g.
        // for the platform's own Stripe balance movements). Gate both
        // the handler and the subsequent `account.updated` /
        // `transfer.*` logs behind ENABLE_STRIPE_PAYOUTS so we can
        // enable the full Connect flow atomically once ready.
        case "payout.created":
        case "payout.paid":
        case "payout.failed":
        case "payout.canceled": {
          if (process.env.ENABLE_STRIPE_PAYOUTS !== "true") {
            console.log(
              `⏭️  Stripe Connect payout event ${eventType} ignored (ENABLE_STRIPE_PAYOUTS!=true)`,
            );
            break;
          }
          const payoutEvent = event.data.object;
          await handleStripePayoutWebhook(eventType, {
            id: payoutEvent.id,
            status: payoutEvent.status,
            failure_code: payoutEvent.failure_code,
            failure_message: payoutEvent.failure_message,
          });
          break;
        }

        // Stripe Connect Account events — only meaningful when Connect
        // payouts are enabled.
        case "account.updated": {
          if (process.env.ENABLE_STRIPE_PAYOUTS !== "true") break;
          const accountEvent = event.data.object;
          console.log(`📄 Stripe Connect account updated: ${accountEvent.id}`, {
            chargesEnabled: accountEvent.charges_enabled,
            payoutsEnabled: accountEvent.payouts_enabled,
            detailsSubmitted: accountEvent.details_submitted,
          });
          break;
        }

        // Transfer events (platform to connected account)
        case "transfer.created":
        case "transfer.reversed": {
          if (process.env.ENABLE_STRIPE_PAYOUTS !== "true") break;
          const transferEvent = event.data.object;
          console.log(`📄 Stripe transfer ${eventType}: ${transferEvent.id}`, {
            amount: transferEvent.amount,
            destination: transferEvent.destination,
            reversed: transferEvent.reversed,
          });
          break;
        }

        default:
          console.log(`📄 Unhandled Stripe event type: ${eventType}`);
      }
    } catch (handlerError) {
      processingError =
        handlerError instanceof Error
          ? handlerError.message
          : String(handlerError);
      Sentry.captureException(handlerError, {
        tags: { subsystem: "payments", provider: "stripe" },
        contexts: { webhook: { eventType, eventId } },
      });
      throw handlerError;
    } finally {
      // Mark event as processed
      await markWebhookEventProcessed(eventId, processingError);
    }

    return NextResponse.json({ status: "ok" });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    Sentry.captureException(error, {
      tags: { subsystem: "payments", provider: "stripe" },
    });
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 },
    );
  }
}
