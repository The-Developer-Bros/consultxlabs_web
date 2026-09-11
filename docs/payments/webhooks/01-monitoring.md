# Webhook Monitoring & Success Notifications Guide

> **Moved (org/B2B side):** The organization-side documentation for inbound payment webhooks (including the org-relevant monitoring and archival jobs) now lives in [`docs/enterprise/10-money-and-ledger/12-payment-webhooks.md`](../../enterprise/10-money-and-ledger/12-payment-webhooks.md). This file keeps the consumer-marketplace (B2C) and gateway-generic details only.

## Overview

This guide covers how to monitor webhook activity, track success notifications, and troubleshoot payment gateway integrations.

## Success Toast Notifications

### Implementation Status ✅

All checkout pages now display success toast notifications with:

- ✅ Clear success indicators (green checkmark)
- ✅ Appropriate messaging for skip payment vs real payment
- ✅ 2-second delay before redirect to allow users to see the toast
- ✅ Consistent implementation across all event types

### Supported Event Types

1. **Consultation Booking**: `"✅ Consultation Booked Successfully!"`
2. **Webinar Registration**: `"✅ Webinar Registration Successful!"`
3. **Class Registration**: `"✅ Class Registration Successful!"`
4. **Subscription Activation**: `"✅ Subscription Activated Successfully!"`

### Skip Payment vs Real Payment Messages

- **Skip Payment**: `"Your [type] has been confirmed. Check your dashboard for details."`
- **Real Payment**: `"Payment processed successfully. Your [type] is confirmed."`

## Webhook Monitoring

### Webhook Endpoints Created

1. **Stripe Webhooks**: `/api/webhooks/stripe`
2. **Razorpay Webhooks**: `/api/webhooks/razorpay`

### Webhook Event Logging

All webhook events are automatically logged to the console with detailed information:

```javascript
console.log(`🔔 [Gateway] Webhook Event: ${event.type}`, {
  id: event.id,
  created: timestamp,
  data: event.data.object,
});
```

### Tracked Events

#### Stripe Events

- ✅ `payment_intent.succeeded` - Payment completed
- ❌ `payment_intent.payment_failed` - Payment failed
- ✅ `invoice.payment_succeeded` - Subscription payment
- 🆕 `customer.subscription.created` - New subscription

#### Razorpay Events

- ✅ `payment.captured` - Payment completed
- ❌ `payment.failed` - Payment failed
- ✅ `order.paid` - Order payment completed
- ✅ `subscription.charged` - Subscription payment
- 🆕 `subscription.activated` - New subscription

## How to Check if Webhooks are Working

### Method 1: Server Logs (Recommended)

#### Development Environment

```bash
# In your development terminal, look for webhook logs
npm run dev

# Watch for logs like:
# 🔔 Stripe Webhook Event: payment_intent.succeeded
# 🔔 Razorpay Webhook Event: payment.captured
```

#### Production Environment

```bash
# Check your hosting platform logs (Vercel, Heroku, etc.)
# Or use your logging service (LogRocket, Sentry, etc.)

# Look for webhook event logs with timestamps
```

### Method 2: Payment Gateway Dashboards

#### Stripe Dashboard

1. Go to https://dashboard.stripe.com/webhooks
2. Click on your webhook endpoint
3. View **"Recent events"** tab
4. Check **"Attempts"** for delivery status
5. Look for HTTP 200 responses (success)

#### Razorpay Dashboard

1. Go to https://dashboard.razorpay.com/webhooks
2. Select your webhook endpoint
3. Check **"Logs"** section
4. Look for successful delivery status
5. Verify response codes

### Method 3: Database Checks

#### Verify Booking Status Updates

```sql
-- Check recent consultation bookings
-- NOTE: the DB column is still `requestStatus` — the Prisma field renamed
-- to `status` via @map, the column did not.
SELECT id, "requestStatus", "createdAt", "updatedAt"
FROM "Consultation"
ORDER BY createdAt DESC
LIMIT 10;

-- Check payment records
SELECT id, paymentStatus, paymentGateway, amount, createdAt
FROM Payment
ORDER BY createdAt DESC
LIMIT 10;
```

### Method 4: Test Webhook Endpoints Directly

#### Test Stripe Webhook

```bash
# Use Stripe CLI to forward events (development)
stripe listen --forward-to localhost:3000/api/webhooks/stripe

# Send test events
stripe trigger payment_intent.succeeded
```

#### Test Razorpay Webhook

```bash
# Use ngrok for local testing
ngrok http 3000

# Configure webhook URL in Razorpay dashboard:
# https://your-ngrok-url.ngrok.io/api/webhooks/razorpay
```

## Troubleshooting Webhook Issues

### Common Problems

#### 1. Webhook Not Receiving Events

**Symptoms**: No logs in console, no webhook attempts in dashboard

**Solutions**:

- ✅ Verify webhook URL is correct in payment gateway dashboard
- ✅ Check if webhook URL is publicly accessible (not localhost)
- ✅ Ensure webhook endpoint is deployed and running
- ✅ Verify webhook is enabled in gateway dashboard

#### 2. Webhook Authentication Failing

**Symptoms**: 400/401 errors in webhook attempts

**Solutions**:

