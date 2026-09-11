---
status: historical
superseded-by: docs/payments/gateways/README.md
---

# Payment Gateway Evaluation — March 2026

> **This is a dated decision record, not current guidance.** It captures the
> comparison as it stood in March 2026 and the reasoning that produced the
> current setup. The gateways it recommends removing were removed, and their
> code is gone. Read it to understand *why* the platform runs on Razorpay; read
> [README.md](./README.md) for what is actually wired today.
>
> One thing has changed materially since this was written: Razorpay Route, the
> split-payment product a marketplace would normally reach for, was restricted
> from 1 January 2026 to merchants meeting turnover criteria. The platform does
> not use Route — funds settle to the platform account and RazorpayX payouts
> disburse from there — so this is a confirmation of the existing design rather
> than a change to it.

> Comprehensive analysis of payment gateways for Familiarise's services marketplace. 90% Indian users, 10% international.

**Last Updated**: 2026-03-19

---

## The Verdict

| Gateway | Decision | Reason |
|---------|----------|--------|
| **Razorpay** | **KEEP (Primary)** | Best Indian marketplace infra — Route, RazorpayX payouts, subscriptions, UPI, all methods |
| **Cashfree** | **ADD (Consider at Month 3-6)** | Cheaper than Razorpay (1.6–1.95% vs 2%), better split fees (0.1% vs 0.25%), PA-CB licensed |
| **Stripe** | **REMOVE** | Invite-only in India since May 2024, no UPI, no Connect for Indian marketplaces, 5–6% effective on international |
| **Lemon Squeezy** | **REMOVE** | Services explicitly prohibited in ToS. No UPI. Being absorbed into Stripe. 6.5%+ fees |
| **Xflow** | **REMOVE (for now)** | Not a payment gateway — cross-border B2B settlement. Useful later at scale, not at launch |
| **Dodo Payments** | **DO NOT ADD** | Pre-seed startup ($1.1M funding), fund-hold reports, services may not be supported, no marketplace splits |
| **Polar** | **DO NOT ADD** | Explicitly prohibits marketplaces AND human services in ToS |

---

## 1. Razorpay — KEEP (Primary)

### Why It Wins for 90% Indian Market

- **UPI at 0% MDR** — RBI mandate, zero charges on UPI P2M. Huge for Indian consultees
- **Route** for marketplace splits — linked accounts per consultant, settlement hold/release (escrow-like), automatic commission deduction
- **RazorpayX Payouts** — IMPS/NEFT/RTGS/UPI 24x7, bulk payouts (30K/day), auto-TDS calculation & filing
- **Subscriptions** with UPI Autopay + card mandates (RBI-compliant)
- **International Bank Transfer** at 1% + GST (cheapest cross-border option)
- **All Indian payment methods**: cards, net banking, wallets, EMI, BNPL
- **PA + PA-CB licensed** by RBI
- **55% market share** in India's online payment gateway market
- Preparing for **late 2026 IPO** — strong signal of stability

### Fees

| Method | Fee |
|--------|-----|
| UPI | 0% (RBI mandate) |
| RuPay Debit | 0% (RBI mandate) |
| Domestic cards (Visa/MC) | 2% + 18% GST |
| Net Banking | 2% + 18% GST |
| Wallets | ~2% + 18% GST |
| EMI (Credit Card) | 3% + 18% GST |
| International Cards | 3% + 18% GST |
| International Bank Transfer (IBT) | 1% + 18% GST |
| Route transfer fee | ~0.25% per linked account transfer |

### Settlement

- **Domestic**: T+2 business days
- **International**: T+7 business days
- **On-demand settlement**: ~1% extra fee, settles in 10 seconds
- At **50L+ monthly volume**, Razorpay negotiates custom rates (typically 1.5–1.75%)

### Refunds

- **Normal refund fee**: Zero (but original PG fee is NOT reversed — you eat the 2% + GST)
- **Normal refund timeline**: 5–7 working days
- **Instant refund**: Small per-transaction fee, within 2 minutes
- If instant refund fails, falls back to normal and fee is credited back

### Disputes/Chargebacks

- **Chargeback handling fee**: ~Rs 500 per chargeback
- Disputed amount debited from settlement balance during dispute period
- **Razorpay Shield** (fraud protection): extra ~1% fee, covers international chargebacks only
- Domestic chargebacks are unprotected by Shield

### Route (Marketplace Splits)

How it works for Familiarise's 80/20 model:

1. Customer pays Rs 1,000 to platform via Razorpay
2. Razorpay deducts PG fee (2% = Rs 20 + GST)
3. Split configured: 80% to consultant's Linked Account, 20% to platform
4. Razorpay deducts transfer fee (~0.25%) on amount transferred to linked account
5. Platform commission = Payment − PG Fee − Transfer Fees − Linked Account amount

**Linked Account features**:
- Each consultant gets a Linked Account under the main Razorpay account
- Sub-merchant onboarding API — consultants KYC on your platform, no Razorpay login needed
- Settlement can be deferred indefinitely (escrow-like) and released on-demand
- Per-linked-account settlement schedules (must be ≥ T+2)

