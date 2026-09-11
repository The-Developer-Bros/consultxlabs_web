# Razorpay Debugging Guide

Common issues and their solutions, organized by symptom.

## Webhook Not Firing

**Check these in order:**

1. **Webhook URL registered**: Dashboard → Account & Settings → Webhooks → Verify URL is correct
2. **HTTPS required**: Razorpay won't call HTTP endpoints (except localhost in test mode)
3. **Events enabled**: Check which events are checked in webhook settings
4. **Response timeout**: Razorpay expects 2xx within 5 seconds. If your handler takes longer, it times out and retries.
5. **Check webhook logs**: Dashboard → Developers → Webhooks → select the webhook → View delivery attempts

**Test locally with ngrok:**
```bash
ngrok http 3000
# Copy the https URL → Register as webhook URL in Razorpay Dashboard
```

## Signature Verification Failing

**Most common causes:**

1. **Using wrong secret**: Webhook signature uses `RAZORPAY_WEBHOOK_SECRET`. Payment verification uses `RAZORPAY_SECRET`. They are DIFFERENT values.

2. **Parsing body as JSON first**: Signature is computed on the RAW string body. If you parse to JSON and re-stringify, whitespace changes break the signature.
   ```typescript
   // WRONG
   const body = await request.json();
   const raw = JSON.stringify(body);  // May differ from original!

   // CORRECT
   const raw = await request.text();
   const body = JSON.parse(raw);
   ```

3. **Invoice signature format wrong**: Order flow and invoice flow have different signature payloads:
   ```
   Order:   HMAC(secret, "order_id|payment_id")
   Invoice: HMAC(secret, "invoice_id|receipt|status|payment_id")
   ```

4. **Optional fields undefined**: Invoice `receipt` and `status` may be undefined. Use `?? ""`:
   ```typescript
   const payload = `${invoiceId}|${receipt ?? ""}|${status ?? ""}|${paymentId}`;
   ```

## Duplicate Webhook Events

**Symptom**: Same subscription activated twice, duplicate GST invoices, double access grants.

**Root cause**: Razorpay uses at-least-once delivery. If your handler doesn't return 200 within 5 seconds, it retries.

**Fix**: Track `lastEventId` in your subscription table and skip duplicates:
```typescript
const eventId = request.headers.get("x-razorpay-event-id") || event.id;
if (subscription.lastEventId === eventId) {
  return new Response("Already processed", { status: 200 });
}
```

## Subscription Stuck in "created" Status

**Symptom**: Subscription created but never activates.

**Cause**: User opened checkout but never completed payment.

**Fix**: Implement stale pending cleanup:
```typescript
// Before creating new subscription, check for stale ones
const existing = await getSubscriptionByUserId(userId);
if (existing?.status === "created" && isOlderThan1Hour(existing.createdAt)) {
  // Cancel stale subscription on Razorpay
  await razorpay.subscriptions.cancel(existing.razorpaySubscriptionId, false);
}
```

## `subscriptions.cancel()` TypeScript Error

**Symptom**: TypeScript complains about second parameter type.

**Fix**: On the pinned SDK (`razorpay@2.9.6`) the second parameter is a POSITIONAL BOOLEAN (`cancelAtCycleEnd`), not an options object:
```typescript
// WRONG
await razorpay.subscriptions.cancel(id, { cancel_at_cycle_end: true });

// CORRECT
await razorpay.subscriptions.cancel(id, true);  // cancel at cycle end
await razorpay.subscriptions.cancel(id, false); // cancel immediately
```

**Why the object form is dangerous on 2.9.6**: the implementation is `cancelAtCycleEnd && { data: { cancel_at_cycle_end: 1 } }`. An object is always truthy, so `{ cancel_at_cycle_end: false }` does NOT cancel immediately — it silently cancels at cycle end (a foot-gun inversion of your intent). The object-with-`true` form happens to behave correctly by accident, but the object form is still wrong here. This is version-dependent: newer Razorpay SDK docs show an options-object form, so confirm the installed version before switching shapes.

## `customers.create()` TypeScript Error with `fail_existing`

**Symptom**: TypeScript expects `0 | 1` but won't accept the number.

