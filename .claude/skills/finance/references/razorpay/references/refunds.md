# Refunds

Refunds are live in this repo. Read this before touching them — the flow has several
non-obvious invariants that were each added to fix a real money bug.

## The path a refund takes

`lib/payments/operations/refund.ts` → `createRefund` (`lib/payments/index.ts`) →
`createRazorpayRefund` (`lib/payments/core/razorpay.ts`).

`refundPayment()` is three phases, and the split is deliberate:

1. **Reserve.** In a Serializable transaction, create the `Refund` row as `PENDING` with a
   placeholder `refundId` of `pending_<uuid>`. This happens before any network call, so a
   crash mid-refund leaves a durable trace.
2. **Call the gateway.** Outside the transaction — external I/O must never sit inside a
   Serializable tx, and an SSI retry must not re-hit the gateway. On failure the
   placeholder row stays `PENDING`; the reconcile cron owns recovery from there.
3. **Settle.** Bind the real gateway refund id, then cascade the ledger/earnings effects.
   Binding happens *outside* the cascade transaction so that if the cascade rolls back,
   the row still points at the real refund and the webhook can complete it by id.

`Refund.cascadedAt` is an atomic claim stamp: exactly one caller flips it, so the cascade
can never run twice.

**Never mark a refund SUCCEEDED before the gateway confirms.** That bug (M1) shipped once
— refunds were marked succeeded while no card was ever credited.

## Two things about the ids

`Payment.paymentIntent` holds the Razorpay **order** id, but refunds are created against a
**payment** id. So `createRazorpayRefund` starts with `orders.fetchPayments(orderId)` and
picks the **captured** payment — never `items[0]`, which can be an earlier failed attempt
on the same order (PM-12).

## Idempotency: why refund creation bypasses the SDK

A network error between us and Razorpay is ambiguous — the refund may or may not have
landed. Retrying blindly can debit the payer twice. Razorpay's answer is the
`X-Refund-Idempotency` header: send the same key and it returns the *original* refund
instead of issuing a second one. It works on both the Normal and Instant refund APIs.

**razorpay-node cannot send that header at all.** Not per-request, not per-client — `lib/api.js`
hard-whitelists the headers it will pass:

```js
var allowedHeaders = {
  "X-Razorpay-Account": "",
  "Content-Type": "application/json"
};
```

`getValidHeaders()` silently drops everything else, and `API.post()` has no per-request
config argument to smuggle one through. (A commonly repeated claim is that the third
argument to `payments.refund()` is treated as a callback — true, but it understates the
problem: even a constructor-level header would be dropped.) So `postRefund()` in
`lib/payments/core/razorpay.ts` issues a raw `POST /v1/payments/:id/refund` with Basic
auth. The order/payment lookup still uses the SDK.

The key rules, from the docs: at least 10 characters, and only letters, digits, hyphens
and underscores.

**Choose the key carefully.** It must identify the *logical refund*, not the payment:

```ts
// WRONG — two legitimate partial refunds of ₹50 on the same payment collide, and
// the second silently returns the first refund instead of paying out again.
"X-Refund-Idempotency": `refund-${paymentId}-${amountPaise}`

// RIGHT — the Phase 1 reservation id. Minted before the gateway call, unchanged on
// the error path, unique per logical refund.
idempotencyKey: reserved.id
```

`createRazorpayRefund` sends the header only when the caller supplies a key. No key is
safer than a guessed one.

Two responses to expect, and Razorpay answers both of them with a **409**. When another
request carrying the same key is still in flight, the description reads "still in
progress" and the conflict is retryable: `postRefund` retries once before giving up to the
reconcile cron with `REFUND_IN_FLIGHT`. When the same key is replayed with a *different*
payload, the description reads "Different request with the same idempotency key has
already been processed" and no amount of retrying will change the answer, so `postRefund`
throws it immediately as `REFUND_IDEMPOTENCY_KEY_REUSED` — a key collision is our bug, not
the gateway's. The `receipt` field also acts as a secondary idempotency key ("Duplicate
receipt found for this refund request").