- ✅ Check `STRIPE_WEBHOOK_SECRET` environment variable
- ✅ Check `RAZORPAY_WEBHOOK_SECRET` environment variable
- ✅ Regenerate webhook secrets if necessary
- ✅ Verify signature verification logic

#### 3. Webhook Events Not Processing

**Symptoms**: 200 responses but no business logic execution

**Solutions**:

- ✅ Check event type handling in webhook endpoint
- ✅ Verify metadata/notes contain required booking information
- ✅ Check database connection and permissions
- ✅ Review error logs for unhandled exceptions

#### 4. Development vs Production Issues

**Symptoms**: Works locally but not in production

**Solutions**:

- ✅ Verify environment variables are set in production
- ✅ Check production webhook URL configuration
- ✅ Ensure SSL certificate is valid
- ✅ Review production logs for errors

## Environment Variable Checklist

### Required for Webhook Monitoring

```bash
# Stripe (if using Stripe)
STRIPE_SECRET_KEY=sk_test_... # or sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Razorpay (if using Razorpay)
RAZORPAY_KEY_ID=rzp_test_... # or rzp_live_...
RAZORPAY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...

# Optional: Skip payment for testing
SKIP_PAYMENT=true # Remove for production
```

## Best Practices

### 1. Webhook Security

- ✅ Always verify webhook signatures
- ✅ Use HTTPS for webhook URLs
- ✅ Keep webhook secrets secure
- ✅ Implement idempotency for webhook processing
- ✅ **Razorpay composite eventId** (Mar 2026): eventId is now formatted as `{eventType}:{entityId}` to prevent cross-event collisions (e.g., a `payment.captured` and `refund.created` for the same entity no longer share an idempotency key)

### 2. Error Handling

- ✅ Log all webhook events with detailed context
- ✅ Handle webhook retries gracefully
- ✅ Implement dead letter queues for failed events
- ✅ Monitor webhook failure rates

### 3. Testing

- ✅ Test webhook endpoints in development
- ✅ Use test payment methods before going live
- ✅ Verify webhook processing with real payments
- ✅ Test edge cases (failed payments, timeouts)

### 4. Monitoring

- ✅ Set up alerts for webhook failures
- ✅ Monitor payment success rates
- ✅ Track booking status updates
- ✅ Review logs regularly

### Method 5: The deferral warning

A Razorpay webhook can be valid and still be unprocessable on arrival, most commonly a `refund.created` that overtakes the `payment.captured` which would have created the Payment row. The handler answers those with a `DeferSignal`, the dispatcher deliberately leaves the row `processed=false, error=null`, and `sweep-stuck-webhook-events` re-drives it until the awaited row lands or the seven-day give-up cap fires.

The problem with that design was that a deferred row is indistinguishable from a row whose handler crashed before recording anything, so an event that would never become processable stayed silent for a week. The dispatcher now increments `WebhookEvent.deferCount` every time it defers, and the sweeper raises a single Sentry warning per run listing every event that has deferred five or more times or has been unprocessed for over an hour. If you see `sweep-stuck-webhook-events: N webhook event(s) still unprocessed` in Sentry, the attached context names each event id, its provider, its type and its defer count.

A high `deferCount` on a refund means the handler could not resolve the payment the refund names, and there are two quite different reasons for that. Check the local capture state first: look the `pay_…` id up against `Payment.gatewayPaymentId` and the order id against `Payment.paymentIntent`, and if neither finds a row then the payment really was never captured on our side and the event is a reconciliation question rather than a webhook one. If a row does exist, the failure is in the lookup rather than in the data, which on a pre-`gatewayPaymentId` row means the dispatcher's `payments.fetch` translation is failing — check the Razorpay credentials the function is running with and the gateway's availability, because an authentication or network failure there produces exactly the same silent, repeating deferral as a genuinely missing capture.

## Success Indicators

### Your webhooks are working correctly if:

1. ✅ **Console logs show webhook events** with proper formatting
2. ✅ **Payment gateway dashboards show successful deliveries** (HTTP 200)
3. ✅ **Database records are updated** (booking status, payment status)
4. ✅ **Users see success toast notifications** before redirect
5. ✅ **Email confirmations are sent** (if implemented)
6. ✅ **Dashboard shows updated booking information**

### Your success notifications are working if:

1. ✅ **Toast appears immediately** after successful checkout
2. ✅ **Message is appropriate** for payment vs skip payment mode
3. ✅ **Redirect happens after 2 seconds** allowing time to read toast
4. ✅ **Dashboard shows correct booking status** after redirect
5. ✅ **Consistent behavior** across all event types and payment gateways

## Quick Testing Checklist

### Skip Payment Mode (Development)

1. Set `SKIP_PAYMENT=true`
2. Complete checkout flow
3. Verify success toast appears
4. Check dashboard for booking
5. Review console logs

### Real Payment Mode

1. Set `SKIP_PAYMENT=false`
2. Use test payment credentials
3. Complete payment flow
4. Check webhook logs
5. Verify booking confirmation
6. Test with different payment methods

### All Event Types

- [ ] Consultation booking
- [ ] Subscription activation
- [ ] Webinar registration
- [ ] Class registration

### Both Payment Gateways

- [ ] Stripe integration
- [ ] Razorpay integration
