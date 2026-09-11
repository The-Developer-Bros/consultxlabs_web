# Razorpay API Quirks & Undocumented Behavior

This reference documents every Razorpay API quirk discovered through production use. These are NOT in the official docs.

## SDK Type Mismatches

### `subscriptions.cancel()` — Second Parameter
```typescript
// Razorpay docs say: cancel(subscriptionId, cancel_at_cycle_end)
// TypeScript SDK types suggest: cancel(subscriptionId, { cancel_at_cycle_end: boolean })
// What actually works:
await razorpay.subscriptions.cancel(id, true);   // Boolean, not object
await razorpay.subscriptions.cancel(id, false);  // Immediate cancel
```

### `customers.create()` — `fail_existing` Field
```typescript
// TypeScript expects: 0 | 1 | boolean
// But literal 0 doesn't satisfy the type checker
// Fix: explicit cast
await razorpay.customers.create({
  email: "user@example.com",
  fail_existing: 0 as 0 | 1,  // 0 = upsert (return existing customer)
});
```

## Webhook Behavior

### At-Least-Once Delivery
Razorpay does NOT guarantee exactly-once delivery. The same event can be delivered 2-5 times if:
- Your handler takes > 5 seconds to respond
- Your handler returns non-2xx
- Network issues between Razorpay and your server

**Mitigation**: Track `lastEventId` in your database AND maintain a `processed_webhook_events` table.

### Webhook Retry Schedule
Every event that gets a non-2xx response is a delivery failure, and Razorpay retries on an
**exponential backoff for 24 hours** from the event creation timestamp. The individual
intervals are not published — only the 24-hour envelope, so don't build timing assumptions
on a specific schedule.

If failures continue for the full 24 hours the **webhook is disabled** and stays disabled
until someone re-enables it in the Dashboard. Razorpay emails the Alert Email Address
configured on the webhook, falling back to the account email under Account & Settings.
This is the failure mode worth alerting on: a disabled webhook is silent, and every event
that fires while it is disabled is unrecoverable — not even a support replay can retrieve
those.

**There is no self-serve "replay" button.** Replay is a support ticket, one event at a
time, only for events ≤15 days old that fired while the webhook was enabled. Reconcile
against the API instead.

Source: <https://razorpay.com/docs/webhooks/best-practices/> · <https://razorpay.com/docs/webhooks/faqs/>

### Webhook Timeout
- Razorpay waits **5 seconds** for a 2xx response
- This is from when Razorpay sends the request to when it receives the response (includes network round-trip)
- If your webhook handler does heavy work (DB queries, external API calls, invoice creation), acknowledge immediately and process async via a queue
- Vercel serverless functions have a default 10s timeout, but Razorpay gives up at 5s — your function keeps running but the response is lost

### Event ID Location
```
Header:  x-razorpay-event-id
Payload: event.id
```
These SHOULD be the same but can differ in edge cases. Prefer the header.

### Subscription ID Location (varies by event type)
```
subscription events: event.payload.subscription.entity.id
payment events:      event.payload.payment.entity.subscription_id
invoice events:      event.payload.invoice.entity.subscription_id
```
Some events (standalone payments, orders) have NO subscription_id — return 200 and skip.

### Current Period End
The subscription entity carries `current_start` / `current_end`, with `end_at` as a
fallback on some payloads. Both are Unix timestamps in SECONDS (not milliseconds):
`new Date(value * 1000)`.

**`current_period_end` does not exist on Razorpay.** It is Stripe terminology, and it
appears in enough third-party material that people reach for it and silently read
`undefined`. An app-side *column* may be named `current_period_end` — that is fine, as
long as it is populated from the payload's `current_end`.

Source: <https://razorpay.com/docs/api/payments/subscriptions/entity/>

## Signature Verification

### Two Different Secrets
- **Webhook signature**: Uses `RAZORPAY_WEBHOOK_SECRET`
- **Payment verification**: Uses `RAZORPAY_SECRET`
These are DIFFERENT values. Using the wrong one = silent signature mismatch.

### Two Different Signature Formats
```
Order flow:   HMAC-SHA256(key_secret, "order_id|payment_id")
Invoice flow: HMAC-SHA256(key_secret, "invoice_id|receipt|status|payment_id")
```

### Raw Body Required for Webhooks
```typescript
// WRONG — JSON.parse then JSON.stringify changes whitespace
const body = await request.json();
const raw = JSON.stringify(body);

// CORRECT — use raw string for HMAC
const raw = await request.text();
const body = JSON.parse(raw);
```

## Customer API

