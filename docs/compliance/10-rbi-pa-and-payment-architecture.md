# 10 — RBI Payment Aggregator Directions 2025 + payment architecture

> **Status:** 🟡 architecture memo only — likely permitted under current direction; needs CA / RBI-compliance opinion before declaring final. **No migration.**
> **Audience:** payment-platform engineers; ops + finance; CA / legal.
> **Last reviewed:** 2026-06-05 (RBI PA Directions + e-mandate framework web-verified as of 2026-06-05)
> **Linked issues:** [#737 §10](https://github.com/Practitionist/familiarise_web/issues/737), [#738 Item G](https://github.com/Practitionist/familiarise_web/issues/738) (demoted from architectural to "verify + document").

## What it is

The **Reserve Bank of India (Regulation of Payment Aggregators) Directions, 2025** — reference **RBI/DPSS/2025-26/141**, dated **15 September 2025**. It consolidates and **repeals** the earlier PA guidelines (DPSS PA/PG guidelines of 17 Mar 2020 + 31 Mar 2021) and the PA-CB circular (31 Oct 2023), and for the first time formally categorises three PA types: **PA-Online (PA-O)**, **PA-Physical (PA-P)**, and **PA-Cross-Border (PA-CB)**. _(Title + reference number verified 2026-06-05 against rbi.org.in.)_

The most-cited operative constraint for marketplaces:

> A PA **must not carry out marketplace business and aggregate funds for merchants with whom it does not have a contractual relationship.** Funds collected on behalf of merchants sit in a **separate escrow account** with a Scheduled Commercial Bank, and credits/debits to that escrow are restricted to transactions explicitly permitted under the Directions (merchant payouts, refunds, commission, etc.). Default settlement to the merchant is **T+1**, though the PA and merchant may agree fair, transparent settlement timelines contractually.

This affects every marketplace that today receives consumer payments and pays out to a third party (consultant / seller / artist): the PA may only settle to merchants it has onboarded under contract, and may not divert escrow funds to non-merchant third parties.

**Two paths the direction permits:**

| Path                                     | Mechanism                                                                                                                                                                                                | Onboarding burden                                                                                                  | Settlement timing                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| **A — PA Sub-Merchant** (Razorpay Route) | Each consultant is a fully-KYC'd sub-merchant under Razorpay's PA license. Razorpay handles split settlement at payment time.                                                                            | High — per-consultant V-CIP, PAN, Aadhaar, bank proof.                                                             | Tn+1 to consultant.                                   |
| **B — Escrow Account**                   | Marketplace (as an authorised PA) maintains the RBI-mandated escrow with a Scheduled Commercial Bank. Funds enter escrow; debits restricted to merchant payouts, refunds, commission per the Directions. | Low at consultant level; high at platform level (requires PA authorisation: ₹15 cr net worth + escrow governance). | Contractual, within the Directions' settlement norms. |

**A third de facto path the direction does NOT explicitly forbid:**

| Path                                                 | Mechanism                                                                                                                                                                               | Notes                                                                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **C — Operating account + separate licensed payout** | Consumer → PA → platform's operating account (platform IS the merchant). Platform separately uses a licensed FAA (e.g. RazorpayX Bulk Payouts) to pay consultants from operating funds. | Two separate RBI-licensed flows. Consultant is NOT settled by the PA — they're paid by us via a different licensed product. |

## What architecture does Practitionist actually use?

Verified at `lib/payments/payouts/razorpay-payouts.ts`:

```text
Consumer → Razorpay PG (PA license) → Practitionist operating account (we are the merchant)
                                                ↓
                Cron → RazorpayX Payouts API (FAA license) → consultant bank / UPI / Stripe
```

**This is Path C.** Specifically:

- We are NOT using Razorpay Route — `razorpayContactId` + `razorpayFundAccountId` are RazorpayX Bulk Payouts identifiers, NOT Route sub-merchant IDs.
- We are NOT using a nodal account — funds land in the platform's operating account.
- We make a separate, licensed payout via RazorpayX. Razorpay holds RBI payment-aggregator authorisation — final online PA authorisation was reported in December 2023, cross-border PA authorisation followed in December 2025, and the offline PA-P licence followed in January 2026 — and RazorpayX payouts are executed from the platform's own current account through Razorpay's partner banks, not from PA escrow.

## Why Path C is likely permitted

The 2025 PA Directions' prohibition is on a **PA aggregating funds for, or settling to, parties with whom the PA has no merchant contract** (and on diverting escrow to non-merchant third parties). In our architecture:

1. The PA (Razorpay PG) settles to the **merchant** — that's us. No non-merchant settlement happens from the PA.
2. The payout to the consultant is a separate, licensed transaction via a different RBI-regulated rail (RazorpayX FAA / Stripe Connect).
3. The consultant has no relationship with our PA. They have a relationship with us (their counterparty for the service contract) and with RazorpayX / Stripe (the disbursement rail).

This is the same architecture used by every B2B SaaS marketplace, every freelancer platform, and every digital agency. **Likely permitted** under the new direction.

## What the direction DOES still require

Even on Path C, the direction imposes:

| #   | Requirement                                            | Status                                                                                                       |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 1   | **Marketplace declaration** to Razorpay                | Done at PA onboarding; sign annual self-declaration                                                          |
| 2   | **Refund SLA** to consumers (RBI-prescribed timelines) | Implementation pending — see [doc 09](./09-consumer-protection-and-grievance.md)                             |
| 3   | **Prohibited categories monitoring**                   | Active — Razorpay flags + we add platform-level ToS                                                          |
| 4   | **Data localisation** of payment data                  | Already enforced — RBI "Storage of Payment System Data" directive, 6 Apr 2018; Razorpay infra is India-based |
| 5   | **PCI-DSS** — never store card numbers / CVV / etc.    | Already compliant — we use Razorpay tokens                                                                   |
| 6   | **Chargeback handling** within 7-day evidence window   | Implementation pending — see [doc 09](./09-consumer-protection-and-grievance.md)                             |
| 7   | **PA-CB approval** for cross-border collections        | Razorpay holds it; we enable cross-border settings — see [doc 07](./07-cross-border-flows.md)                |

## Wallet auto-top-up and the e-mandate framework

`OrgBillingAccount.autoTopUpMandateId` (a "gateway recurring-payment token") lets the wallet auto-recharge by `autoTopUpAmountPaise` when the balance drops below `minBalancePaise`. Recurring debits against a stored mandate are governed by the **RBI Digital Payments — E-mandate Framework, 2026** (issued **21 April 2026**, effective immediately), which consolidates all prior e-mandate / UPI-AutoPay circulars across cards, PPIs, and UPI. _(Verified 2026-06-05.)_

Operative limits for the auto-top-up mandate:

| #   | Rule                                                                                                                                   | Effect on auto-top-up                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Mandate **registration** requires Additional Factor of Authentication (AFA) — a one-time auth when the org sets up the mandate.        | The first mandate setup must go through full AFA at the gateway.                                                                                                  |
| 2   | Subsequent recurring debits run **without AFA up to ₹15,000 per transaction**; debits above that need AFA per transaction.             | Keep `autoTopUpAmountPaise` ≤ ₹15,000 (1,500,000 paise) to stay in the no-AFA lane; larger top-ups will prompt per-debit AFA and can fail silently if unattended. |
| 3   | **Pre-debit notification** to the payer **≥ 24h** before each debit, with opt-out.                                                     | The gateway issues this; ensure the mandate is registered with a reachable contact so notifications land.                                                         |
| 4   | ₹1 lakh per-transaction no-AFA ceiling applies only to insurance / mutual-fund / credit-card-bill categories — **not** wallet top-ups. | Do not assume the ₹1 lakh ceiling for wallet recharges; the ₹15,000 cap governs.                                                                                  |

This is a forward-looking note: the auto-top-up cron exists in schema, but live mandate registration must respect these limits at the gateway integration layer.

## When it applies

### B2C (consumer marketplace)

- **Applies fully.** Consumer payment + consultant payout architecture sits squarely under this direction.

### B2B (org-sponsored)

- **Applies to org-side payments + consultant payouts.** The org pays via INVOICE / WALLET / LICENSE (different mechanics) but the consultant payout still flows through RazorpayX. Same Path C.

### Cross-border

- See [doc 07](./07-cross-border-flows.md). PA-CB (previously the 31 Oct 2023 circular) is now folded into the 2025 Directions as one of the three PA categories.

## Current code

| Item                                               | What it does                                                                                   | State   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------- |
| `lib/payments/payouts/razorpay-payouts.ts`         | RazorpayX Bulk Payouts API client                                                              | ✅ live |
| `lib/payments/payouts/stripe-connect.ts`           | Stripe Connect for cross-border consultant payouts                                             | ✅ live |
| `lib/payments/payouts/payout-service.ts` (B2C)     | Consultant payout pipeline                                                                     | ✅ live |
| `lib/payments/payouts/org-payout-service.ts` (B2B) | Org payout pipeline                                                                            | ✅ live |
| Razorpay PG checkout                               | ✅ live                                                                                        |         |
| Architecture memo                                  | **Written (2026-09-03)** — this document is the memo stating "we are on Path C and here's why" | ✅      |

## Gap

| Gap                                                                                | Severity                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No memo at `docs/payments/` documenting the architecture vs the Sep 2025 direction | ✅ **Written (2026-09-03)** — this document (`docs/compliance/10-rbi-pa-and-payment-architecture.md`), together with `docs/enterprise/70-design-decisions/26-gst-principal-model.md` and `docs/payments/audits/2026-09-03-finance-verdicts.md`, is the architecture memo this row asked for; the fact-specific risk paragraph in §A above stays the operative text. |
| No CA / RBI-compliance opinion validating Path C for our specific facts            | 🟡 still open — see the CA action list below                                                                                                                                                                                                                                                                                                                        |
| No annual Razorpay marketplace self-declaration captured + filed                   | 🟢 (assumed Razorpay does this; verify)                                                                                                                                                                                                                                                                                                                             |
| No prohibited-categories monitoring at platform-ToS level (Razorpay flags only)    | 🟢                                                                                                                                                                                                                                                                                                                                                                  |

### CA action list (2026-09-03)

The chartered accountant engagement this section calls for now has a concrete question list, gathered from the 2026-09-03 finance audit rather than left as an open-ended "review the memo" ask.

1. Confirm Path C (Razorpay PG as the merchant of record, RazorpayX payouts as a separately licensed rail) is permitted for a consulting marketplace under the RBI PA Directions 2025, as this document's §B already asks.
2. Answer the five questions in [ADR 26](./../enterprise/70-design-decisions/26-gst-principal-model.md#questions-for-the-chartered-accountant): whether Principal-for-GST paired with 194-O-operator-for-income-tax holds together, how a platform-funded referral credit should be treated for taxable value, the correct SAC code, whether the Section 12(2)(b) supplier-state default is acceptable, and whether Section 52 TCS registration is required at all under this model.
3. Weigh in on #1388, the specific code-path question about referral credits being applied after tax at checkout (`deriveCheckoutAmount`), which nothing in the code changes until it is answered.
4. Confirm which authorisation RazorpayX payouts operate under and whether any additional registration is needed for platform-initiated payouts to consultants.

## Required

### A. Architecture memo (PR 1)

Add `docs/payments/06-pa-master-direction-architecture.md` (or similar):

1. The four paths permitted (A / B / C and C-prime).
2. The path Practitionist uses (Path C).
3. Why Path C is consistent with the Sep 2025 direction.
4. What still applies even on Path C (refund SLA, chargeback handling, PCI-DSS, etc.).
5. The fact-specific risks: a regulator could reclassify the platform as a deemed PA if circumstantial evidence (volume, marketing language, brand integration) suggests we're aggregating rather than facilitating. Mitigate by clear marketing + ToS that we are a marketplace, not a payment intermediary.

### B. CA / legal opinion (PR 2 — out-of-band)

Engage a CA + an RBI-specialised counsel:

- Review the architecture memo.
- Confirm Path C is permitted for our facts.
- Document the opinion with their UDIN / signature.
- File in `docs/compliance/legal-opinions/` (gitignored if confidential).

### C. Annual self-declaration (PR 3)

- Confirm with Razorpay account manager that we sign the marketplace self-declaration annually.
- Calendar a reminder in ops calendar 30 days before each anniversary.

### D. Prohibited categories ToS (PR 4)

- Add to the consultant ToS a list of prohibited service categories (gambling, MLM, crypto, regulated professions where licensing is required).
- Active monitoring: a flag on `ConsultantProfile` that admin can set if a complaint surfaces.

## Decision: do NOT migrate to Path A or B unless

The migration cost (per-consultant V-CIP for Path A, or nodal-account governance for Path B) is significant. Trigger a migration only if:

1. The legal opinion in PR 2 explicitly recommends migration.
2. Regulator inquiry surfaces.
3. A specific feature (e.g. instant settlement, on-platform escrow for high-value services) requires it.
4. The marketplace ratio (commission %) shifts in a way that legally re-classifies us as the deemed seller.

## Acceptance

- Architecture memo in `docs/payments/` published.
- Legal opinion sourced and filed (or "deferred until first regulator inquiry" decision noted).
- Annual self-declaration calendared.
- Prohibited categories ToS published.
- Per-doc inheritance: refund SLA ([doc 09](./09-consumer-protection-and-grievance.md)) + chargeback evidence UI + cross-border PA-CB enablement ([doc 07](./07-cross-border-flows.md)) all closed independently.

## Don't build

| Don't build                                       | Reason                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Razorpay Route migration                          | Path A burden is high and not required given Path C is permitted. Wait for legal opinion. |
| Self-custodied escrow                             | Requires ₹15 cr net worth + RBI approval. Not viable.                                     |
| Direct nodal-account integration with an SPD bank | Path B governance is heavy; only if a specific feature demands it.                        |

## References

- [RBI (Regulation of Payment Aggregators) Directions, 2025 — RBI/DPSS/2025-26/141, 15 Sep 2025 (RBI master-directions page)](https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12896) _(title + ref no. verified 2026-06-05)_
- [RBI PA Directions 2025 — full text (FIDC mirror)](https://www.fidcindia.org.in/wp-content/uploads/2025/09/RBI-PAYMENT-AGGREGATORS-DIRECTIONS-15-09-25.pdf)
- [PA Directions 2025 analysis (Khaitan & Co)](https://www.khaitanco.com/sites/default/files/2025-10/ERGO%20-%20PA%20Master%20Directions%20-%203%20Oct%202025_0.pdf)
- [RBI Digital Payments — E-mandate Framework, 2026 (issued 21 Apr 2026) — coverage](https://www.businesstoday.in/personal-finance/news/story/rbi-caps-recurring-payments-at-rs15000-without-otp-under-new-e-mandate-framework-526759-2026-04-21) _(₹15,000 no-AFA cap verified 2026-06-05; replace with the RBI primary circular URL when indexed)_
- [Razorpay Payment Gateway Compliance 2026](https://razorpay.com/blog/payment-gateway-compliance/)
- [Razorpay KYC Onboarding Guide 2026](https://razorpay.com/blog/payment-gateway-kyc-onboarding-india)
- See also: [07](./07-cross-border-flows.md) (PA-CB), [09](./09-consumer-protection-and-grievance.md) (refund SLA, chargeback handling).