**Fix**: Explicit cast (version-dependent):
```typescript
await razorpay.customers.create({
  email: user.email,
  fail_existing: 0 as 0 | 1,  // Upsert — return existing customer
});
```

The cast is only needed on SDK versions whose typings declare `fail_existing` as `0 | 1` (a bare numeric literal then trips `tsc`). Other versions type it loosely and need no cast — check the installed `.d.ts` before adding the cast.

## Payment Succeeds But Access Not Granted

**This is the #1 production issue. Debug in this order:**

1. **Check auto-capture setting**: Dashboard → Account & Settings → Payment Capture (older dashboards: Settings → Payments → "Automatic capture delay"). If set to manual, payments stay in `authorized` state and `payment.captured` never fires. **Fix: enable automatic capture in Dashboard.** Auto-capture is ON by default for new accounts — check whether it was disabled.
2. **Check event type**: Were you looking at `subscription.authenticated` or `subscription.activated`? Only `activated` means money was charged. `authenticated` just means card was verified — NO payment.
3. **Check webhook delivery**: Dashboard → Developers → Webhooks → select the webhook → Delivery attempts. See if Razorpay even tried to send.
4. **Webhook timeout**: Your handler must return 200 within 5 seconds. If it takes 6 seconds, Razorpay marks it failed and retries. Check your handler latency.
5. **Check idempotency**: Is `lastEventId` causing a skip? A previous delivery may have succeeded in Razorpay's view but failed to commit in your DB.
6. **Check signature**: Was 400 returned? Means wrong secret or parsed JSON body.
7. **Payment succeeded but webhook never arrived**: usually the webhook URL was down or DNS failed. Reach for these in order:
   - **The sweeper** — `scripts/cleanup/sweep-stuck-webhook-events.ts` re-drives every `WebhookEvent` row still at `processed = false` through the same dispatcher. This covers the common case: the event arrived, the handler died mid-way.
   - **API reconciliation** — if the event never reached us at all there is no row to sweep, so read the truth back from Razorpay:
   ```typescript
   const order = await razorpayClient.orders.fetch(payment.paymentIntent);
   if (order.status === "paid" && payment.paymentStatus !== "SUCCEEDED") {
     // app/api/checkout/verify/route.ts already does exactly this, guarded by a
     // conditional updateMany on PENDING so it cannot race the webhook.
   }
   ```
   - **Support-ticket replay**, last: there is no self-serve replay button. Dashboard → Help → Technical Support → "Issue regarding Webhooks/API", one event per request, event ≤15 days old, and only if the webhook was enabled when it fired. See `webhooks.md`.

## Auto-Capture Is Silently Off

**Symptom**: Payments show as `authorized` in Razorpay Dashboard but never move to `captured`. Webhooks like `payment.captured` never fire.

**Root cause**: Dashboard → Account & Settings → Payment Capture (older dashboards: Settings → Payments → "Automatic capture delay") is set to manual or a delay. Auto-capture is ON by default, but it can have been switched off — and authorized-but-uncaptured payments auto-refund after the configured window (default ~3 days).

**Fix**: Enable automatic capture in Dashboard. Or capture manually via API:
```typescript
await razorpay.payments.capture(paymentId, amount, "INR");
```

**Why this is dangerous**: Everything works in test mode (test payments auto-capture regardless of this setting). You only discover this in production when real customers pay but never get access.

## Edge Runtime / Vercel Edge Functions Break Crypto

**Symptom**: Webhook signature verification fails on Vercel Edge Functions or Cloudflare Workers with "crypto.createHmac is not a function".

**Root cause**: Edge runtimes don't support Node.js `crypto` module. They use Web Crypto API instead.

**Fix**: Use Web Crypto API for edge runtimes:
```typescript
// Works in Edge Runtime (Vercel Edge, Cloudflare Workers)
async function verifyWebhookSignatureEdge(
  rawBody: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  // Timing-safe comparison (no crypto.timingSafeEqual in edge)
  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}
```

**Better fix**: Don't use Edge Runtime for webhook routes. In Next.js, ensure your webhook route uses Node.js runtime:
```typescript
// app/api/webhooks/razorpay/route.ts
export const runtime = "nodejs"; // Force Node.js runtime — NOT edge
```

## Plan Change Not Working

**Debug steps:**