### Phone Number Handling
- Razorpay rejects phone numbers with formatting characters
- Strip everything except digits and `+`: `phone.replace(/[^\d+]/g, "")`
- If phone is null/undefined, OMIT the `contact` field entirely (don't pass empty string)

### `notify_info` Object
- Only include if you have at least one field (email or phone)
- Empty object `{}` causes API errors
- Build conditionally:
```typescript
const notifyInfo = {
  ...(email ? { notify_email: email } : {}),
  ...(phone ? { notify_phone: phone.replace(/[^\d+]/g, "") } : {}),
};
// Only include in subscription.create if Object.keys(notifyInfo).length > 0
```

## Subscription States

```
created → authenticated → active → (charged repeatedly)
                                  ↓
                              cancelled (at cycle end)
                              completed (all cycles done)
                              halted (payment failures)
                              paused (manual)
```

### State Transition Gotchas
- `subscription.pending` can arrive AFTER `subscription.activated` — don't downgrade
- `payment.authorized` can arrive AFTER `subscription.authenticated` — use as fallback activation
- `subscription.charged` is for RENEWALS, not initial payment
- `subscription.completed` means all `total_count` cycles are done — not a cancellation
- `subscription.authenticated` does NOT mean paid — only card verified. Wait for `subscription.activated`

### What Happens After All Renewal Retries Fail
- Razorpay retries failed renewal payments 3 times over ~3 days (configurable in Dashboard → Settings → Subscriptions)
- After all retries fail: subscription moves to `halted` state and `subscription.halted` webhook fires
- **Halted subscriptions cannot be auto-resumed** — you must create a NEW subscription
- Halted subscriptions stay halted forever (they don't auto-cancel)
- **Recommendation**: Build a cleanup cron that auto-cancels subscriptions halted for 30+ days
- During retry window, the user still has access (subscription shows `active` with a failed charge in the background)

## Auto-Capture vs Manual Capture

**This one will silently break your entire integration.**

Razorpay Dashboard → Settings → Payments → "Automatic capture delay" controls whether payments are automatically captured after authorization.

- **Auto-capture (recommended)**: Payment goes `authorized → captured` immediately. `payment.captured` webhook fires.
- **Manual capture**: Payment stays in `authorized` state. YOU must call `razorpay.payments.capture()` within 5 days or the authorization expires and money is never collected.

**The trap**: Test mode auto-captures regardless of this setting. You won't discover manual capture is on until you go live and customers pay but `payment.captured` webhooks never fire.

**Check**: Dashboard → Settings → Payments. Set to "Auto-capture immediately" for subscription billing.

## Rate Limits

Razorpay rate limits are **undocumented** but observed behavior:
- ~25 requests per second across all endpoints (shared)
- Exceeding returns HTTP `429` with no `Retry-After` header
- Back off with exponential delay (1s, 2s, 4s)
- Pagination: max 100 items per request (enforced)
- Batch operations: space sequential creates by 100-200ms

```typescript
// Simple rate-limit-safe wrapper
async function rateSafeCall<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (err.statusCode === 429 && i < retries - 1) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Rate limit retries exhausted");
}
```

## Serverless Race Conditions (Duplicate Subscriptions)

In serverless environments (Vercel, AWS Lambda), two concurrent function invocations can create duplicate subscriptions:

```
User double-clicks "Subscribe" →
  Request A: reads DB (no sub) → creates Razorpay subscription
  Request B: reads DB (no sub) → creates Razorpay subscription (DUPLICATE!)
```

**Fix**: Use a database-level unique constraint or advisory lock:

```typescript
// Option 1: Unique constraint + catch conflict
try {
  await db.insert(subscriptions).values({
    userId: user.id,
    status: "created",
    // ... other fields
  });
} catch (err: any) {
  if (err.code === "23505") { // Unique violation (Postgres)
    // Another request already created — return existing
    const existing = await getSubscriptionByUserId(user.id);
    return Response.json({ shortUrl: existing.shortUrl });
  }
  throw err;
}

// Option 2: SELECT FOR UPDATE (if using transactions)
const existing = await db.execute(
  sql`SELECT * FROM subscriptions WHERE user_id = ${userId} AND status IN ('created', 'active') FOR UPDATE`
);
```

## Payment Succeeded But Webhook Never Arrived

This happens when: your server was down, DNS failed, or Razorpay's retries all timed out.

**Recovery pattern**: Build a reconciliation endpoint that syncs with Razorpay API:

```typescript
// app/api/billing/sync/route.ts — call via cron or manual trigger
export async function POST(request: Request) {
  const user = await getAuthenticatedUser(request);
  const dbSub = await getSubscriptionByUserId(user.id);
  if (!dbSub) return Response.json({ synced: false });

  // Fetch ground truth from Razorpay
  const rzpSub = await razorpay.subscriptions.fetch(dbSub.razorpaySubscriptionId);

  if (rzpSub.status === "active" && dbSub.status !== "active") {
    // Razorpay says active but our DB doesn't — webhook was lost
    await updateSubscriptionStatus(dbSub, "active", rzpSub, null);
    return Response.json({ synced: true, action: "activated" });
  }

  return Response.json({ synced: true, action: "none" });
}
```

**Run this on a cron** (every 5-15 minutes) to catch any missed webhooks.

## Error Handling

### Error Shape Inconsistency
```typescript
// Some endpoints return:
{ error: { code: "BAD_REQUEST_ERROR", description: "..." } }

// Others return:
{ statusCode: 400, error: { ... } }

// Handle both:
const errorCode = err.error?.code || err.statusCode;
const errorMsg = err.error?.description || err.message;
```

### Cancelling Already-Cancelled Subscriptions
- Returns `BAD_REQUEST_ERROR` with description mentioning "already cancelled"
- Treat this as success (idempotent cancel)
- Wrap in try/catch and check error code

## Plan Management

### Plan IDs Are Environment-Specific
- Test mode plans (`plan_test_xxx`) don't exist in live mode
- Live mode plans (`plan_live_xxx`) don't exist in test mode
- You need separate plan IDs for test and production

### No Reverse Lookup API
There is no Razorpay API to look up which plan corresponds to a plan ID. You must maintain a bidirectional mapping in your env vars or database.

### `total_count` is Max Renewals
- Monthly plan with `total_count: 60` = runs for up to 5 years
- Yearly plan with `total_count: 5` = runs for up to 5 years
- This is a maximum, not a commitment

## GST Notes

### SAC Code
Do not hardcode one here. This repo's SAC codes are project constants in
`lib/payments/payouts/constants.ts` — `999293` for consulting, `999294` education,
`999295` training — and `OrganizationInvoice.hsnCode` defaults to `999293`. Derive from
those constants so invoices, payouts and generated code cannot drift apart. (`998314`,
"information technology design and development services", is the code generic SaaS advice
reaches for; it is the wrong family for a consulting marketplace.)

### Tax-Inclusive Plans
When creating plans with `tax_inclusive: true`, the `amount` field is the total customer pays (including GST). To calculate the breakout:
```
base = amount / 1.18
gst = amount - base
cgst = gst / 2
sgst = gst - cgst  (handles odd paise rounding)
```

## GST and Invoice Reality

### Razorpay Does NOT Handle GST on Subscriptions
Razorpay charges the plan amount as-is. If your plan is 49900 paise (Rs 499), Razorpay charges exactly 49900 paise. It does NOT automatically add GST on top, nor does it break out GST components. YOU must:
- Calculate GST yourself (18%), with the SAC code taken from `lib/payments/payouts/constants.ts`
- Either set plan price as GST-inclusive (Rs 499 includes GST, base = 499/1.18 = Rs 422.88)
- Or set plan price as base and add GST on top when displaying to the user

### Invoices Must Be Created via the Invoice API Separately
Razorpay Invoices are a **separate API entity** from subscription payments. Key facts:
- You must create invoices via `razorpay.invoices.create()` — they are NOT auto-generated by subscription charges
- Invoices have their own `line_items` array (each with `name`, `amount`, `currency`, `quantity`)
- Each invoice exists independently alongside the subscription — they are separate entities in Razorpay
- Invoice has fields: `type` ("invoice" or "link"), `customer_id`, `line_items`, `notes`
- Use separate line items for base amount, CGST, and SGST to produce proper GST invoices

### Subscriptions and Invoices Are Independent Entities
Your database should track both as separate tables:
- **subscriptions table**: tracks the Razorpay subscription lifecycle (created, active, cancelled, etc.)
- **invoices table**: tracks Razorpay Invoice API invoices you create (not just internal GST calculations)
- A subscription can have many invoices (one per billing cycle)
- An invoice links to both a `payment_id` AND a `subscription_id`

### Subscriptions Cannot Be Overwritten — Both Coexist
When you create a new subscription (e.g., plan change), the old one still exists in Razorpay. Both exist simultaneously until the old one is explicitly cancelled. Database implications:
- Multiple subscription rows per user are **normal and expected**
- Access checks should look for ANY active subscription, not assume one-to-one
- Old subscriptions should be marked as cancelled in the DB but never deleted
- Never DELETE subscription records — only mark them cancelled
