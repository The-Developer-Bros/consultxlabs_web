---
title: Payment webhooks (inbound)
band: 10-money-and-ledger
audience: sde3
status: live
last-reviewed: 2026-06-05
---

# Payment webhooks (inbound)

**What this covers:** the **inbound** gateway webhooks (Razorpay → us) that mutate money state — captures, refunds, payouts, and disputes — from signature verification through to the handlers that move the ledger. This is the opposite direction from the org-facing **outbound** webhook product (us → an org's HRIS/ERP), which is documented in [outbound webhooks](../40-compliance-and-data/04-outbound-webhooks.md); do not confuse the two — inbound webhooks are how money truth *arrives*, outbound webhooks are how lifecycle events *leave*.

The inbound pipeline is the authoritative source of asynchronous money state: a synchronous gateway API response is only an acknowledgement, and the real outcome (`processed`, `failed`, `won`, `lost`) always arrives here by webhook.

---

## 1. The ingestion pipeline

A Razorpay webhook enters at the route `app/api/webhooks/razorpay/route.ts`, is verified and deduplicated synchronously, then dispatched asynchronously so the route can return HTTP 200 inside Razorpay's 5-second timeout. The dispatch switch itself lives in a Next-agnostic module, `app/api/webhooks/razorpay-dispatch.ts`, so the stuck-event sweeper can replay through the exact same handler routing.

```mermaid
sequenceDiagram
    autonumber
    participant RZP as Razorpay
    participant Route as /api/webhooks/razorpay
    participant Verify as verifyWebhookSignature
    participant Log as logWebhookEvent
    participant Disp as processRazorpayWebhookEvent
    participant H as handlers (utils.ts)

    RZP->>Route: POST + x-razorpay-signature
    Route->>Verify: HMAC-SHA256(body, secret), timing-safe compare
    alt invalid signature
        Verify-->>Route: false (payout.* may retry with RazorpayX secret)
        Route-->>RZP: 400 + record WEBHOOK WARN
    end
    Route->>Route: isDbHealthy? else 503 (gateway retries)
    Route->>Log: eventId = eventType:entityId — insert WebhookEvent
    alt duplicate eventId
        Log-->>Route: isNew=false
        Route-->>RZP: 200 { duplicate: true }
    end
    Route-->>RZP: 200 (immediately)
    Route->>Disp: after() callback (async)
    Disp->>H: switch(eventType) → handler
    H->>Disp: markWebhookEventProcessed (records error on failure)
```

The first stage is **signature verification**. `verifyWebhookSignature` (`app/api/webhooks/utils.ts`) computes `HMAC-SHA256(rawBody, RAZORPAY_WEBHOOK_SECRET)` as hex, validates the incoming signature is exactly 64 hex chars and equal length, and compares with `crypto.timingSafeEqual` so the check cannot be timed. The pattern, condensed:

```ts
const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
if (signature.length !== 64) return { isValid: false, body };
const sigBuf = Buffer.from(signature, "hex");
const expectedBuf = Buffer.from(expected, "hex");
if (sigBuf.length !== expectedBuf.length) return { isValid: false, body };
return { isValid: crypto.timingSafeEqual(sigBuf, expectedBuf), body };
```

A failed verification is rejected with HTTP 400 and recorded as a `WEBHOOK` warning (repeated failures are a tamper/misconfig signal). For `payout.*` events only, the route re-verifies with a separate `RAZORPAYX_WEBHOOK_SECRET` when the main secret fails, since RazorpayX may sign with its own key. After verification the route runs a lightweight `isDbHealthy` probe and returns 503 if the database is unreachable, so the gateway retries rather than dropping the event.

The second stage is **persistence and dedup**. The route builds a composite `eventId` of the form `eventType:entityId` — pulling the entity id from `payload.{payment|order|refund|dispute|payout}.entity.id`, falling back to `account_id` or a SHA-256 of the body — so a `payment.captured` and a `refund.created` for the same entity never collide on one idempotency key. `logWebhookEvent` then upserts a `WebhookEvent` row keyed on the unique `eventId`; a duplicate returns `isNew=false` and the route answers 200 with `{ duplicate: true }` without processing.

The third stage is **asynchronous dispatch**. The route returns 200 immediately and runs `processRazorpayWebhookEvent` in Next's `after()` callback, which switches on `eventType` to the right handler and, in its `finally`, calls `markWebhookEventProcessed` to stamp success or record the handler error for retry.

The **replay path** exists because the `after()` callback runs *after* the 200 is sent: if the process crashes mid-callback the `WebhookEvent` row is left `processed=false, error=null` and the gateway, having seen the 200, never retries. The `sweep-stuck-webhook-events` cron (`jobs/cleanup/sweep-stuck-webhook-events.ts`, ~every 10 minutes) finds those rows older than ~6 minutes (but younger than 72 hours), reconstructs an envelope, and re-drives them through the same `processRazorpayWebhookEvent`. Because the handlers are idempotent, the replay either completes the side effects (recovered) or stamps the error (surfaced for review). The same `processed=false, error=null` shape is also produced deliberately by a defer-sentinel handler: a Razorpay refund webhook that arrives **before** its payment is captured is deferred (left unprocessed) rather than failed, so the sweeper re-drives it once the capture lands instead of losing it permanently. To stop an unknown payment from churning forever, the sweeper terminally caps a deferred event once it ages past `giveUpAfterHours` (7 days), stamping it processed with a "gave up: payment never arrived" error (#813).

---

## 2. Idempotency design

The pipeline survives at-least-once delivery, concurrent workers, and cron re-drives because money state is protected at three independent layers, each making a retry a no-op.

`WebhookEvent.eventId` is `@unique` and is the **first** gate: a redelivered event with the same `eventType:entityId` is caught by `logWebhookEvent`, which returns `isNew=false` and skips processing entirely. (The three-state machine on `processed`/`error` also lets a *failed* attempt be retried while a successfully-processed one stays skipped, and a >5-minute in-progress row is treated as abandoned and re-eligible.)

`Refund.cascadedAt` is the **second** gate, for the refund side effects specifically. `applyRefundCascade` claims it `null → now()` with a conditional `updateMany` and no-ops if the claim count is zero, so even if the same refund arrives by webhook, by the backstop cron, and by an app call at once, exactly one runs the earnings/leg/wallet/ledger reversal. See [refunds §2](10-refunds.md).

`LedgerTransaction.idempotencyKey` is the **third** gate, at the money-movement layer. Every posting carries a per-flow key (`refund:<refundId>`, `topup-refund:<paymentId>`, `chargeback:<disputeId>`, `invoicepaid:<invoiceId>`), and `postLedgerTxn` returns `created=false` on a duplicate key without writing a second journal entry — so even a handler that runs twice posts money once. The [money model overview §4a](01-money-model-overview.md) explains why keys are per-flow rather than per-request.

---

## 3. Event catalog

The table below lists the Razorpay events the dispatcher consumes, grouped by domain, with the handler outcome for each. Events the gateway emits that we do **not** consume are listed afterward.

| Domain | Event | Handler outcome |
| --- | --- | --- |
| payment | `payment.captured` | Route by `notes.type`: org top-up → `confirmTopUp`, invoice → mark `PAID`, overage → overage handler, else B2C `handlePaymentSuccess`. |
| payment | `order.paid` | Same routing as `payment.captured` but at the order level (no payment id); the org top-up branch defers to `payment.captured`. |
| payment | `payment.failed` | Org top-up → delete pending placeholder; invoice → clear stored order id for retry; else B2C `handlePaymentFailure`. |
| refund | `refund.created` | Resolve `payment_id` → `order_id`, then `handleRefundCreated` (status `created`/`pending` → `PENDING`). If the underlying payment is not yet captured, the event is **deferred** (left unprocessed) and re-driven by the stuck-event sweeper rather than lost (#813). |
| refund | `refund.processed` | `handleRefundCreated` with status `processed` → `SUCCEEDED`, runs `applyRefundCascade`. Same before-capture deferral applies. |
| refund | `refund.failed` | `handleRefundCreated` with forced status `failed` → `FAILED`. |
| refund | `refund.speed_changed` | **Log-only** — no state change (see below). |
| dispute | `payment.dispute.created` | `handleDisputeCreated`: create `Dispute`, hold earnings, map `open` → `NEEDS_RESPONSE`. |
| dispute | `payment.dispute.won` | `handleDisputeUpdated(id, "won", null)` → `WON`, release held earnings. |
| dispute | `payment.dispute.lost` | `handleDisputeUpdated(id, "lost", null)` → `LOST`, refund earnings + org chargeback. |
| dispute | `payment.dispute.closed` | `handleDisputeUpdated(id, status, null)` — but `closed` mis-maps (see below). |
| payout | `payout.processed` / `reversed` / `rejected` / `queued` / `pending` / `cancelled` | `handleRazorpayPayoutWebhook`: org payout reconciler first, else consultant payout path. |

The events the gateway emits but the dispatcher does **not** consume — falling through to the dispatcher's `default` ("Unhandled Razorpay event type") — are:

- `refund.speed_changed` is technically consumed but **log-only**: we discard `speed_requested`/`speed_processed` and the fee credit-back. 🟡 Material for support/finance only — see [refunds §3](10-refunds.md).
- `payout.updated` has no case; intermediate payout updates are dropped and we wait for a terminal `payout.*`. Low impact.
- `payment.dispute.under_review` has **no dispatch case** at all. 🟡 Material: a contested dispute never advances to `UNDER_REVIEW` in our records — see [disputes §4, Gap 2](11-disputes.md).
- `payment.dispute.action_required` has **no dispatch case** at all. 🟡 Material: a deadline-bearing "more documents needed" signal is silently dropped, risking auto-loss — see [disputes §4, Gap 3](11-disputes.md).

Separately, `mapDisputeStatus` has no `closed` case, so `payment.dispute.closed` (which *is* dispatched) mis-maps a terminal dispute to `NEEDS_RESPONSE`. 🟡 See [disputes §4, Gap 1](11-disputes.md).

---

## 4. Payment status machine

`PaymentStatus` (`prisma/schema.prisma`) has four values, and the webhook events drive the transitions between them.

```mermaid
stateDiagram-v2
    [*] --> PENDING: order created at checkout
    PENDING --> SUCCEEDED: payment.captured / order.paid
    PENDING --> FAILED: payment.failed
    PENDING --> EXPIRED: checkout TTL elapses (no capture)
    SUCCEEDED --> [*]
    FAILED --> [*]
    EXPIRED --> [*]
```

A `Payment` is created in `PENDING` when checkout creates the gateway order. A successful capture (`payment.captured` or `order.paid`) flips it to `SUCCEEDED` via `handlePaymentSuccess`; a gateway failure (`payment.failed`) flips it to `FAILED` via `handlePaymentFailure`. `EXPIRED` is not driven by a webhook but by the **checkout TTL**: an order that is never captured before its time-to-live elapses is expired by cleanup rather than by a gateway event. Only a `SUCCEEDED` payment is refundable — `refundPayment` rejects any payment not in `SUCCEEDED`.

---

## 4a. The gateway payment id, and why a refund used to need a network call

Razorpay's `Payment.paymentIntent` column holds the **order** id (`order_…`), because that is what checkout creates and what the capture events name. Refund and dispute webhooks, however, identify their subject by the **payment** id (`pay_…`), and until #1353 nothing on our side stored one. The dispatcher therefore had to translate: for every `refund.*` event it called `payments.fetch(payment_id)` purely to read back the `order_id`. When that call failed — a gateway blip, an expired credential, a cold instance timing out — the dispatcher passed the `pay_…` id through unchanged, `handleRefundCreated` looked it up against `paymentIntent`, found nothing, and returned a `DeferSignal`. The event then sat unprocessed while the stuck-event sweeper re-drove it for up to seven days against a payment that had been captured all along.

`Payment.gatewayPaymentId` closes that. The confirmation pipeline persists the `pay_…` id at capture, in the same Phase 1 update that flips the row to `SUCCEEDED` — ADR 21 already makes that the single writer of the payment's capture truth, and the gateway id is part of that truth, so no second writer is introduced. The column is unique, so two Payment rows can never claim the same gateway capture.

Downstream, `handleRefundCreated` and `handleDisputeCreated` resolve their payment with one `findFirst` whose `OR` accepts **either** id, and the dispatcher now reads our own row first and calls `payments.fetch` only when the database has never seen that capture. The gateway call is a fallback for rows written before this change, not the only path. For disputes the benefit is larger still: a failed lookup used to mean the dispute could not be linked to a payment at all, which raised a `CRITICAL_DISPUTE_UNLINKED` page and left disputed earnings payable until the six-hourly reconcile cron noticed.

## 4b. State-as-outbox for the post-capture legs

Some of what a capture owes the buyer cannot happen inside the confirmation transaction. Creating their Stream chat channel is outbound network work, so it runs after the commit and is deliberately not awaited. That made it invisible when it failed: a crash or a Stream outage in that window left a confirmed, paid booking with no conversation, and the only trace was a Sentry event.

Rather than introduce a queue table, the row that already records the work carries the completion stamp. `Appointment.chatChannelEnsuredAt` is written only once the channel calls have actually returned, which turns "confirmed, paid, and still `NULL`" into an exact query for the work that was lost. `reconcile-orphaned-confirmations` runs that query as its second pass and calls back into the same `ensureChannelsForAppointment` the live path uses. `WebhookEvent.deferCount` is the same idea one layer up: a deferral leaves the row looking exactly like a crash, so counting the deferrals is the only mark that path leaves behind, and it is what the sweeper alerts on. This is the pattern ADR 27 describes in full.

## 5. Monitoring and archival

Three concerns keep the inbound pipeline observable and bounded: replay of crashed events, archival of old rows, and alerting on verification failures.

The **stuck-event sweeper** (`sweep-stuck-webhook-events`, §1) is the primary recovery mechanism — it re-drives `processed=false, error=null` events that an `after()` crash left behind, which would otherwise become the highest-blast-radius zombies (PAID money with an ISSUED invoice, uncredited top-ups, unpersisted chargebacks). The sweeper also drains the deliberate before-capture deferrals (a `refund.created`/`refund.processed` whose payment is not yet captured), giving each one up to a 7-day `giveUpAfterHours` window before it is terminally capped so an unknown payment cannot churn indefinitely (#813). Its sister, the **archive cron** (`archive-webhook-events`, weekly), deletes processed events older than 30 days and failed/errored events older than 90 days, keeping the table lean while retaining failures long enough to debug. **Alerting** rides on the row state: a handler error is stamped on `WebhookEvent.error` (surfaced by the sweeper's `stillFailing` count), and a signature-verification failure is recorded as a `WEBHOOK` warning via `recordSystemEvent`, since repeated HMAC failures indicate tampering or a secret misconfiguration. Since #1356 a deferral is alertable too. Each time a handler answers with a `DeferSignal` the dispatcher increments `WebhookEvent.deferCount`, and the sweeper raises one Sentry warning per run naming every event that has either deferred five times or been unprocessed for more than an hour. That closes the gap the seven-day give-up cap left: the cap is the point at which we abandon an event, not a point at which anybody is told about it. The org-relevant operator surfaces are absorbed from `docs/payments/webhooks/01-monitoring.md`.

---

### Related docs
- [Outbound webhooks](../40-compliance-and-data/04-outbound-webhooks.md) — the org-facing webhook *product* (us → external), the opposite direction from this doc.
- [Refunds](10-refunds.md) — the `refund.*` events and the cascade they trigger.
- [Disputes](11-disputes.md) — the `payment.dispute.*` events and the three dispatch/mapping gaps.
- [Ledger & postings](03-ledger-and-postings.md) — `postLedgerTxn` idempotency keys.
- B2C / gateway-generic details: [`docs/payments/webhooks/`](../../payments/webhooks/README.md).
- Ground truth: `app/api/webhooks/razorpay/route.ts`, `app/api/webhooks/razorpay-dispatch.ts`, `app/api/webhooks/utils.ts`, `jobs/cleanup/sweep-stuck-webhook-events.ts`, `jobs/cleanup/archive-webhook-events.ts`.

## The webhook is not the only path, but it is the only shape (ADR 21)

Three paths can observe that a Razorpay payment succeeded: this webhook, the
client's return from the checkout modal (`/api/checkout/verify-signature`), and
the on-demand sync (`/api/checkout/verify?sync=true`). All three now call the
same `routeCapturedPayment` in `app/api/webhooks/razorpay-dispatch.ts`, which
selects a handler from `notes.type` exactly as the webhook switch does.

None of them writes `Payment.paymentStatus` directly, and that restriction is
the whole point rather than a stylistic preference. `handlePaymentSuccess`
returns early when it finds a payment already `SUCCEEDED`, on the reasonable
assumption that the status implies the pipeline ran. The moment a second writer
can set that status without running the pipeline, the guard stops meaning "this
work is done" and starts meaning "this work will never be done" — and the
booking, the earnings, the `booking:<paymentId>` journal entry and the
capture-amount parity check are all skipped for a payment that was really
charged. ADR 21 records the full reasoning.

The practical consequence for a non-webhook caller is that it must fetch the
payment from Razorpay before routing. A signature proves the `(order_id,
payment_id)` pair is genuine but carries neither the captured amount nor the
notes, and both are needed. When that fetch fails, the caller reports
`pendingConfirmation` and leaves the work to the webhook; it must never fall
back to writing the status, because that reintroduces the defect.