1. **Check `notes.replacesSubscription`**: Is the old subscription ID in the new subscription's notes?
2. **Check webhook**: Is `subscription.activated` being received for the new subscription?
3. **Check auto-creation**: If subscription isn't in DB, does your webhook handler auto-create from notes?
4. **Check old sub cancellation**: Is `razorpay.subscriptions.cancel(oldId, true)` being called in the webhook?

## Razorpay SDK Quirks Reference

| Quirk | Workaround |
|-------|-----------|
| `cancel(id, boolean)` typed as object | Use `true` or `false` directly |
| `fail_existing: 0` type mismatch | Cast: `0 as 0 \| 1` |
| `notify_info` fails with empty object | Only include if fields are present |
| `contact` field rejects empty string | Omit field entirely if no phone |
| period-end field name | Use `current_end` (Unix s), `end_at` as fallback; `current_period_end` is a Stripe-ism, not a Razorpay field |
| Webhook event ID in header vs payload | Prefer `x-razorpay-event-id` header |
| Error shape varies by endpoint | Check both `.error.code` and `.statusCode` |

## Quick Diagnostic Commands

```bash
# Check if webhook endpoint is reachable
curl -X POST https://your-app.com/api/webhooks/razorpay \
  -H "Content-Type: application/json" \
  -d '{"test": true}'
# Should return 400 (missing signature), NOT 404 or 500

# Verify Razorpay credentials work
curl -u rzp_test_key:rzp_test_secret \
  https://api.razorpay.com/v1/plans
# Should return plan list, NOT 401

# Check subscription status
curl -u rzp_test_key:rzp_test_secret \
  https://api.razorpay.com/v1/subscriptions/sub_xxxxx
```

## Mock Webhook Payloads for Local Testing

Use these sample payloads to test your webhook handler locally without triggering real Razorpay events.

### subscription.activated

Sent when a new subscription is successfully activated after first payment.

```json
{
  "event": "subscription.activated",
  "payload": {
    "subscription": {
      "entity": {
        "id": "sub_test123",
        "plan_id": "plan_test456",
        "customer_id": "cust_test789",
        "status": "active",
        "current_end": 1700000000,
        "notes": { "userId": "user_123", "planKey": "pro_monthly" }
      }
    },
    "payment": {
      "entity": {
        "id": "pay_test111",
        "amount": 99900,
        "currency": "INR",
        "subscription_id": "sub_test123"
      }
    }
  }
}
```

### subscription.charged

Sent on each successful renewal payment.

```json
{
  "event": "subscription.charged",
  "payload": {
    "subscription": {
      "entity": {
        "id": "sub_test123",
        "plan_id": "plan_test456",
        "customer_id": "cust_test789",
        "status": "active",
        "current_end": 1702592000,
        "paid_count": 2,
        "notes": { "userId": "user_123", "planKey": "pro_monthly" }
      }
    },
    "payment": {
      "entity": {
        "id": "pay_test222",
        "amount": 99900,
        "currency": "INR",
        "subscription_id": "sub_test123",
        "method": "card"
      }
    }
  }
}
```

### payment.failed

Sent when a payment attempt fails (e.g., insufficient funds, card declined).

```json
{
  "event": "payment.failed",
  "payload": {
    "payment": {
      "entity": {
        "id": "pay_test333",
        "amount": 99900,
        "currency": "INR",
        "status": "failed",
        "subscription_id": "sub_test123",
        "error_code": "BAD_REQUEST_ERROR",
        "error_description": "Payment processing failed because of insufficient balance",
        "error_reason": "insufficient_funds"
      }
    }
  }
}
```

### Testing with curl

```bash
# Test webhook locally (skip signature verification in test mode or use a known test secret)
curl -X POST http://localhost:3000/api/webhooks/razorpay \
  -H "Content-Type: application/json" \
  -H "x-razorpay-event-id: evt_test_001" \
  -H "x-razorpay-signature: <generate with your webhook secret>" \
  -d '<payload>'
```

### Generating a test signature

```bash
# Generate test signature
echo -n '<raw-json-payload>' | openssl dgst -sha256 -hmac "your_webhook_secret"
```

Replace `<raw-json-payload>` with the exact JSON string you pass as the `-d` body (no trailing newline). Use the hex output as the `x-razorpay-signature` header value.
