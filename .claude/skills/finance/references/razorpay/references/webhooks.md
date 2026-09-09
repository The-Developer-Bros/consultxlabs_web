# Webhooks

The handler already exists and is load-bearing. Read this before changing it —
several of its odder-looking decisions are deliberate and were paid for.

- Route: `app/api/webhooks/razorpay/route.ts`
- Dispatch switch: `app/api/webhooks/razorpay-dispatch.ts`
- Handlers: `app/api/webhooks/utils.ts`
- Envelope schemas: `schemas/webhooks/razorpay.ts`
- Sweeper: `scripts/cleanup/sweep-stuck-webhook-events.ts`

## Rules that are not negotiable

1. **Verify the signature before anything else**, over the **raw** body. Parsing and
   re-serialising changes key order and the HMAC will not match.
2. **Return 2xx for events you do not handle.** A non-2xx makes Razorpay retry with
   exponential backoff for 24 hours, after which it **disables the webhook** and emails
   the Alert Email Address. Reserve 5xx for genuinely transient failures you want retried.
3. **Idempotency is mandatory.** Delivery is at-least-once; the same event will arrive
   more than once.
4. **Never trust ordering.** Events for the same entity can arrive out of order or
   milliseconds apart.

## Signature verification

`verifyWebhookSignature` in `app/api/webhooks/utils.ts`: HMAC-SHA256 of the raw body
keyed with `RAZORPAY_WEBHOOK_SECRET`, compared with `timingSafeEqual` after a 64-character
length pre-check. The length check is not decoration — `timingSafeEqual` **throws** on a
length mismatch, so without it an attacker-controlled header turns a rejected signature
into a 500.

The webhook secret is a different value from the API key secret. Mixing them up is the
single most common cause of "signature invalid" (see `debugging.md`).

### The dual-secret fallback

RazorpayX payout events are signed with `RAZORPAYX_WEBHOOK_SECRET` but arrive at the same
endpoint. So the route verifies against the main secret first, and only if that fails
**and** the parsed event name starts with `payout.` does it re-verify against the X
secret. That ordering is the whole safety property: a non-payout event can never be
accepted by the X secret, so the fallback cannot widen the trust boundary. Repeated HMAC
failures are recorded via `recordSystemEvent({ category: "WEBHOOK", severity: "WARN" })` —
they are a tamper or misconfiguration signal.

## Dedup: `WebhookEvent`, and a synthesized event id

Razorpay sends `x-razorpay-event-id`, unique per event and stable across retries, which
makes it the natural dedup key. **This repo does not use it.** It synthesizes its own:

```
eventId = `${eventType}:${entityId}`
```

where `entityId` is the first non-null of the payment / order / refund / dispute / payout
entity id, then `account_id`, then `body_<sha256(rawBody)[0:16]}`. This dedups on the
*business fact* rather than the delivery, so two distinct deliveries describing the same
state transition collapse to one. If you change this, understand that you are changing
what "already processed" means.

`logWebhookEvent()` is a three-state machine over `processed` + `error`:

| Row state | Decision |
|---|---|
| `processed = true`, `error = null` | skip — genuinely done |
| `error != null` | reset and allow a retry |
| `processed = false`, `error = null` | in progress, skip — **unless** `receivedAt` is older than the 5-minute stale threshold, then allow a retry |

That stale window is what stops a process that died mid-handler from wedging the event
forever. A P2002 unique-violation race resolves to `{ isNew: false }`.

Handlers may also raise `DeferSignal`, meaning "the event is valid but the row it needs
isn't written yet". The dispatcher then skips `markWebhookEventProcessed`, leaving the
sweeper to re-drive it.

## Timing: return first, work after

Razorpay waits **5 seconds** for a 2xx. The route therefore verifies, health-checks,
logs the event and returns 200 synchronously, then does the actual work in Next.js
`after()`. If the database is unreachable it returns **503** instead — deliberately
inviting a retry rather than acknowledging an event it cannot record.

## Events handled

| Event | What happens |
|---|---|
| `payment.captured`, `order.paid` | routed on `notes.type`: `credit_purchase`/`invoice_payment` → org payment success; `overage_member` → overage success; otherwise B2C `handlePaymentSuccess` |
| `payment.failed` | the same three-way routing, failure side |
| `refund.created`, `refund.processed` | `handleRefundCreated` |
| `refund.failed` | `handleRefundCreated(..., "failed", ...)` |
| `refund.speed_changed` | logged only — this repo never requests `optimum` |
| `payment.dispute.*` (all six) | `handleDisputeCreated` / `handleDisputeUpdated` — see `disputes.md` |
| `payout.*` (7 events) | `handleRazorpayPayoutWebhook` — see `payouts-razorpayx.md` |
| anything else | logged and marked processed, 200 |

Deliberately **not** handled: `payment.authorized`, `subscription.*`, `invoice.*`,
`settlement.*`, `virtual_account.*`, `payment_link.*`, `transfer.*`, `refund.arn_updated`.
Adding one means adding a handler *and* an envelope schema.

Two naming traps: refund events are top-level `refund.*` (there is no `payment.refund.*`
family), and the subscription period field is `current_end` — `current_period_end` is
Stripe terminology and does not exist in Razorpay payloads.

## Payload handling

The envelope schema is intentionally loose — everything `.passthrough()` and optional —
because it only exists to extract ids. Strict schemas
(`razorpayPaymentCapturedEventSchema`, `razorpayOrderPaidEventSchema`,
`razorpayPaymentFailedEventSchema`) guard the handlers that actually read fields.

Payloads are scrubbed by `scrubWebhookPayload()` from `lib/logging/webhook-scrub.ts`
before anything is logged. Do not log a raw payload.

## Recovering missed events

**There is no self-serve replay button.** Razorpay replays an event only through a support
ticket: Dashboard → Help → Have a query? → Technical Support → "Issue regarding
Webhooks/API". The webhook must have been **enabled when the event fired** — otherwise the
event is gone for good — the event must be **≤15 days old**, and there is no bulk replay.

So recovery is owned by code here. `scripts/cleanup/sweep-stuck-webhook-events.ts`
re-drives rows still at `processed = false` through the same dispatcher — which is exactly
why the switch lives in the Next-agnostic `razorpay-dispatch.ts` rather than in the route.
For events that never arrived at all there is no row to sweep, so reconcile against the
API (`orders.fetch` / `payments.fetch`), as `app/api/checkout/verify/route.ts` already
does for the checkout path.

Sources: <https://razorpay.com/docs/webhooks/best-practices/> ·
<https://razorpay.com/docs/webhooks/faqs/>

## Testing

`app/api/dev/mock-webhook/route.ts` is a dev-only simulator. For a real signed request,
see the recipe in `local-testing.md` — the signature is HMAC-SHA256 of the exact bytes you
send, so generate it from the same string you POST.
