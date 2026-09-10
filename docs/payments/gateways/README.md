# Payment Gateways

> Overview of Familiarise's payment gateway integrations, selection logic, and configuration.

**Last Updated**: 2026-03-19

---

## Overview

Familiarise uses **Razorpay as the sole payment gateway** for both domestic and international payments:

| Gateway      | Region                    | Currency | Payouts Product   |
| ------------ | ------------------------- | -------- | ----------------- |
| **Razorpay** | India + International     | INR      | RazorpayX Payouts |

### Previously Evaluated

| Gateway | Status | Reason |
|---------|--------|--------|
| Stripe | **Still live — see the correction below** | Invite-only in India since May 2024, no UPI, 5–6% international fees |

This table used to record Stripe as removed. That is wrong, and it is the kind
of wrong that gets live payment code deleted, so it is corrected here rather
than quietly edited away. Stripe is a **live rail** today: the request→approve
booking flow hardcodes `PaymentGateway.STRIPE`
(`app/api/bookings/consultations/[consultationId]/route.ts` and its
subscriptions sibling), `lib/payments/core/stripe.ts` is a real client, and the
database holds 86 Stripe payments against 240 Razorpay ones. What is true is
that Stripe was rejected as the *primary* gateway and that new work should
route through Razorpay. Do not delete Stripe code on the strength of the word
"removed".

### Future Consideration

| Gateway | When | Why |
|---------|------|-----|
| **Dodo Payments** | Post-MVP, no timeline | Sanctioned second gateway. **Schema-only today** — see below. |
| Cashfree | Month 3-6 | Cheaper fees (1.6–1.95% vs 2%), better split fees (0.1% vs 0.25%) |
| Wise Business | International payouts | Best FX rates for paying international consultants |

### Dodo Payments — schema-only, deliberately

`DODO_PAYMENTS` exists as a `PaymentGateway` enum value and nothing else. There
is no client, no checkout path, no webhook handler and no payout submitter, and
there is no date attached to building any of them.

It is present so the enum does not have to change later — Postgres has no
`ALTER TYPE … DROP VALUE`, so adding a value costs nothing while removing one
costs a type recreation and swap. Keeping the value reserved is cheaper than
adding it under time pressure.

Because a schema value with no implementation is exactly the kind of thing that
gets picked up by a `default:` branch and silently used, it fails loudly
instead. `POST_MVP_GATEWAY_STUBS` in `lib/payments/constants.ts` names it, and
`lib/payments/validation/gateway-guards.ts` throws an `UnsupportedGatewayError`
if it ever reaches gateway routing, a refund, or a payout submitter. The payout
service also skips a stub-gateway account at *selection* time rather than at
disbursement, so a consultant's earnings stay `READY` for the next batch
instead of being claimed into `BATCHED` against a gateway that will never
exist.

**For a finance or CA review:** treat Dodo as not existing. No money has ever
moved through it, no fees are payable on it, and it appears in no reconciliation
or filing. The only live rails are Razorpay (primary, INR settlement) and Stripe
(the request→approve booking path).

### Who can transact, and from where

A decision, not merely an observation of the current code — confirmed
2026-07-29.

**Consultees: worldwide, and deliberately so.** International cards are
accepted, `routeGateway()` sends a non-IN buyer to Razorpay IBT, settlement is
INR, and the FIRC is generated automatically. This earns money today and should
not be restricted. The open item is evidentiary rather than functional: a
zero-rated export needs a billing address, an LUT, receipt in convertible
foreign exchange and a FIRC reference on file, and none of that is captured yet
(`lib/payments/tax/tax-engine.ts` carries the TODO). Buyer-country detection now
defaults to `IN` unless a country was explicitly asserted, so the error
direction is over-collection, which is recoverable.

**Consultants: India only, until Section 195 is built.** TDS is withheld under
Section 194-O, which applies to residents by definition. A non-resident
consultant needs Section 195 withholding, DTAA relief against a tax residency
certificate and Form 10F, and a Form 15CA/15CB filing per remittance — and
RazorpayX cannot pay a foreign bank account regardless. `processSinglePayout`
throws for a non-resident rather than half-paying, `lib/compliance/tds.ts` has
the DTAA engine written but unreachable (both callers hardcode
`residencyStatus: "RESIDENT"`), and `lib/compliance/form15.ts` is an
uncalled stub.

That throw is the correct behaviour and should not be "fixed" without building
the withholding path behind it. Removing it would produce a statutory
withholding failure rather than a feature. The constraint is surfaced to
consultants in the product by
`components/payouts/IndiaOnlyPayoutNotice.tsx`, shown during consultant
onboarding and again on the earnings page, so nobody discovers it only after
earning money they cannot withdraw.

### Not under consideration

Lemon Squeezy and XFlow were evaluated in March 2026 and rejected — Lemon
Squeezy prohibits services in its ToS and charges ~6.5%, and XFlow is
cross-border B2B settlement infrastructure rather than a gateway. Both were
removed from the codebase in #984. The dated analysis is preserved in
[gateway-evaluation-mar-2026.md](./gateway-evaluation-mar-2026.md) so the
decision is not re-litigated; neither is a current option.

> See [gateway-evaluation-mar-2026.md](./gateway-evaluation-mar-2026.md) for the full analysis.

---

## Gateway Selection

All payments route through **Razorpay**. Currency is always **INR** — Razorpay handles FX conversion for international payments via IBT (International Bank Transfer at 1% + GST).

**Gateway detection from payment IDs**:

| ID Prefix          | Gateway  |
| ------------------ | -------- |
| `order_` or `pay_` | Razorpay |

