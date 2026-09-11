import { z } from "zod";

// Base event schema to get the type
export const stripeBaseEventSchema = z.object({
  id: z.string(),
  object: z.literal("event"),
  api_version: z.string(),
  created: z.number(),
  type: z.string(), // We'll use this to narrow down the event type
  livemode: z.boolean(),
  pending_webhooks: z.number(),
  request: z
    .object({
      id: z.string().nullable(),
      idempotency_key: z.string().nullable(),
    })
    .nullable(),
  data: z.object({
    object: z.any(),
  }),
});

// Metadata schema
const metadataSchema = z.record(z.string()).nullable();

// Payment Intent schema
const paymentIntentSchema = z.object({
  id: z.string(),
  object: z.literal("payment_intent"),
  amount: z.number(),
  currency: z.string(),
  metadata: metadataSchema,
  status: z.string(),
  last_payment_error: z
    .object({
      code: z.string().nullable(),
      doc_url: z.string().nullable(),
      message: z.string().nullable(),
      param: z.string().nullable(),
      type: z.string(),
    })
    .nullable(),
});

// Payment Intent Succeeded event
export const stripePaymentIntentSucceededEventSchema =
  stripeBaseEventSchema.extend({
    type: z.literal("payment_intent.succeeded"),
    data: z.object({
      object: paymentIntentSchema,
    }),
  });

// Payment Intent Failed event
export const stripePaymentIntentFailedEventSchema =
  stripeBaseEventSchema.extend({
    type: z.literal("payment_intent.payment_failed"),
    data: z.object({
      object: paymentIntentSchema,
    }),
  });

// Invoice Paid event
export const stripeInvoicePaidEventSchema = stripeBaseEventSchema.extend({
  type: z.literal("invoice.payment_succeeded"),
  data: z.object({
    object: z.object({
      id: z.string(),
      object: z.literal("invoice"),
      amount_paid: z.number(),
      customer: z.string(),
      subscription: z.string().nullable(),
    }),
  }),
});

// Subscription Created event
export const stripeSubscriptionCreatedEventSchema =
  stripeBaseEventSchema.extend({
    type: z.literal("customer.subscription.created"),
    data: z.object({
      object: z.object({
        id: z.string(),
        object: z.literal("subscription"),
        customer: z.string(),
        status: z.string(),
        billing_cycle_anchor: z.number(),
        start_date: z.number(),
      }),
    }),
  });

// Checkout Session schema (session.id is the cs_... stored in Payment.paymentIntent)
const checkoutSessionSchema = z.object({
  id: z.string(), // cs_... ID — matches Payment.paymentIntent
  object: z.literal("checkout.session"),
  payment_intent: z.string().nullable(), // pi_... ID — the underlying PaymentIntent
  payment_status: z.string(), // "paid", "unpaid", "no_payment_required"
  status: z.string(), // "complete", "expired", "open"
  metadata: metadataSchema,
  amount_total: z.number().nullable(),
  currency: z.string().nullable(),
});

// FIX CF-3: Checkout Session Completed event
// This is the correct event for Stripe Checkout Sessions.
// The session.id (cs_...) is what we store in Payment.paymentIntent.
export const stripeCheckoutSessionCompletedEventSchema =
  stripeBaseEventSchema.extend({
    type: z.literal("checkout.session.completed"),
    data: z.object({
      object: checkoutSessionSchema,
    }),
  });

// Checkout Session Expired event (session timed out without payment)
export const stripeCheckoutSessionExpiredEventSchema =
  stripeBaseEventSchema.extend({
    type: z.literal("checkout.session.expired"),
    data: z.object({
      object: checkoutSessionSchema,
    }),
  });
