---
name: razorpay
description: Work on this repo's Razorpay integration — orders and checkout, webhooks, refunds, disputes, RazorpayX payouts, GST invoicing, going live and debugging. Use when the user says "razorpay", "payment not captured", "webhook not firing", "signature mismatch", "issue a refund", "refund stuck pending", "chargeback/dispute", "payout failed", "GST invoice", "test cards", or is touching anything under lib/payments/ or app/api/webhooks/razorpay.
argument-hint: "[orders|webhooks|refunds|disputes|payouts|gst|go-live|testing|debug]"
---

# Razorpay

Load the reference file for the task at hand — do not read them all. Every file is
grounded in this repo's real integration and cites Razorpay's docs where a claim is
non-obvious.

## Route by task

| The task | Read |
|---|---|
| Anything, first time in a session | `references/this-repo.md` |
| Checkout, orders, payment verification, capture | `references/orders-and-checkout.md` |
| Webhook handler, signatures, event dedup, missed events | `references/webhooks.md` |
| Issuing/tracking refunds, refund stuck in PENDING | `references/refunds.md` |
| Chargebacks, `payment.dispute.*` | `references/disputes.md` |
| Consultant/org payouts, RazorpayX, fund accounts | `references/payouts-razorpayx.md` |
| GST invoices, CGST/SGST/IGST, place of supply, IRN | `references/gst-invoicing.md` |
| Querying the Razorpay API to inspect live state | `references/admin-queries.md` |
| Test keys, ngrok, test cards, end-to-end local run | `references/local-testing.md` |
| A symptom to diagnose | `references/debugging.md` |
| Production checklist, capture/settlement settings | `references/go-live.md` |
| "The SDK/API did something strange" | `references/api-quirks.md` |

`references/not-used-here/` documents Razorpay Subscriptions, plan changes, customer
portals, dunning, metrics and Stripe migration. That material is accurate, but **this
repo calls none of those APIs** — see the banner in each file before acting on it.

## The facts worth carrying without a file open

1. **Every amount is paise, everywhere.** ₹50 is `5000`. The DB stores paise as `BigInt`
   after the paise migration, and values pass through to Razorpay unconverted.
2. **HMAC uses the raw request body.** Parsing and re-serialising changes key order and
   breaks the hash. The webhook route reads the raw text before any JSON parse.
3. **The two signature formulas differ in field order.** Checkout is
   `HMAC(order_id + "|" + payment_id)`; a subscription would be
   `HMAC(payment_id + "|" + subscription_id)`. This repo only ever needs the first.
4. **Header is `X-Razorpay-Signature`**, and the webhook secret is a *different* secret
   from the API key secret.
5. **The code already exists.** `lib/payments/core/razorpay.ts` is the client,
   `app/api/webhooks/razorpay/route.ts` is the webhook. Extend them — never scaffold a
   parallel `lib/razorpay.ts`.

## Guardrails

- Never cache money truth. Balances, refund state and invoice totals are read live.
- Never mark a refund SUCCEEDED before the gateway confirms it. That bug shipped once
  (M1) and refunded nobody.
- Webhook handlers must be idempotent — delivery is at-least-once, and this repo
  re-drives stuck events through the same dispatcher from a sweeper script.
- Return 2xx from the webhook for events you do not handle. A non-2xx makes Razorpay
  retry with exponential backoff for 24 hours and then **disable the webhook**.
- Amounts, place of supply and tax splits are compliance surfaces. Changing them needs
  a test, not a "looks right".

## Verifying a change

`references/local-testing.md` has the full loop. The fast one: run the dev server, send
a signed webhook to `/api/webhooks/razorpay` with a script, and read back the
`WebhookEvent` row. Do not test money paths against the shared dev database by hand.
