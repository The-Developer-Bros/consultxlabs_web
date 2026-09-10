/**
 * Payment Status Reconciliation - Core Logic
 *
 * Reconciles payment status with payment gateways (Stripe/Razorpay).
 * Finds PENDING payments and queries gateways for actual status.
 *
 * This catches cases where:
 * - Payment webhook was missed or delayed
 * - DB update failed after gateway processed payment
 * - Network timeout during payment confirmation
 *
 * This module exports the core reconciliation function.
 * It is imported by:
 * - jobs/reconcile-payment-status.ts (GitHub Actions)
 * - app/api/cleanup/reconcile-payment-status/route.ts (API endpoint)
 *
 * Schedule: Every 30 minutes
 */

import prisma from "../../lib/prisma";
import { PaymentStatus, PaymentGateway } from "@prisma/client";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import { routeCapturedPayment } from "@/app/api/webhooks/razorpay-dispatch";

// Only reconcile payments older than 5 minutes (give webhooks time)
const MIN_AGE_MINUTES = 5;

// Don't reconcile payments older than 7 days
const MAX_AGE_DAYS = 7;

export interface PaymentReconciliationResult {
  success: boolean;
  totalProcessed: number;
  reconciledCount: number;
  succeededCount: number;
  failedCount: number;
  expiredCount: number;
  skippedCount: number;
  errors: string[];
  timestamp: string;
}

export interface ReconcilePaymentStatusOptions {
  /** #1356 — caps the batch for the Netlify ticker; undefined keeps the
   * unbounded GitHub Actions behaviour. */
  limit?: number;
}

/**
 * Query Stripe for payment intent status
 */
async function getStripePaymentStatus(
  paymentIntent: string,
): Promise<{ status: string; failureMessage?: string } | null> {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    console.warn("Stripe credentials not configured");
    return null;
  }

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeSecretKey);

    // Checkout-flow payments store the cs_ session id as the payment ref
    // (the cancel path in lib/payments/core/stripe.ts handles the same
    // split). Passing a cs_ id to paymentIntents.retrieve throws "No such
    // payment_intent", which used to poison every run with the same two
    // stale rows. Resolve the session to its intent; a session that never
    // produced one maps on its own state — expired → canceled (the row
    // finally EXPIREs), open → processing (Stripe auto-expires within 24h,
    // the next sweep settles it).
    if (paymentIntent.startsWith("cs_")) {
      const session = await stripe.checkout.sessions.retrieve(paymentIntent);
      const intentRef = session.payment_intent;
      if (!intentRef) {
        return {
          status: session.status === "expired" ? "canceled" : "processing",
        };
      }
      const pi =
        typeof intentRef === "string"
          ? await stripe.paymentIntents.retrieve(intentRef)
          : intentRef;
      return {
        status: pi.status,
        failureMessage: pi.last_payment_error?.message ?? undefined,
      };
    }

    const pi = await stripe.paymentIntents.retrieve(paymentIntent);
    return {
      status: pi.status,
      failureMessage: pi.last_payment_error?.message,
    };
  } catch (error) {
    console.error(`Failed to get Stripe payment status: ${error}`);
    return null;
  }
}

/**
 * Query Razorpay for order/payment status
 */
async function getRazorpayPaymentStatus(orderId: string): Promise<{
  status: string;
  paymentId?: string;
  /** `notes` off the captured payment — selects the handler in routeCapturedPayment. */
  notes?: Record<string, string>;
  /** Captured amount in paise, for the parity check. */
  amountPaise?: number;
} | null> {
  const keyId = process.env.RAZORPAY_KEY_ID;
  // #677 PM-1 — prod env defines RAZORPAY_SECRET (the canonical name the
  // core lib reads); reading only RAZORPAY_KEY_SECRET silently disabled
  // this reconciliation in production while it looked green.
  const keySecret =
    process.env.RAZORPAY_SECRET ?? process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    console.warn("Razorpay credentials not configured");
    return null;
  }

  try {
    // First get the order
    const orderResponse = await fetch(
      `https://api.razorpay.com/v1/orders/${orderId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
        },
      },
    );

    if (!orderResponse.ok) {
      console.error(`Razorpay order API error: ${orderResponse.status}`);
      return null;
    }

    const order = await orderResponse.json();

    // If order is paid, get the payment details
    if (order.status === "paid") {
      const paymentsResponse = await fetch(
        `https://api.razorpay.com/v1/orders/${orderId}/payments`,
        {
          method: "GET",
          headers: {
            Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
          },
        },
      );

      if (paymentsResponse.ok) {
        const payments = await paymentsResponse.json();
        const capturedPayment = payments.items?.find(
          (p: { status: string }) => p.status === "captured",
        );
        if (capturedPayment) {
          return {
            status: "captured",
            paymentId: capturedPayment.id,
            notes: Object.fromEntries(
              Object.entries(capturedPayment.notes ?? {}).map(([k, v]) => [
                k,
                String(v),
              ]),
            ),
            amountPaise: Number(capturedPayment.amount),
          };
        }
      }
    }

    return { status: order.status };
  } catch (error) {
    console.error(`Failed to get Razorpay payment status: ${error}`);
    return null;
  }
}