Sources: <https://razorpay.com/docs/api/refunds/normal-refunds-idempotent/> ·
<https://razorpay.com/docs/api/refunds/instant-refunds-idempotent/> ·
<https://github.com/razorpay/razorpay-node/blob/master/lib/api.js>

## Status and speed

The refund lifecycle is `pending` → `processed`, or `pending` → `failed`. Those three are
the only statuses Razorpay returns — there is no `created` or `initiated`.

They map onto the `RefundStatus` enum through `mapRazorpayRefundStatus`. Note there are
**three copies** of this mapping in the repo — here, `mapRefundStatus` in
`app/api/webhooks/utils.ts`, and `mapGatewayRefundStatus` in
`scripts/refunds/reconcile-pending-refunds.ts`. Change one, check the others.

Speed is two separate fields and they are easy to conflate:

| Field | Values | Meaning |
|---|---|---|
| `speed` (request) | `normal` (default), `optimum` | what you asked for |
| `speed_requested` | `normal`, `optimum` | what Razorpay recorded you asking for |
| `speed_processed` | `normal`, `instant` | how it actually settled |

`optimum` requests an instant refund — money back in minutes, for an extra fee — but it
can still fall back to `normal`, which is what `refund.speed_changed` tells you. `optimized`
is not a value; it does not exist. **This repo never sends `speed`**, so every refund is
`normal`.

## Webhook events

The events are top-level `refund.*`. There is no `payment.refund.*` family — a handler
registered on those names silently processes zero refund webhooks.

| Event | When | What this repo does |
|---|---|---|
| `refund.created` | Refund initiated | `handleRefundCreated` |
| `refund.processed` | Money returned to the customer | `handleRefundCreated` |
| `refund.failed` | Refund failed | `handleRefundCreated(..., "failed", ...)` |
| `refund.speed_changed` | Razorpay re-evaluated the speed | logged only — the repo never requests `optimum`, so there is nothing to reconcile |

Dispatch lives in `app/api/webhooks/razorpay-dispatch.ts`; the handler is
`handleRefundCreated` in `app/api/webhooks/utils.ts`. Because the DB stores order ids, the
handler resolves `payment_id → order_id` via `payments.fetch()` first, then branches three
ways: B2C `Payment`, enterprise `WalletTopUp` (by `providerPaymentId`), enterprise
`OrganizationInvoice` (by `providerPaymentId`).

Delivery is at-least-once, so the handler must stay idempotent — key on the gateway refund
id, never on "have I seen a refund for this payment".

Source: <https://razorpay.com/docs/webhooks/refunds/>

## Stuck in PENDING

`scripts/refunds/reconcile-pending-refunds.ts` picks up refunds older than an hour,
matches them against the gateway (with a 5-minute amount/time window for rows still
carrying a `pending_` placeholder), and fails them after 24 hours — which fires
`notifyRefundFailed` to the payer. If a refund is stuck, check that cron before suspecting
the gateway.

## Gotchas

1. **Amounts are paise.** A ₹50 refund is `amount: 5000`.
2. **API auth uses `RAZORPAY_SECRET`**, not the webhook secret. `RAZORPAY_WEBHOOK_SECRET`
   only verifies inbound signatures, and they are different values.
3. **Refunds cannot exceed the payment.** The sum of all refunds is capped at the original
   amount; Razorpay rejects the overage. Validate before calling — this repo does, in
   `refundPayment`.
4. **Six-month window.** Razorpay refuses refunds on payments older than six months.
5. **Test mode is not a timing guarantee.** Test-mode refunds usually process immediately,
   but that is undocumented; live `normal` refunds take 5–7 business days. Never build a
   flow that assumes instant — react to `refund.processed`.
6. **An open dispute blocks a refund.** `refundPayment` throws
   `REFUND_BLOCKED_BY_DISPUTE`; resolve the dispute first. Refunding a disputed payment
   can mean paying twice.
