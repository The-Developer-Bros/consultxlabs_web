# Razorpay Webhook Schema

> **Moved (org/B2B side):** The organization-side documentation for inbound payment webhooks now lives in [`docs/enterprise/10-money-and-ledger/12-payment-webhooks.md`](../../enterprise/10-money-and-ledger/12-payment-webhooks.md). This file keeps the consumer-marketplace (B2C) and gateway-generic details only.

```typescript
import z from "zod";

// Base Razorpay entity schemas
const razorpayAddressSchema = z.object({
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  zipcode: z.string().optional(),
});

const razorpayCustomerSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  email: z.string().email().optional(),
  contact: z.string().optional(),
  gstin: z.string().optional(),
  notes: z.record(z.string()).optional(),
  created_at: z.number(),
});

const razorpayNotesSchema = z.record(z.string()).optional();

// Payment entity schema
const razorpayPaymentEntitySchema = z.object({
  id: z.string(),
  entity: z.literal("payment"),
  amount: z.number(),
  currency: z.string(),
  status: z.enum([
    "created",
    "authorized",
    "captured",
    "refunded",
    "failed",
    "disputed",
    "partially_refunded",
  ]),
  order_id: z.string().optional(),
  invoice_id: z.string().optional(),
  international: z.boolean(),
  method: z.enum([
    "card",
    "netbanking",
    "wallet",
    "emi",
    "upi",
    "bank_transfer",
  ]),
  amount_refunded: z.number(),
  refund_status: z.enum(["null", "partial", "full"]).optional(),
  captured: z.boolean(),
  description: z.string().optional(),
  card_id: z.string().optional(),
  bank: z.string().optional(),
  wallet: z.string().optional(),
  vpa: z.string().optional(),
  email: z.string().email().optional(),
  contact: z.string().optional(),
  notes: razorpayNotesSchema,
  fee: z.number().optional(),
  tax: z.number().optional(),
  error_code: z.string().optional(),
  error_description: z.string().optional(),
  error_source: z.string().optional(),
  error_step: z.string().optional(),
  error_reason: z.string().optional(),
  acquirer_data: z.record(z.any()).optional(),
  created_at: z.number(),
});

// Order entity schema
const razorpayOrderEntitySchema = z.object({
  id: z.string(),
  entity: z.literal("order"),
  amount: z.number(),
  amount_paid: z.number(),
  amount_due: z.number(),
  currency: z.string(),
  receipt: z.string().optional(),
  offer_id: z.string().optional(),
  status: z.enum(["created", "attempted", "paid"]),
  attempts: z.number(),
  notes: razorpayNotesSchema,
  created_at: z.number(),
});

// Refund entity schema
const razorpayRefundEntitySchema = z.object({
  id: z.string(),
  entity: z.literal("refund"),
  amount: z.number(),
  currency: z.string(),
  payment_id: z.string(),
  notes: razorpayNotesSchema,
  receipt: z.string().optional(),
  acquirer_data: z.record(z.any()).optional(),
  created_at: z.number(),
  batch_id: z.string().optional(),
  status: z.enum(["pending", "processed", "failed"]),
  speed_processed: z.enum(["normal", "instant"]).optional(),
  speed_requested: z.enum(["normal", "instant"]).optional(),
});

// Dispute entity schema
const razorpayDisputeEntitySchema = z.object({
  id: z.string(),
  entity: z.literal("dispute"),
  payment_id: z.string(),
  amount: z.number(),
  currency: z.string(),
  amount_deducted: z.number(),
  reason_code: z.string(),
  reason_description: z.string(),
  status: z.enum(["open", "under_review", "won", "lost", "closed"]),
  phase: z.enum(["chargeback", "pre_arbitration", "arbitration"]),
  respond_by: z.number(),
  evidence: z.record(z.any()).optional(),
  evidence_details: z.record(z.any()).optional(),
  created_at: z.number(),
});

// Settlement entity schema
const razorpaySettlementEntitySchema = z.object({
  id: z.string(),
  entity: z.literal("settlement"),
  amount: z.number(),
  status: z.enum(["created", "processed", "failed"]),
  fees: z.number(),
  tax: z.number(),
  utr: z.string().optional(),
  created_at: z.number(),
});

// Invoice entity schema
const razorpayInvoiceEntitySchema = z.object({
  id: z.string(),
  entity: z.literal("invoice"),
  receipt: z.string().optional(),
  invoice_number: z.string().optional(),
  customer_id: z.string().optional(),
  customer_details: razorpayCustomerSchema.optional(),
  order_id: z.string().optional(),
  line_items: z.array(z.record(z.any())).optional(),
  payment_id: z.string().optional(),
  status: z.enum([
    "draft",
    "issued",
    "partially_paid",
    "paid",
    "cancelled",
    "expired",
  ]),
  expire_by: z.number().optional(),
  issued_at: z.number().optional(),
  paid_at: z.number().optional(),
  cancelled_at: z.number().optional(),
  expired_at: z.number().optional(),
  sms_status: z.string().optional(),
  email_status: z.string().optional(),
  date: z.number(),
  terms: z.string().optional(),
  partial_payment: z.boolean(),
  gross_amount: z.number(),
  tax_amount: z.number(),
  taxable_amount: z.number(),
  amount: z.number(),
  amount_paid: z.number(),
  amount_due: z.number(),
  currency: z.string(),
  description: z.string().optional(),
  notes: razorpayNotesSchema,
  comment: z.string().optional(),
  short_url: z.string().optional(),
  view_less: z.boolean().optional(),
  billing_start: z.number().optional(),
  billing_end: z.number().optional(),
  type: z.enum(["invoice", "ecod", "link", "payment_request"]).optional(),
  group_taxes_discounts: z.boolean().optional(),
  created_at: z.number(),
});

// Main webhook payload schemas
const paymentWebhookPayloadSchema = z.object({
  payment: z.object({
    entity: razorpayPaymentEntitySchema,
  }),
});

const orderWebhookPayloadSchema = z.object({
  order: z.object({
    entity: razorpayOrderEntitySchema,
  }),
});

const refundWebhookPayloadSchema = z.object({
  refund: z.object({
    entity: razorpayRefundEntitySchema,
  }),
});

const disputeWebhookPayloadSchema = z.object({
  dispute: z.object({
    entity: razorpayDisputeEntitySchema,
  }),
});

const settlementWebhookPayloadSchema = z.object({
  settlement: z.object({
    entity: razorpaySettlementEntitySchema,
  }),
});

const invoiceWebhookPayloadSchema = z.object({
  invoice: z.object({
    entity: razorpayInvoiceEntitySchema,
  }),
});

// Main Razorpay webhook schema
export const razorpayWebhookSchema = z.object({
  entity: z.literal("event"),
  account_id: z.string(),
  event: z.enum([
    // Payment events
    "payment.authorized",
    "payment.failed",
    "payment.captured",
    "payment.dispute.created",

    // Order events
    "order.paid",

    // Refund events
    "refund.created",
    "refund.failed",
    "refund.processed",

    // Dispute events
    "payment.dispute.created",
    "payment.dispute.won",
    "payment.dispute.lost",
    "payment.dispute.closed",

    // Settlement events
    "settlement.processed",
    "settlement.failed",

    // Invoice events
    "invoice.paid",
    "invoice.partially_paid",
    "invoice.payment_failed",

    // Subscription events
    "subscription.activated",
    "subscription.charged",
    "subscription.completed",
    "subscription.cancelled",
    "subscription.updated",
    "subscription.pending",
    "subscription.halted",
    "subscription.resumed",
    "subscription.paused",

    // Virtual Account events
    "virtual_account.created",
    "virtual_account.credited",
    "virtual_account.closed",
  ]),
  payload: z.union([
    paymentWebhookPayloadSchema,
    orderWebhookPayloadSchema,
    refundWebhookPayloadSchema,
    disputeWebhookPayloadSchema,
    settlementWebhookPayloadSchema,
    invoiceWebhookPayloadSchema,
  ]),
  created_at: z.number(),
});

// Individual event type schemas for type safety
export const razorpayPaymentAuthorizedSchema = razorpayWebhookSchema.extend({
  event: z.literal("payment.authorized"),
  payload: paymentWebhookPayloadSchema,
});

export const razorpayPaymentCapturedSchema = razorpayWebhookSchema.extend({
  event: z.literal("payment.captured"),
  payload: paymentWebhookPayloadSchema,
});

export const razorpayPaymentFailedSchema = razorpayWebhookSchema.extend({
  event: z.literal("payment.failed"),
  payload: paymentWebhookPayloadSchema,
});

export const razorpayOrderPaidSchema = razorpayWebhookSchema.extend({
  event: z.literal("order.paid"),
  payload: orderWebhookPayloadSchema,
});

export const razorpayRefundCreatedSchema = razorpayWebhookSchema.extend({
  event: z.literal("refund.created"),
  payload: refundWebhookPayloadSchema,
});

export const razorpayDisputeCreatedSchema = razorpayWebhookSchema.extend({
  event: z.literal("payment.dispute.created"),
  payload: disputeWebhookPayloadSchema,
});

// Type exports
export type RazorpayWebhookEvent = z.infer<typeof razorpayWebhookSchema>;
export type RazorpayPaymentEntity = z.infer<typeof razorpayPaymentEntitySchema>;
export type RazorpayOrderEntity = z.infer<typeof razorpayOrderEntitySchema>;
export type RazorpayRefundEntity = z.infer<typeof razorpayRefundEntitySchema>;
export type RazorpayDisputeEntity = z.infer<typeof razorpayDisputeEntitySchema>;

// Validation helper function
export function validateRazorpayWebhook(data: unknown): {
  isValid: boolean;
  event?: RazorpayWebhookEvent;
  error?: string;
} {
  try {
    const event = razorpayWebhookSchema.parse(data);
    return { isValid: true, event };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        isValid: false,
        error: `Validation failed: ${error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`,
      };
    }
    return {
      isValid: false,
      error: `Unknown validation error: ${error}`,
    };
  }
}
```
