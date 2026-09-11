# Webhook Behavior During Maintenance

## Overview

All webhook routes (`/api/webhooks/*`) are **exempt from maintenance mode**. This means webhooks from Stripe, Razorpay, and Stream.io will be received and processed regardless of whether the site is in DEGRADED or OFFLINE mode.

This is intentional: payment webhooks are critical for completing transactions and must not be blocked.

## Webhook Handlers

| Gateway           | Route                              | Signature Verification             | Idempotency                               |
| ----------------- | ---------------------------------- | ---------------------------------- | ----------------------------------------- |
| **Stripe**        | `POST /api/webhooks/stripe`        | `stripe.webhooks.constructEvent()` | `logWebhookEvent()` with gateway event ID |
| **Razorpay**      | `POST /api/webhooks/razorpay`      | HMAC SHA256 signature              | `logWebhookEvent()` with gateway event ID |
| **Stream.io**     | `POST /api/stream/webhooks/`       | HMAC SHA256 (constant-time)        | `logWebhookEvent()` with event ID         |

## Stripe Webhook Events Handled

- `payment_intent.succeeded` -- Payment completed
- `payment_intent.payment_failed` -- Payment failed
- `charge.refunded` -- Refund processed
- `charge.dispute.created` -- Dispute opened
- `charge.dispute.updated` -- Dispute status changed
- `charge.dispute.closed` -- Dispute resolved
- `payout.created` / `payout.paid` / `payout.failed` / `payout.canceled` -- Payout lifecycle
- `account.updated` -- Connected account changes
- `transfer.created` / `transfer.reversed` -- Transfer lifecycle

## Razorpay Webhook Events Handled

- `payment.captured` -- Payment captured
- `order.paid` -- Order paid
- `payment.failed` -- Payment failed
- `refund.created` / `refund.processed` / `refund.failed` -- Refund lifecycle
- `payment.dispute.created` / `payment.dispute.won` / `payment.dispute.lost` / `payment.dispute.closed` -- Dispute lifecycle
- `payout.processed` / `payout.reversed` / `payout.rejected` / `payout.queued` / `payout.pending` / `payout.cancelled` -- Payout lifecycle

## Stream.io Webhook Events Handled

- `call.recording_started` / `call.recording_stopped` -- Recording lifecycle
- `call.recording_ready` / `call.recording_failed` -- Recording completion
- `call.session_ended` / `call.ended` -- Call lifecycle

## Retry Behavior by Provider

### Stripe

- **Retry policy**: Up to 3 days with exponential backoff
- **Initial retry**: ~1 hour after first failure
- **Max retries**: ~15 attempts over 3 days
- **Behavior on 5xx**: Retries with exponential backoff
- **Behavior on 4xx**: No retry (considered permanent failure)
- **Dashboard**: Stripe Dashboard > Developers > Webhooks > Failed events

### Razorpay

- **Retry policy**: Retries for up to 24 hours
- **Retry interval**: Exponential backoff starting at ~5 minutes
- **Max retries**: Multiple attempts over 24 hours
- **Behavior on failure**: Retries on non-2xx response
- **Dashboard**: Razorpay Dashboard > Webhooks > Recent Deliveries

## Idempotency Protection

All webhook handlers use `logWebhookEvent()` from `/api/webhooks/utils.ts`:

1. **On receive**: Creates a `WebhookEvent` record with a unique `eventId` (gateway event ID + type)
2. **Duplicate check**: If `eventId` already exists, returns `{ isNew: false }` and handler returns 200 OK immediately
3. **Processing**: If new, processes the event and calls `markWebhookEventProcessed()` with success/error status

**Database table**: `WebhookEvent`

- `gateway`: STRIPE | RAZORPAY | STREAM
- `eventId`: Unique identifier from the gateway
- `eventType`: Event type string
- `payload`: Full JSON payload
- `processed`: Boolean
- `processingError`: Error message if processing failed

This means even if a webhook is retried (due to temporary failure during maintenance), it will not be processed twice.

## What Happens During DB Migration

**Scenario**: Webhook fires while PostgreSQL is mid-migration.

1. Webhook arrives at `/api/webhooks/stripe`
2. Signature verification passes (no DB needed)
3. `logWebhookEvent()` attempts INSERT into `WebhookEvent` table
4. **If DB is unavailable**: INSERT fails, handler returns 500
5. **Stripe retries** the webhook (exponential backoff)
6. **If schema changed**: INSERT may fail if `WebhookEvent` table was altered
7. **If DB is available but tables locked**: INSERT blocks, may timeout

**Key insight**: For short maintenance windows (<1 hour), webhook retries from all gateways provide sufficient coverage. Webhooks that fail during the window will be retried after the DB is back online.

## Risk: Webhook Handler Hits Migrating Schema

The webhook handler does more than just log the event. It also:

- Creates appointments (`handlePaymentSuccess()`)
- Updates payment records
- Processes refunds (`handleRefundCreated()`)
- Tracks disputes (`handleDisputeCreated()`)

If any of these operations reference a table or column that was changed by the migration, the handler will fail even after the DB is back online. In this case:

1. Check Stripe/Razorpay dashboard for failed webhook deliveries
2. Manually replay failed webhooks after verifying code compatibility
3. Or run `reconcile-payment-status` job to catch missed payments

## Recommendations

1. **Keep maintenance windows short** (<1 hour) -- all gateways retry for at least 24 hours
2. **Check webhook logs post-maintenance** -- see [Post-Maintenance Recovery](./07-post-maintenance-recovery.md)
3. **If migrating WebhookEvent table**: Consider temporarily disabling the idempotency check, or migrate the table first in a separate step
4. **Monitor Stripe dashboard** during and after maintenance for failed deliveries
5. **Future improvement**: Add a `SELECT 1` health check before processing each webhook event, returning 503 to trigger gateway retry if DB is unhealthy