### RazorpayX (Payouts & TDS)

- Auto-calculates TDS based on vendor category and invoice
- Auto-deducts and deposits TDS with government by 4th of every month
- Auto-generates challans, files returns, provides Form 16A on dashboard
- Configurable TDS categories at vendor level or invoice level
- Bulk payouts: up to 30,000/day via CSV or API
- Payout modes: IMPS, NEFT, RTGS, UPI (24x7 for IMPS/UPI)

### Subscriptions

- Plans, trials, add-ons, proration, smart retry (recovers up to 30% of failed payments)
- UPI Autopay: 60+ UPI apps
- e-Mandate: via Netbanking or Debit Card
- Card recurring: credit/debit including international
- RBI-compliant: AFA for mandates, pre-debit notifications, Rs 15K limit handling

### KYC for Sole Proprietorship

- PAN Card (personal), Aadhaar, bank account proof
- Business existence proof: Shop & Establishment certificate, GST certificate, or professional body registration
- Timeline: 1–3 business days, 100% online
- Known issue: new accounts may face 7–14 day fund holds during initial risk assessment

### RBI Compliance

- Holds all three RBI payment licenses: PA-O (online), PA-P (physical), PA-CB (cross-border)
- Compliant with 2025 Master Directions on Payment Aggregators
- Supreme Court dismissed ED appeal — no regulatory overhang

---

## 2. Cashfree — Consider Adding (Month 3-6)

### Why It Deserves Consideration

- **Cheaper gateway fee**: 1.6% promo (until Mar 2026 signup, 12-month validity, capped at 1Cr/month GTV) / 1.95% standard vs Razorpay's 2%
- **Cheaper splits**: Easy Split at 0.1% on order value vs Route at 0.25% on transfer amount
- **First non-bank PA-CB license** (July 2024) — strongest cross-border credentials
- **140+ currencies from 240 countries** — better international than Razorpay
- **Global Collection Accounts** — virtual USD/EUR/GBP/CAD/AUD accounts for international clients
- Same Indian methods: UPI (0%), cards, net banking, wallets, EMI

### Cost Comparison (Rs 1,000 domestic card, 80/20 split)

| | Razorpay | Cashfree |
|---|---|---|
| PG Fee | Rs 20 (2%) | Rs 16 (1.6%) |
| Split Fee | Rs 2 (0.25% of Rs 800) | Rs 1 (0.1% of Rs 1,000) |
| GST on fees | Rs 3.96 | Rs 3.06 |
| **Total cost** | **Rs 25.96** | **Rs 20.06** |
| **Your effective commission (20%)** | **Rs 174.04** | **Rs 179.94** |

**At Rs 10L monthly GMV**: ~Rs 5,900/month savings with Cashfree.

### Easy Split (Marketplace)

- Accept payments, deduct commission, auto-settle to vendors
- Unlimited vendor onboarding with integrated KYC
- Custom settlement cycles per vendor (including instant)
- Automated refund management with vendor settlement adjustments
- Vendor ledger via API or dashboard

### International

- 140+ currencies from 240 countries
- PayPal integration + international cards
- Global Collection Accounts: virtual accounts in USD/EUR/GBP/CAD/AUD
- Local methods: ACH (US), SEPA (EU), Faster Payments (UK)
- Pay Native (DCC): customer pays in their currency, merchant receives INR

### When to Add

Add Cashfree when:
- Volume exceeds Rs 10L/month (cost savings justify complexity)
- OR Razorpay uptime/support becomes an issue
- Consider Juspay/Hyperswitch for smart routing between both gateways

---

## 3. Stripe — REMOVE

### Why Remove

- **Invite-only in India since May 2024** — can't reliably sign up. Promised "second half of 2025" broader availability — has NOT materialized
- **No UPI** (beta only, must contact Stripe) — kills 90% of user base
- **No RuPay, no wallets, no net banking** — cards only (Visa, MC, Amex)
- **Stripe Connect severely limited in India** — custom accounts can't be self-served, must go through sales team case-by-case
- **5–6% effective cost on international** (3% base + 1.5% cross-border + 2% FX markup + GST)
- **No FIRA/eFIRC generation** — must coordinate with bank separately for export compliance
- **Razorpay IBT at 1% + GST** is far cheaper for international
- **No PA-CB license** — operates cross-border through AD bank partnerships
- **Sole proprietorship may face onboarding issues**
- Settlement: 2–5 business days (7–10 for first payment), no instant option
- Refund: processing fee NOT returned + additional ~$0.30 per refund
- Chargeback: $15 per dispute

### The Only Counter-Argument

Brand recognition with international consultees. But Razorpay/Cashfree accept international Visa/MC/Amex too, at lower fees.

### Stripe Atlas Note

If Familiarise ever incorporates a US entity (via Atlas at $500), full Stripe access becomes available. But this adds significant compliance overhead (US tax filing, India-US dual compliance, FEMA/RBI reporting) and is not justified for the current 10% international mix.

---

## 4. Lemon Squeezy — REMOVE

### Hard Blockers

