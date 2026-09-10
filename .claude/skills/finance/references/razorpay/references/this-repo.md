# The Razorpay integration in this repo

Read this before changing anything. Most Razorpay material on the internet — and most of
what an LLM has memorised — assumes a SaaS built on Razorpay Subscriptions. This repo is
not that, and acting on the generic pattern produces code that duplicates what already
exists.

## What this app actually uses

| Razorpay surface | Used? | Where |
|---|---|---|
| Orders API (one-time payments) | Yes | `lib/payments/core/razorpay.ts` |
| Payment verification (HMAC) | Yes | `app/api/checkout/verify-signature/route.ts` |
| Refunds API | Yes | `createRazorpayRefund` in `lib/payments/core/razorpay.ts` |
| Webhooks | Yes | `app/api/webhooks/razorpay/route.ts` + `razorpay-dispatch.ts` |
| Disputes (webhook-only) | Yes | all six `payment.dispute.*` events |
| RazorpayX Payouts | Yes | `lib/payments/payouts/razorpay-payouts.ts` |
| Subscriptions / Plans / Addons | **No** | in-house recurring billing instead |
| Invoices API | **No** | GST invoices are generated in-house |
| Payment Links, Virtual Accounts, Smart Collect | **No** | — |
| Settlements API, Route/Transfers | **No** | — |

`grep -ril razorpay src/` returns nothing: there is no `src/` directory. Routes live at
the repo root under `app/`.

## The client

`lib/payments/core/razorpay.ts:18-30`

```ts
const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_SECRET;   // not RAZORPAY_KEY_SECRET (drift-ok)
```

Two things to know. The secret env var is **`RAZORPAY_SECRET`** — the name every generic
tutorial gets wrong. And `razorpayClient` is **nullable**: it is built at module load and
returns `null` when either var is missing, so every call site null-guards and throws
`PaymentError("RAZORPAY_NOT_INITIALIZED")`. Do not add a non-null assertion.

Client-side the key is `NEXT_PUBLIC_RAZORPAY_KEY_ID`, consumed by
`app/checkout/components/RazorpayCheckout.tsx`.

RazorpayX has its own credentials — `RAZORPAYX_KEY_ID`, `RAZORPAYX_KEY_SECRET`,
`RAZORPAYX_ACCOUNT_NUMBER`, `RAZORPAYX_WEBHOOK_SECRET` — each falling back to the
matching `RAZORPAY_*` var when unset.

The pinned SDK is `razorpay@^2.9.6`. Only these surfaces are used anywhere:
`orders.create`, `orders.fetch`, `orders.fetchPayments`, `payments.fetch`,
`payments.fetchMultipleRefund`, `refunds.fetch`. Refund *creation* deliberately bypasses
the SDK — see `refunds.md`.

## Payment identity — the thing that trips people up

`Payment.paymentIntent` stores the Razorpay **order** id (`order_…`), not the payment id
(`pay_…`). Refunds, however, are created against a *payment* id. So every refund path
starts with `orders.fetchPayments(orderId)` and resolves the payment from there — and it
must pick the **captured** payment, not `items[0]`, because an order can carry earlier
failed attempts (PM-12, regression-tested in
`__tests__/payments/razorpay-refund-target.test.ts`).

## Gateway routing

`lib/payments/gateway-router.ts` sends effectively everything to Razorpay — domestic, and
international via IBT, always settling INR. Stripe exists but is only selected on explicit
request. `createRefund` in `lib/payments/index.ts` routes by id prefix: `pi_`/`cs_` to
Stripe, `order_`/`pay_` to Razorpay, mock ids to the mock gateway.

## Prisma models

| Model | Note |
|---|---|
| `Payment` | `paymentIntent @unique` holds the order id; amounts are `BigInt` paise; `clientIdempotencyKey @unique`; `consumerStateCode` for place of supply |
| `PaymentLeg` | how a payment was funded — card, wallet, referral credit, invoice accrual, plus `_REVERSAL` counter-legs |
| `Refund` | `refundId @unique` holds the gateway id **or** a `pending_<uuid>` placeholder; `cascadedAt` is the atomic idempotency claim |
| `Dispute` | `disputeId @unique`, `dueBy`, `isChargeRefundable` |
| `WebhookEvent` | the dedup table — `eventId @unique`, `processed`, `error` |
| `OrganizationInvoice` | the GST document: `igstPaise`/`cgstPaise`/`sgstPaise`, `placeOfSupply`, `hsnCode`, IRN block |
| `OrganizationPayout`, `ConsultantPayout`, `PayoutAccount` | the payout chain |

There is a `Subscription` model, but it is a **booking-domain** concept — a multi-session
consultation package — and has nothing to do with Razorpay Subscriptions. Each one is paid
for with an ordinary one-off order. `BillingSubscription` is in-house enterprise seat
billing, invoiced by `jobs/billing/generate-subscription-invoices.ts` and paid through a
fresh Razorpay order.

## Tests that encode the invariants

- `__tests__/payments/razorpay-refund-target.test.ts` — captured-payment targeting, receipt uniqueness
- `__tests__/payments/razorpay-refund-idempotency.test.ts` — `X-Refund-Idempotency`, 409 handling, status mapping
- `__tests__/payments/refund-operation.test.ts` — the two-phase reserve/settle contract
- `__tests__/payments/dispute-refund-correctness.test.ts`, `capture-amount-parity.test.ts`, `b2c-chargeback-ledger.test.ts`

Run them before and after touching a money path. From a worktree, jest needs its
`testPathIgnorePatterns` override — `jest.config.ts` ignores `/.claude/worktrees/`, which
matches the worktree itself.
