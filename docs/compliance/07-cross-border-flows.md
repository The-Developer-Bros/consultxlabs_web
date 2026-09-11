# 07 — Cross-border flows (non-resident consumers + non-resident consultants)

> **Status:** schema fields exist on both sides (`form15caPartCRef`, `form15cbRef`, `firceRef`, `dtaaRateApplied`, `Organization.parentCountry`); logic + UI mostly absent on both rails. B2C side is **completely missing** — TDS code skips non-residents entirely.
> **Audience:** payment + payout + onboarding code; finance + tax-ops.
> **Last reviewed:** 2026-06-05 (FEMA / Sec 195 / 15CA-CB / PA-CB web-verified as of 2026-06-05)
> **Linked issues:** [#737 §5.5](https://github.com/Practitionist/familiarise_web/issues/737) (FEMA), [#738 Items D, E](https://github.com/Practitionist/familiarise_web/issues/738).

## What it is

Cross-border = either side of the transaction is non-resident. Two flavours:

### Inward (non-resident consumer pays a resident consultant)

Regulations:
- **IGST Sec 16** — supply to a non-resident outside India is **zero-rated export** of services. No GST charged. Either with payment of IGST + claim refund, OR under **LUT (Letter of Undertaking)** without payment.
- **RBI PA-CB regime** — the standalone PA-CB circular (31 Oct 2023) has been **consolidated into the Reserve Bank of India (Regulation of Payment Aggregators) Directions, 2025** (RBI/DPSS/2025-26/141, 15 Sep 2025), where PA-CB is one of three formal PA categories. Inward flows route through an **Inward Collection Account (InCA)**, outward through an **Outward Collection Account (OCA)**. Only PAs authorised for PA-CB can collect cross-border. Razorpay holds it; we enable cross-border merchant settings + retain FEMA documentation. *(Verified 2026-06-05 — see [doc 10](./10-rbi-pa-and-payment-architecture.md).)*
- **FEMA reporting** — outward flow from us to consultant is in INR, no FEMA. Inward flow from foreign consumer to us is in foreign currency; the AD bank issues an inward remittance acknowledgement. For **export of services** the current artifact is the **e-FIRA / e-FIRC** (Electronic Foreign Inward Remittance Advice/Certificate) generated under RBI's **EDPMS** — the physical FIRC has been largely phased out since 2016 and now applies mainly to FDI/VC inflows. The e-FIRA is what unlocks GST export refunds. *(Verified 2026-06-05.)*
- **Invoice in foreign currency** — must record the FX rate snapshot for INR-equivalent reporting. CGST Rule 34 mandates RBI reference rate at invoice date.

### Outward (resident platform pays a non-resident consultant)

Regulations:
- **Income Tax Sec 195** (NOT 194O) — TDS at 20% or DTAA rate, whichever is **lower**, but DTAA rate only applies if the consultant produces a Tax Residency Certificate (TRC) + Form 10F + (optionally) a no-PE declaration.
- **Form 15CA** — pre-remittance declaration filed by the deductor with the IT dept.
- **Form 15CB** — CA's certificate accompanying Form 15CA, required if the remittance exceeds ₹5,00,000 in a year and is taxable in India.
- **RBI purpose code** — every outward remittance must be coded for FEMA reporting via the AD bank. The correct code depends on the service: **P0802** (software consultancy/implementation, non-SOFTEX) or **P0807** (off-site software export, SOFTEX) for IT/software consultants; **P1006** (business & management consultancy) and related P10xx codes for non-software professional consultancy. `OrganizationPayout.rbiPurposeCode` schema field exists — populate it per consultant's service type, not a hard-coded default. *(Purpose-code mapping verified 2026-06-05.)*
- **Outward Remittance Certificate (ORC)** — issued by the AD bank for the consultant; we don't generate it but we should retain refs.

## When it applies

### B2C (consumer marketplace)

- **Inward (non-resident consumer)**: applies when the buyer's country is not India. Currently captured server-side via `lib/compliance/gst.ts:78–90` as `ZERO_RATED_EXPORT` — but the upstream `buyerCountry` capture at checkout needs verification.
- **Outward (non-resident consultant)**: applies when the consultant is non-resident. Currently `lib/payments/tax/tds-service.ts:155` **skips** the deduction entirely — bug; should pivot to Sec 195.

### B2B (org-sponsored)

- **Inward (non-resident org / non-resident parent)**: applies. `Organization.parentCountry` + `isGCC` schema fields exist.
- **Outward (non-resident consultant via org payout)**: applies. `lib/compliance/tds.ts` already supports DTAA rate lookup; payout service has `form15caPartCRef` / `form15cbRef` / `firceRef` / `dtaaRateApplied` / `rbiPurposeCode` / `fxRateUsed` fields.

## Current code

| Item | B2B | B2C | State |
|---|---|---|---|
| Buyer country / state capture at checkout | ✅ via org GST state | 🔴 missing on B2C | mixed |
| Zero-rated export GST derivation | ✅ `gst.ts:78–90` | ✅ same code | live |
| LUT enforcement on invoice | 🔴 schema-only | 🔴 schema-only | gap |
| FX rate snapshot on invoice | ✅ `OrganizationInvoice.displayCurrency` + `inrEquivalentPaise` + `fxRateUsed` | 🔴 missing on B2C `Invoice` | mixed |
| DTAA rate lookup | ✅ `lib/compliance/dtaa-rates.json` (ish) | 🔴 not used by B2C TDS code | mixed |
| Sec 195 derivation for non-resident consultants | ✅ via `lib/compliance/tds.ts` | 🔴 B2C TDS code *skips* non-residents | gap |
| Form 15CA / 15CB capture | ✅ schema fields on `OrganizationPayout` | 🔴 schema only — no equivalent on B2C `Payout` | gap |
| FIRC capture | ✅ schema field | 🔴 no equivalent on B2C | gap |
| RBI purpose code | ✅ schema field on B2B | 🔴 missing on B2C | gap |
| 27Q quarterly return | 🔴 see [doc 04](./04-tds-quarterly-filings.md) | 🔴 same | gap |

## Gap

### Inward (non-resident consumer)

1. **Buyer country at checkout**: `Payment.buyerCountry` (or equivalent) needs to be reliably captured. Currently relies on billing-address inference; should be explicit at checkout and validated against the card BIN.
2. **LUT enforcement**: when the buyer is non-resident and the platform has a valid LUT on file, mark the invoice as zero-rated under LUT; otherwise charge IGST and instruct the consultant to claim the export refund.
3. **Foreign-currency invoice template**: B2C `Invoice` lacks `displayCurrency` / `inrEquivalentPaise` / `fxRateUsed`; B2B `OrganizationInvoice` already has them. Add to B2C.
4. **e-FIRC capture**: the AD bank issues an inward remittance acknowledgement; we should fetch + store + link to `Payment.firceRef`.

### Outward (non-resident consultant)

1. **B2C TDS pivot to Sec 195**: `lib/payments/tax/tds-service.ts` currently has a comment "Non-resident guard: Section 194J does not apply to non-residents" and skips the deduction. Bug — must pivot to Sec 195. Use `lib/compliance/tds.ts:computeTdsForPayout` which already does DTAA + Form 10F lookup.
2. **B2C `Payout` schema parity with `OrganizationPayout`**: add `form15caPartCRef`, `form15cbRef`, `firceRef`, `dtaaRateApplied`, `rbiPurposeCode`, `fxRateUsed`.
3. **Form 15CA filing automation**: integrate with a CA partner (Taxmann / TaxSpanner) to capture 15CB UDIN; auto-file 15CA Part C via the income-tax e-filing API (DSC required).
4. **TRC / Form 10F capture at consultant onboarding** for non-residents: schema needs `ConsultantProfile.trcRef` + `form10FRef` + `noPeDeclarationRef`. Without these, DTAA rate cannot be applied and we default to 20%.
5. **27Q quarterly return** — see [doc 04](./04-tds-quarterly-filings.md).
6. **Cross-border payout gateway**: RazorpayX Bulk Payouts is INR-only. Cross-border consultant payouts route via Stripe Connect (already wired) or a dedicated PA-CB partner.

## Required

### A. Inward — non-resident consumer (B2C)

1. **Schema**:
   - `Payment.buyerCountry` (2-char ISO).
   - `Invoice.displayCurrency`, `Invoice.inrEquivalentPaise`, `Invoice.fxRateUsed`.
   - `Payment.firceRef` (nullable).
2. **Checkout**: capture `buyerCountry` from billing form; store on `Payment`.
3. **GST derivation**: pass `buyerCountry` to `deriveGstBreakdown` (already accepts it). Check LUT presence on a platform-level config; if absent, charge IGST.
4. **Invoice template**: B2C `ConsumerInvoiceDocument` already shows zero-rated export; add LUT number + foreign-currency totals.
5. **RBI compliance**: ensure Razorpay PA-CB merchant settings are enabled; document the platform's PA-CB obligations in [doc 10](./10-rbi-pa-and-payment-architecture.md).

### B. Outward — non-resident consultant (B2C)

1. **Schema**:
   - `ConsultantProfile.taxResidencyStatus` (`RESIDENT` / `NON_RESIDENT`), `country`, `trcRef`, `form10FRef`, `noPeDeclarationRef`.
   - `Payout.form15caPartCRef`, `form15cbRef`, `firceRef`, `dtaaRateApplied`, `rbiPurposeCode`, `fxRateUsed`.
2. **`lib/payments/tax/tds-service.ts`**: pivot non-resident path from "skip" to delegate to `lib/compliance/tds.ts:computeTdsForPayout` (which has DTAA + 206AA logic). Default 20%; DTAA rate only when TRC + Form 10F refs are populated.
3. **Onboarding**: collect TRC / Form 10F / no-PE declaration as file uploads on consultant settings page (non-resident only).
4. **Form 15CA filing**: integrate CA partner; capture UDIN; auto-file Part C via income-tax e-filing API.
5. **Stripe Connect routing**: when consultant is non-resident, skip RazorpayX Bulk Payouts → use Stripe Connect transfer (already supported by `lib/payments/payouts/stripe-connect.ts`).

### C. Cross-border 27Q return — see [doc 04](./04-tds-quarterly-filings.md).

## Acceptance

### Inward
- A US consumer purchases a session: `Payment.buyerCountry = "US"`; invoice shows zero GST + LUT number; `Invoice.displayCurrency = "USD"`; `inrEquivalentPaise` populated.
- Razorpay returns the inward remittance ack; we store `firceRef`.

### Outward
- A non-resident consultant earns ₹6L this FY: TDS withheld at min(20%, DTAA rate) when TRC + Form 10F are on file; at 20% otherwise.
- Form 15CA Part C filed automatically before the payout disburses.
- Payout routes through Stripe Connect, not RazorpayX.
- 27Q FVU file generated end-of-quarter with DTAA refs.

## Don't build

| Don't build | Reason |
|---|---|
| Internal AD-bank inward integration | The bank pushes the FIRC to Razorpay's PA-CB partner; we just retain the ref. |
| Form 15CA filing without a CA partner | UDIN requires the CA's signature. Don't try to bypass. |
| Cross-border payout via direct SWIFT integration | We're not a bank; route via Stripe Connect or PA-CB partner. |
| Manual TRC verification | Trust the consultant's uploaded document; no live ITAT API for verification. |

## References

- [IGST Sec 16 — zero-rated supply](https://www.cbic.gov.in/htdocs-cbec/gst/igst-act-2017-amend-finance-act-2024.pdf)
- [Section 195 + DTAA + Form 10F (TaxGuru)](https://taxguru.in/income-tax/section-195-tds-payment-non-residents.html)
- [Form 15CA + 15CB filing process (income-tax.gov.in)](https://www.incometax.gov.in/iec/foportal/help/itr/form-15ca-cb) — 15CB required when remittance/aggregate **> ₹5L in FY and taxable** *(verified 2026-06-05)*
- [RBI (Regulation of Payment Aggregators) Directions, 2025 — PA-CB now consolidated here](https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12896) *(supersedes the standalone 31 Oct 2023 PA-CB circular; verified 2026-06-05)*
- [e-FIRA / e-FIRC under EDPMS — export-of-services remittance advice](https://razorpay.com/blog/e-fira/) *(verified 2026-06-05)*
- [RBI purpose-code list (inward/outward remittance)](https://razorpay.com/blog/rbi-purpose-code-remittance-compliance-guide/) *(P0802/P0807/P1006 mapping verified 2026-06-05)*
- See also: [01](./01-tds-overview.md) (Sec 195), [02](./02-gst-overview.md) (LUT, IGST Sec 16), [04](./04-tds-quarterly-filings.md) (27Q), [10](./10-rbi-pa-and-payment-architecture.md) (PA-CB architecture).