1. **Services explicitly prohibited** in acceptable use policy — "Services of any kind including marketing, design, web development, consulting or other related services" are not allowed. Consultations, webinars, and classes would violate ToS and risk account termination.
2. **No UPI** — cards and PayPal only
3. **6.5% + $0.50 per transaction** for non-US (all Familiarise transactions are "international" from Lemon Squeezy's US perspective). On a Rs 500 (~$5.50) consultation, effective take rate is ~15.5%.
4. **Being absorbed into Stripe Managed Payments** — acquired by Stripe July 2024, uncertain future
5. **Sole proprietorship may not be accepted** — prefers Pvt Ltd
6. **Twice-monthly payouts with 13-day hold** — cash flow drag
7. **Stripe invite-only in India affects payouts** — may require PayPal as fallback

---

## 5. Xflow — REMOVE (for now)

### Critical Correction

**Xflow (xflowpay.com) is NOT a Razorpay product.** It is an independent company founded 2021 in Bengaluru. Investors include General Catalyst, Square Peg, Stripe, Lightspeed, PayPal Ventures — but NOT Razorpay.

### What It Actually Is

Xflow is **cross-border B2B payment infrastructure** — not a payment gateway. It helps Indian businesses receive international payments via:
- Virtual Receiving Accounts (clients abroad pay to local-looking accounts)
- Currency conversion at live mid-market FX rates with 0% markup
- Settlement to Indian bank accounts in 1 business day
- Automatic eFIRA within 24 hours
- RBI PA-CB licensed, transactions via JP Morgan Chase rails

### Pricing

| Plan | Fee |
|------|-----|
| Starter (invoices < $3,500) | $12 flat for invoices ≤ $2,000; 0.6% for > $2,000 |
| Standard | ~1% flat per transaction |
| Minimum fee | $8 per transaction |
| FX markup | 0% (mid-market rate) |

### When It Becomes Relevant

When international volume exceeds Rs 5L+/month and Xflow's 0% FX markup + 24hr eFIRA generation saves money vs Razorpay's FX spread. Not at launch with 10% international.

---

## 6. Dodo Payments — DO NOT ADD

- **Only $1.1M pre-seed funding** (Feb 2025, Antler + 9Unicorns) — extreme counterparty risk as MoR (they hold your money)
- **Multiple reports of accounts frozen** and funds held at payout thresholds (~$1,000)
- **Service-based businesses may not be supported** — users discovered this after signing up
- **Not built for 2-sided marketplace splits** — no Razorpay Route equivalent
- **4% + Rs 4** is more expensive than Razorpay's 2% for domestic
- **Fake review allegations** on Trustpilot/AppSumo
- The MoR model is fundamentally designed for single-seller digital products/SaaS, not for two-sided service marketplaces

---

## 7. Polar — DO NOT ADD

- **Explicitly prohibits marketplaces** in acceptable use policy: "Marketplaces — selling others' products or services using Polar against an upfront payment or with an agreed upon revenue share — are explicitly not allowed."
- **Explicitly prohibits human services** — consultations would not be allowed
- **No UPI/INR payment collection** — card-only via Stripe
- Non-starter for Familiarise in any form

---

## Architecture Roadmap

### LAUNCH (Day 1)

```
Primary Gateway: Razorpay
├── Domestic: UPI (0%), Cards (2%), Net Banking, Wallets
├── International: Razorpay IBT (1%) + International Cards (3%)
├── Marketplace: Route (linked accounts, auto-splits)
├── Payouts: RazorpayX (auto-TDS, bulk payouts)
└── Subscriptions: Razorpay Subscriptions (UPI Autopay)
```

### MONTH 3-6 (Evaluate)

```
Add Cashfree as second gateway IF:
├── Volume exceeds Rs 10L/month (cost savings justify complexity)
├── OR Razorpay uptime/support becomes an issue
└── Consider Juspay/Hyperswitch for smart routing between the two
```

### LATER (International > Rs 5L/month)

```
├── Add Xflow for cross-border settlement optimization
└── Add Wise Business API for international consultant payouts
```

---

## Other Gateways Evaluated But Not Recommended

### PayU India

- 2% domestic, 3% international, has split settlements
- Prosus (Naspers) subsidiary, 500K+ businesses
- Has PA + PA-P + PA-CB licenses (Nov 2025)
- **Not recommended because**: No clear advantage over Razorpay/Cashfree for marketplace model, less developer-friendly

### PhonePe Payment Gateway

- 1.95% standard (currently FREE promo)
- Has UPI, cards, net banking
- **Not recommended because**: Marketplace/split infrastructure is immature, thin documentation, dropped third-party partnerships (Juspay)

### Juspay/Hyperswitch

- Payment orchestration layer (not a gateway itself)
- Routes between multiple gateways based on success rates, cost, latency
- Open-source (Apache 2.0, Rust, 14K+ GitHub stars)
- **Not needed now**: Premature optimization at pre-launch scale. Revisit when running multiple gateways

---

## Bottom Line

**Go Razorpay-only at launch. Remove Stripe, Lemon Squeezy, and Xflow from the codebase. Don't add Dodo or Polar. Evaluate Cashfree at Month 3. Get GST registered and set up TCS/TDS before going live.**
