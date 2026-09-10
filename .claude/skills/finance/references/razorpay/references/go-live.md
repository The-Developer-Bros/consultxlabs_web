# Go-Live Checklist & Production Hardening

Use this guide before launching a Razorpay integration to production, or to harden an existing live integration.


## 1. Pre-Launch Checklist

Complete every item before going live:

- [ ] **CRITICAL: Verify auto-capture wasn't disabled** — Auto-capture is **ON by default** ("once your customer completes a payment, it is automatically moved to the captured state"). Confirm at Dashboard → Settings → Payments → "Automatic capture delay" (labelled Account & Settings → Payment Capture in some Dashboard versions). The Orders API `payment.capture` field (and per-order capture settings) override this dashboard default, so check both. If capture is off, payments stay `authorized` and webhook `payment.captured` never fires. <https://razorpay.com/docs/payments/payments/capture-settings/>
- [ ] **Authorized-but-uncaptured payments are auto-refunded after 3 days** — the capture-settings page is explicit and repeats it ("payments that are not captured within this period will be refunded automatically", "the maximum value (default) is 3 days"). Razorpay's own Payments FAQ still says 5 days; that is stale, build against 3. The auto-refund goes out at Normal speed, so the customer sees it in 5–7 working days. Don't leave payments sitting in `authorized`.
- [ ] Switch to live API keys (`rzp_live_` prefix)
- [ ] Create live plans (separate from test plans — test plan IDs don't work in live mode)
- [ ] Register webhook with production URL (HTTPS required, port 443)
- [ ] Set live webhook secret (different from test)
- [ ] Enable all needed webhook events
- [ ] Test with a real Rs 1 payment end-to-end
- [ ] Verify refund flow works in live mode (refunds take 5-7 business days in live, instant in test)
- [ ] Confirm settlement schedule — the standard domestic cycle is **T+2 working days** (T = capture date), where working days exclude Sundays, 2nd/4th Saturdays and bank holidays. **T+7 is the international cycle**, not a probation period for new merchants; there is no documented new-merchant T+7 default. <https://razorpay.com/docs/payments/settlements/>
- [ ] Remove all `console.log` of sensitive data
- [ ] Verify `.env` is in `.gitignore`
- [ ] Webhook route uses `runtime = "nodejs"` NOT edge (crypto module required)
- [ ] Set up error monitoring (Sentry, etc.)
- [ ] Set up reconciliation cron to catch missed webhooks (every 5-15 min)
- [ ] Add `processed_webhook_events` table for idempotency
- [ ] Complete KYC + activation — KYC approval and account activation are required before live payments work (~1–3 business days). International payments require domestic activation first, plus Video KYC (PA-CB / RBI requirement).


## 2. Security Hardening

### a. Rate Limiting the Webhook Endpoint

```typescript
// Razorpay sends from known IPs but rate limit anyway
// Simple in-memory rate limiter for webhook

const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 100;
const requestCounts = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = requestCounts.get(ip);

  if (!entry || now > entry.resetAt) {
    requestCounts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }

  entry.count++;
  return entry.count > MAX_REQUESTS;
}

// In your webhook handler:
export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for") ?? "unknown";
  if (isRateLimited(ip)) {
    return new Response("Too Many Requests", { status: 429 });
  }
  // ... signature verification and processing
}
```

> **Note**: For production at scale, use a distributed rate limiter (Redis-based) instead of in-memory.

### b. Validate Webhook Source

Signature verification is sufficient for authenticity. Additionally:

- Check `Content-Type` is `application/json` and reject non-JSON requests
- Return `400` early for malformed payloads before attempting signature verification

### c. Never Expose API Secret Client-Side

- Only `NEXT_PUBLIC_RAZORPAY_KEY_ID` should be public
- `RAZORPAY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` are **server-only**
- Never prefix secrets with `NEXT_PUBLIC_` in Next.js

### d. API Route Protection

- All billing routes (except webhook) must require authentication
- Webhook route must be exempt from auth middleware but **must verify signature**
- Use CSRF protection on billing mutation routes (plan changes, cancellations)

### e. Input Validation

- Validate `planKey` against allowed values — do not trust client input
- Validate amounts server-side for one-time payments
- Sanitize user input in `notes` fields before sending to Razorpay


## 3. Environment Variable Management

```
# .env.local (development)
RAZORPAY_KEY_ID=rzp_test_xxx
RAZORPAY_SECRET=test_secret
NEXT_PUBLIC_RAZORPAY_KEY_ID=rzp_test_xxx
RAZORPAY_WEBHOOK_SECRET=test_webhook_secret

# Production (Vercel/Railway/etc)
RAZORPAY_KEY_ID=rzp_live_xxx
RAZORPAY_SECRET=live_secret
NEXT_PUBLIC_RAZORPAY_KEY_ID=rzp_live_xxx
RAZORPAY_WEBHOOK_SECRET=live_webhook_secret
```

- **Never commit `.env` files** — ensure `.env*` is in `.gitignore`
- Use platform secrets management (Vercel env vars, Railway variables, AWS Secrets Manager, etc.)
- Rotate webhook secret periodically — update in both Razorpay Dashboard and your platform
- Use separate API key pairs for test and live modes


## 4. Error Monitoring Setup

Set up alerts for these critical scenarios:

- **Webhook processing errors**: Catch and report failures in event handlers
- **Signature verification failures**: Alert immediately — may indicate tampering
- **Elevated payment failure rates**: Monitor `payment.failed` event frequency
- **Webhook response times**: Must respond within 5 seconds (Razorpay timeout)
- **Subscription status distribution**: Track active vs churned vs paused ratios

```typescript
// Example: Sentry integration for webhook errors
import * as Sentry from "@sentry/nextjs";

try {
  await processWebhookEvent(event);
} catch (error) {
  Sentry.captureException(error, {
    tags: {
      event_type: event.event,
      subscription_id: event.payload?.subscription?.entity?.id,
    },
  });
  // Still return 200 to prevent Razorpay retries if error is non-transient
  // Return 5xx only for transient errors you want retried
}
```


## 5. Logging Best Practices

- **Do log**: Webhook event type, subscription ID, payment ID (for debugging)
- **Never log**: Full payment details, card numbers, API secrets, webhook secrets
- **Log signature verification failures** with request metadata (IP, headers) for investigation
- Use **structured logging** (JSON format) for easy filtering and alerting

```typescript
// Good
console.log(JSON.stringify({
  event: "webhook.received",
  type: payload.event,
  subscriptionId: payload.payload?.subscription?.entity?.id,
  timestamp: new Date().toISOString(),
}));

// Bad — never do this
console.log("Webhook payload:", JSON.stringify(payload));
console.log("Secret:", process.env.RAZORPAY_WEBHOOK_SECRET);
```


## 6. Database Considerations

- **Index properly**: Add indexes on `user_id`, `razorpay_subscription_id`, and `razorpay_customer_id` columns
- **Set up database backups** before launch — test restore process
- **Consider read replicas** if webhook volume is high (thousands of events/minute)
- **Add database connection pooling** — webhooks create concurrent connections

```sql
-- Essential indexes
CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_razorpay_id ON subscriptions(razorpay_subscription_id);
CREATE INDEX idx_payments_subscription_id ON payments(subscription_id);
CREATE INDEX idx_payments_razorpay_id ON payments(razorpay_payment_id);
```


## 7. Webhook Reliability

- **Return 200 within 5 seconds** — Razorpay times out after that
- For slow operations, **acknowledge immediately and process async** (queue pattern):

```typescript
export async function POST(req: Request) {
  // Verify signature first
  const isValid = verifySignature(body, signature);
  if (!isValid) return new Response("Invalid", { status: 400 });

  // Enqueue for async processing — respond immediately
  await queue.add("process-webhook", { event: body });

  return new Response("OK", { status: 200 });
}
```

- Set up a **dead letter queue** for failed webhook processing
- **Monitor for missing webhooks**: Compare Razorpay Dashboard event count vs your database records
- Razorpay retries failed webhooks — ensure your handler is **idempotent**


## 8. Scaling Considerations

- Webhook endpoint should be **stateless** — no in-memory state between requests
- Use **database-level locking** (optimistic locking with version columns) not in-memory locks
- Consider a **separate webhook worker** if processing is heavy — decouple ingestion from processing
- Razorpay may send **bursts of webhooks** (e.g., batch subscription renewals) — handle concurrency gracefully
- Use database transactions to prevent race conditions when updating subscription state


## 9. Compliance

- **GST invoices** required for Indian businesses
- **Store payment records for minimum 8 years** (Indian tax law)
- **PCI compliance**: Never store card details — Razorpay handles tokenization and PCI-DSS
- **Display pricing inclusive of GST** on your website
- Include the **SAC code from `lib/payments/payouts/constants.ts`** (`999293` consulting, `999294` education, `999295` training) — never a hardcoded literal, or invoices and payouts drift apart
- Provide clear cancellation and refund policies on your website