/**
 * Map gateway payment status to our PaymentStatus
 */
function mapGatewayStatus(
  gateway: PaymentGateway,
  status: string,
): PaymentStatus | null {
  if (gateway === PaymentGateway.STRIPE) {
    switch (status) {
      case "succeeded":
        return PaymentStatus.SUCCEEDED;
      case "processing":
        return PaymentStatus.PENDING;
      case "requires_payment_method":
        return PaymentStatus.FAILED;
      case "requires_confirmation":
        return PaymentStatus.PENDING;
      case "requires_action":
        return PaymentStatus.PENDING;
      case "canceled":
        return PaymentStatus.EXPIRED;
      default:
        return null;
    }
  } else if (gateway === PaymentGateway.RAZORPAY) {
    switch (status) {
      case "paid":
      case "captured":
        return PaymentStatus.SUCCEEDED;
      case "created":
      case "attempted":
        return PaymentStatus.PENDING;
      case "expired":
        return PaymentStatus.EXPIRED;
      case "failed":
        return PaymentStatus.FAILED;
      default:
        return null;
    }
  }

  return null;
}

/**
 * Find and reconcile stale PENDING payments
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function reconcilePaymentStatus(
  opts: ReconcilePaymentStatusOptions = {},
): Promise<PaymentReconciliationResult> {
  return withCronLock(
    "reconcile-payment-status",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => reconcilePaymentStatusUnlocked(opts),
  );
}

async function reconcilePaymentStatusUnlocked(
  opts: ReconcilePaymentStatusOptions = {},
): Promise<PaymentReconciliationResult> {
  const errors: string[] = [];
  let reconciledCount = 0;
  let succeededCount = 0;
  let failedCount = 0;
  let expiredCount = 0;
  let skippedCount = 0;

  const minAge = new Date(Date.now() - MIN_AGE_MINUTES * 60 * 1000);
  const maxAge = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

  // Find stale PENDING payments
  const stalePendingPayments = await prisma.payment.findMany({
    where: {
      paymentStatus: PaymentStatus.PENDING,
      createdAt: {
        lt: minAge,
        gte: maxAge,
      },
      // Only payments with gateway reference - not an empty string
      NOT: {
        paymentIntent: "",
      },
    },
    include: {
      user: { select: { email: true, name: true } },
      appointment: { select: { id: true } },
    },
    orderBy: { createdAt: "asc" },
    take: opts.limit,
  });

  const razorpayConfigured = !!(
    process.env.RAZORPAY_KEY_ID &&
    (process.env.RAZORPAY_SECRET ?? process.env.RAZORPAY_KEY_SECRET)
  );
  if (!razorpayConfigured) {
    console.warn(
      "⚠️ Razorpay credentials not configured — Razorpay records will be skipped",
    );
  }

  console.log(
    `Found ${stalePendingPayments.length} stale PENDING payments to reconcile`,
  );

  for (const payment of stalePendingPayments) {
    console.log(`\nReconciling payment ${payment.id}`);
    console.log(`   Gateway: ${payment.paymentGateway}`);
    console.log(`   Payment Intent: ${payment.paymentIntent}`);
    console.log(`   User: ${payment.user?.name || "Unknown"}`);
    console.log(`   Created: ${payment.createdAt.toISOString()}`);

    // Skip if no payment intent
    if (!payment.paymentIntent) {
      console.log(`   Skipping - no payment intent`);
      skippedCount++;
      continue;
    }

    // Query gateway for actual status
    let gatewayStatus: {
      status: string;
      failureMessage?: string;
      paymentId?: string;
      // Razorpay only — carried so a SUCCEEDED reconcile can drive the
      // confirmation pipeline instead of writing the status (ADR 21).
      notes?: Record<string, string>;
      amountPaise?: number;
    } | null = null;

    if (payment.paymentGateway === PaymentGateway.STRIPE) {
      gatewayStatus = await getStripePaymentStatus(payment.paymentIntent);
    } else if (payment.paymentGateway === PaymentGateway.RAZORPAY) {
      if (!razorpayConfigured) {
        console.log(`   Skipping - Razorpay credentials not configured`);
        skippedCount++;
        continue;
      }
      // For Razorpay, paymentIntent might be orderId
      gatewayStatus = await getRazorpayPaymentStatus(payment.paymentIntent);
    } else {
      console.log(
        `   Skipping - unsupported gateway: ${payment.paymentGateway}`,
      );
      skippedCount++;
      continue;
    }

    if (!gatewayStatus) {
      console.log(`   Could not get status from gateway - skipping`);
      errors.push(`Payment ${payment.id}: Could not query gateway status`);
      skippedCount++;
      continue;
    }

    console.log(`   Gateway status: ${gatewayStatus.status}`);

    // Map gateway status to our status
    const mappedStatus = mapGatewayStatus(
      payment.paymentGateway,
      gatewayStatus.status,
    );

    if (!mappedStatus) {
      console.log(`   Unknown gateway status - skipping`);
      skippedCount++;
      continue;
    }

    // Update if status changed
    if (mappedStatus !== payment.paymentStatus) {
      // ADR 21 — a payment that reconciles to SUCCEEDED must go through the
      // confirmation pipeline, not a status write.
      //
      // This job exists precisely because a `payment.captured` was missed, so
      // it is the LEAST safe place to write the status directly: setting
      // SUCCEEDED here poisons handlePaymentSuccess's already-SUCCEEDED guard,
      // and Razorpay's redelivery (it retries for 24h) then no-ops. The legacy
      // appointment-creation path and all three auto-refund guards
      // (amount-mismatch, captured-after-terminal, double-booking-loser) are
      // skipped permanently — and none of those are covered by another cron.
      // The old code even logged "may need manual appointment creation!"
      // instead of just creating it.
      // Razorpay only: routeCapturedPayment is the Razorpay dispatch's router,
      // and Stripe successes are confirmed by their own webhook handler. A
      // Stripe row still takes the CAS below, which is the pre-existing
      // behaviour for that gateway.
      if (
        mappedStatus === PaymentStatus.SUCCEEDED &&
        payment.paymentGateway === PaymentGateway.RAZORPAY
      ) {
        try {
          await routeCapturedPayment({
            orderId: payment.paymentIntent,
            notes: gatewayStatus.notes ?? {},
            amountPaise: gatewayStatus.amountPaise,
            gatewayPaymentId: gatewayStatus.paymentId,
          });
          console.log(`   Confirmed via pipeline: ${payment.id}`);
          reconciledCount++;
          succeededCount++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`   Pipeline failed for ${payment.id}: ${msg}`);
          errors.push(`Payment ${payment.id}: ${msg}`);
        }
        continue;
      }

      // #776 — guard on the status we read. A webhook can transition this
      // payment (e.g. PENDING→SUCCEEDED) between the findMany and here; without
      // the predicate the reconcile would clobber that real transition back to
      // EXPIRED/FAILED. updateMany lets us add the guard; count===0 means another
      // writer already moved it — skip rather than overwrite.
      const claimed = await prisma.payment.updateMany({
        where: { id: payment.id, paymentStatus: payment.paymentStatus },
        data: {
          paymentStatus: mappedStatus,
        },
      });

      if (claimed.count === 0) {
        console.log(
          `   Skipped: payment ${payment.id} already transitioned by another writer`,
        );
        skippedCount++;
        continue;
      }

      console.log(
        `   Updated status: ${payment.paymentStatus} → ${mappedStatus}`,
      );
      reconciledCount++;

      if (mappedStatus === PaymentStatus.EXPIRED) {
        expiredCount++;
      } else if (mappedStatus === PaymentStatus.FAILED) {
        failedCount++;
      }
    } else {
      console.log(`   Status unchanged (${mappedStatus})`);
    }
  }

  // Summary
  console.log("\n📊 Payment Reconciliation Summary:");
  console.log(`   Total processed: ${stalePendingPayments.length}`);
  console.log(`   Reconciled: ${reconciledCount}`);
  console.log(`   Succeeded (needs review): ${succeededCount}`);
  console.log(`   Failed: ${failedCount}`);
  console.log(`   Expired: ${expiredCount}`);
  console.log(`   Skipped: ${skippedCount}`);

  if (succeededCount > 0) {
    console.log(
      `\n⚠️ WARNING: ${succeededCount} payments were found to have succeeded!`,
    );
    console.log("   These may need manual appointment creation.");
  }

  return {
    success: errors.length === 0,
    totalProcessed: stalePendingPayments.length,
    reconciledCount,
    succeededCount,
    failedCount,
    expiredCount,
    skippedCount,
    errors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