**Buyer location detection** determines tax treatment:
- Indian buyer → Plan price + 18% GST
- International buyer → Plan price only (zero-rated export)

**Source files**:

- Gateway enum and checkout schema: `schemas/checkout.ts`
- Gateway display names and descriptions: `app/checkout/plans/utils.ts`
- Gateway routing/detection logic: `lib/payments/index.ts`

---

## Razorpay Features

| Feature | Details |
| ------- | ------- |
| **Checkout** | Order → Modal (client-side SDK) |
| **Refunds** | Full API (create, get, list). Original PG fee NOT reversed. |
| **Disputes** | Webhook-only (no API management). ~Rs 500/chargeback. |
| **Payouts** | RazorpayX: Contacts + Fund Accounts + Payouts API, auto-TDS |
| **KYC** | Platform collects data, creates accounts via API |
| **Payment methods** | Cards, UPI (0%), Net Banking, Wallets, EMI, BNPL, RuPay |
| **Domestic fee** | UPI: 0% / Cards: 2% + 18% GST (~2.36%) |
| **International fee** | Cards: 3% + GST / IBT: 1% + GST |
| **Settlement** | T+2 business days (instant available for ~1% extra) |
| **Marketplace** | Route: linked accounts, auto-splits, escrow-like hold/release |
| **Subscriptions** | UPI Autopay, e-Mandate, card recurring (RBI-compliant) |
| **RBI Licenses** | PA-O + PA-P + PA-CB (full house) |

---

## Revenue Split

A **flat 20% platform fee** applies to all consultants regardless of appointment type or pricing.

```
Customer pays amount
    |
    v
Razorpay deducts PG fee (~2.36% domestic / ~3.54% intl cards / ~1.18% IBT)
    |
    v
Net amount to platform
    |
    +---> Platform keeps 20% of net
    |
    +---> Consultant receives 80% of net (minus TDS if over ₹50K/yr)
```

**Source**: `lib/payments/payouts/constants.ts` (`PLATFORM_FEE_PERCENTAGE: 20`)

---

## Environment Variables

### Razorpay (Payments)

| Variable                      | Purpose                     |
| ----------------------------- | --------------------------- |
| `RAZORPAY_KEY_ID`             | Server-side API key ID      |
| `RAZORPAY_SECRET`             | Server-side API key secret  |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | Client-side publishable key |

### RazorpayX (Payouts)

| Variable                   | Purpose                                                |
| -------------------------- | ------------------------------------------------------ |
| `RAZORPAYX_KEY_ID`         | RazorpayX API key (falls back to `RAZORPAY_KEY_ID`)    |
| `RAZORPAYX_KEY_SECRET`     | RazorpayX API secret (falls back to `RAZORPAY_SECRET`) |
| `RAZORPAYX_ACCOUNT_NUMBER` | RazorpayX account number for payouts                   |
| `RAZORPAYX_WEBHOOK_SECRET` | RazorpayX webhook signature verification               |

---

## Shared Infrastructure

Both gateways share a common abstraction layer:

| File                                       | Purpose                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/payments/index.ts`                    | Unified orchestration — routes `createPaymentIntent()`, `cancelPaymentIntent()`, `createRefund()` to the correct gateway                               |
| `lib/payments/core/types.ts`               | Shared types (`PaymentIntent`, `RefundResult`, `DisputeResult`) and the error classes (`PaymentError`, `RefundError`, `DisputeError`) |
| `lib/payments/payouts/payout-service.ts`   | Provider-agnostic payout orchestration (batch creation, admin approval, processing)                                                                    |
| `lib/payments/payouts/earnings-service.ts` | Earnings calculation with flat 20% platform fee                                                                                                        |
| `lib/payments/payouts/constants.ts`        | Hold periods, minimum amounts, fee percentages, payout mode limits                                                                                     |

---

## Documentation

### Gateway Evaluation

- [gateway-evaluation-mar-2026.md](./gateway-evaluation-mar-2026.md) — the dated March 2026 comparison that produced the current choice. Historical: the gateways it rejected have since been removed from the codebase.

### Razorpay

- [01-setup.md](./razorpay/01-setup.md) — Account setup, env vars, dashboard config, testing
- [02-architecture-and-flow.md](./razorpay/02-architecture-and-flow.md) — Payment flow, revenue split, webhook events
- [03-payout-flow.md](./razorpay/03-payout-flow.md) — RazorpayX Payouts: Contacts, Fund Accounts, payout lifecycle
- [04-kyc-and-onboarding.md](./razorpay/04-kyc-and-onboarding.md) — KYC requirements and onboarding checklist

### Stripe (Historical — Removed)

- [01-setup.md](./stripe/01-setup.md) — Account setup, env vars, dashboard config, testing
- [02-architecture-and-flow.md](./stripe/02-architecture-and-flow.md) — Checkout Sessions flow, revenue split, webhook events
- [03-payout-flow.md](./stripe/03-payout-flow.md) — Stripe Connect: Express accounts, transfers, payout lifecycle

---

## Related Documentation

- [Payment Architecture](../01-architecture.md) — Overall payment system design
- [Status Enums Reference](../03-status-enums-reference.md) — PaymentStatus, RefundStatus, DisputeStatus
- [Payouts](../payouts/README.md) — Payout algorithm, earnings lifecycle, batch processing
- [Webhooks](../webhooks/README.md) — Webhook monitoring and schemas
- [Tax Compliance — Marketplace Obligations](../../finances/07-tax-compliance-marketplace-obligations.md) — GST, TCS, TDS, Section 44AD, cross-border compliance
