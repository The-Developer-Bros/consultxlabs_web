# 02 — GST overview (TCS Sec 52, invoicing, place of supply, HSN, IRN, LUT)

> **Status:** core derivation real (`deriveGstBreakdown` does CGST/SGST/IGST split + zero-rated export); TCS Sec 52 + GSTR-8 missing entirely; place-of-supply state capture missing on B2C side; e-invoicing / IRN connector live (env-gated) + cron wired (Round 2, 2026-05-02). 🟡 **NEW (2026-06-05): GST TCS rate corrected 1% → 0.5% (halved by Notif 15/2024-CT w.e.f. 10-Jul-2024) throughout this doc.**
> **Audience:** payments + invoice + finance code.
> **Last reviewed:** 2026-06-05 (regulatory facts web-verified as of 2026-06-05; prior review 2026-05-02)
> **Linked issues:** [#737 §2,§5,§11](https://github.com/Practitionist/familiarise_web/issues/737), [#738 §A,§F](https://github.com/Practitionist/familiarise_web/issues/738).

## Model decision (2026-09-03)

The platform bills as **Principal supplier for GST**, decided in [ADR 26](../enterprise/70-design-decisions/26-gst-principal-model.md) and superseding the facilitator framing this document was originally written around. GST stays at 18% on the full discounted price exactly as today, and the platform will issue its own numbered **B2C tax invoice** for every consumer supply (`ConsumerInvoice`) rather than relying on a consultant-issued invoice; this is the design intent recorded in ADR 26, not yet shipped — the model lands with PR-E (`feat/finance-b2c-tax-invoice`, in flight). Place of supply for a consumer defaults to the **supplier's home state under Section 12(2)(b) of the IGST Act** whenever no buyer address is on record, which makes the fallback supply intra-state (CGST + SGST) — the opposite of the B2B derivation's IGST fallback, which stays as an audit signal for org invoices only. **GST-TCS under Section 52 does not apply under this model and is not collected**; the dormant schema (`Payment.gstTcsCollectedPaise`, `GstTcsBatch`, the GSTR-8 draft builder) stays in the tree, correctly annotated at 0.5%, and is only wired if a chartered accountant overturns this decision. See ADR 26 for the full CA question list, including whether a platform-funded referral credit should reduce the taxable value under Section 15(3)(a).

## What it is

GST has four interlocking obligations for an e-commerce operator (us):

1. **GST registration (Sec 24(x))** — mandatory for the platform regardless of turnover.
2. **Tax invoice (Rule 46)** — must be issued for every taxable supply; specific format + HSN/SAC + place-of-supply rules. _(Rate context, verified 2026-06-05: the GST 2.0 rationalization — 56th GST Council, 3-Sep-2025, effective 22-Sep-2025 — collapsed the four-slab structure into two main slabs **5% + 18%** (plus 40% sin/luxury); the 12% and 28% slabs were removed. **Professional / consulting / commercial-training services stay at 18%** — so the CGST 9% + SGST 9% / IGST 18% derivation below is unchanged.)_
3. **TCS Section 52 (facilitator-model reference only, not a current obligation)** — under the e-commerce-operator/facilitator framing, the platform would collect **0.5% (0.25% CGST + 0.25% SGST, or 0.5% IGST)** on the **net taxable value** of supplies of registered consultants and file **GSTR-8** monthly. Under the principal-supplier model this document now uses (ADR 26, #1360), the platform is the supplier of record, so Section 52 TCS does not apply and is not collected; this obligation is CA-gated and only becomes live if a chartered accountant overturns the principal-supplier decision. _(Rate context if reversed: halved from 1% by Notification 15/2024-Central Tax + the parallel IGST/UTGST notifications, w.e.f. 10 Jul 2024 — verified 2026-06-05.)_
4. **E-invoicing (Notif 10/2023)** — mandatory for any registered person with aggregate annual turnover (AATO) ≥ ₹5 cr (threshold unchanged as of 2026-06-05); voluntary B2C pilot launched Sep 2024. _(Separate 30-day IRP-reporting cut-off applies at AATO ≥ ₹10 cr since 1-Apr-2025.)_

Plus the orthogonal obligations:

- **Place of supply** (IGST Sec 12 / 13) — determines IGST vs CGST+SGST.
- **HSN/SAC codes** — mandatory on invoice; B2C reporting in GSTR-1 Table 12 is optional below ₹5 cr AATO. ⚠️ **SAC correction (verified 2026-06-05): `999293` is _commercial training & coaching_ (an education code under group 9992), NOT consulting. Management consulting is `998311`. All of 998311 / 999293 / 999294 / 999299 carry 18% GST, so the _rate_ is unaffected — but the doc's old "999293 (consulting)" labelling and the code's 999293 catch-all are a classification (ITC-trail) inaccuracy, not a tax-amount error.**
- **LUT (Letter of Undertaking)** — for zero-rated exports without IGST payment.
- **Reverse charge (RCM)** — for imports of services and notified categories.
- **GST credit note (Sec 34)** — required on refund / cancellation / discount post-invoice. See [doc 05](./05-refund-and-chargeback-tax-adjustments.md).

## When it applies

### B2B (org-sponsored)

- Org-issued tax invoice → applies. `OrganizationInvoice` model is real.
- TCS Sec 52 → **N/A**. No ECO event in B2B; the org pays the platform on consolidated invoice; there's no "supply by registered person through ECO" in this leg.
- Place of supply uses **org's GST state** (`Organization.gstStateCode`).
- E-invoicing IRN → applies if AATO ≥ ₹5 cr (Practitionist's AATO determines this on a rolling-year basis). Connector + cron now live as of Round 2.
- LUT → applies for org invoices billed to non-resident parents (GCC / overseas HQ) with India delivery.
- Credit note on org refund → applies.

### B2C (consumer marketplace)

- Consumer tax invoice → applies. `Invoice` model is real; `ConsumerInvoiceDocument` PDF template exists at `lib/pdf/invoice-renderer.tsx`.
- TCS Sec 52 → **applies** when the consultant is GST-registered. **Does not apply** to unregistered consultants (their supply isn't taxable) but the platform still has Sec 24(x) registration obligations.
- Place of supply uses **consumer's state** (need to capture; see Gap below).
- E-invoicing IRN for B2C → currently a **voluntary pilot** (54th GST Council, Sep 2024). Don't enable on B2C until mandated.
- LUT → applies for non-resident consumer payments (zero-rated export under IGST Sec 16).
- Credit note on consumer refund → applies; currently missing.

## Current code

| File                                                                     | What it does                                                                                                                    | State                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `lib/compliance/gst.ts:68–128`                                           | `deriveGstBreakdown` — zero-rated export, intra-state CGST 9%+SGST 9%, inter-state IGST 18%, HSN defaulting                     | ✅ live                             |
| `lib/compliance/irp.ts`                                                  | `generateIrn` — env-gated ClearTax connector                                                                                    | ✅ live                             |
| `jobs/compliance/irp-uploader.ts`                                        | Daily cron — eligible invoices → `generateIrn` → persist IRN                                                                    | ✅ wired (Round 2, daily 02:30 UTC) |
| `lib/pdf/invoice-renderer.tsx`                                           | `ConsumerInvoiceDocument` + `OrganizationInvoiceDocument` PDF                                                                   | ✅ live                             |
| `OrganizationInvoice` (schema)                                           | igstPaise / cgstPaise / sgstPaise / placeOfSupply / lutNumber / irn / ackNumber / signedQrPayload / irpStatus / retry telemetry | ✅ schema-final                     |
| `Invoice` (schema, B2C)                                                  | Has HSN / GST split fields                                                                                                      | ✅ schema-final                     |
| `Payment.consumerStateCode`                                              | **Missing**                                                                                                                     | 🔴                                  |
| `Payment.gstTcsCollectedPaise` + `ConsultantEarnings.gstTcsAccruedPaise` | **Missing**                                                                                                                     | 🔴                                  |
| GSTR-8 monthly export                                                    | **Missing**                                                                                                                     | 🔴                                  |
| GSTIN registry verification (live API)                                   | Format-only (`isValidGstin`)                                                                                                    | 🔴                                  |
| Reverse charge routing                                                   | Schema field exists; no routing                                                                                                 | 🔴                                  |
| LUT enforcement                                                          | Schema field exists; no enforcement                                                                                             | 🔴                                  |
| Credit note on refund                                                    | **Missing** entirely                                                                                                            | 🔴                                  |
| HSN selection per appointment type                                       | Static default (999293 catch-all) in PDF — should be 998311 consulting / 999293 training                                        | 🟡                                  |

## Gap

1. **TCS Sec 52 entirely missing** — see `02-gst-tcs-section-52` walkthrough below.
2. **Place-of-supply state capture missing on B2C checkout** (CBIC Notification 02/2023-IT mandates it).
3. **GST credit notes on refunds missing** (handled in [doc 05](./05-refund-and-chargeback-tax-adjustments.md)).
4. **GSTIN live registry verification missing** — only format check today.
5. **HSN selection static** — should pick **998311** (management consulting, group 9983) for CONSULTATION; **999293** (commercial training & coaching, group 9992) for WEBINAR / CLASS / SUBSCRIPTION on educational content. _(See header SAC correction — 999293 is training, NOT consulting; both 18%, so this is a classification/ITC-trail fix, not a rate fix.)_
6. **LUT enforcement** — invoice generator doesn't gate on `lutNumber` for non-resident purchases.
7. **RCM routing** — schema field present; no logic.

## TCS Section 52 walkthrough

This is the largest discrete gap. What it requires:

| Item          | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rate**      | **0.5% total — 0.25% CGST + 0.25% SGST (intra-state) or 0.5% IGST (inter-state)**. Halved from 1% by Notif 15/2024-CT (+ parallel IGST 02/2024-IT / UTGST) w.e.f. 10-Jul-2024 (verified 2026-06-05). **No TCS rate constant is wired anywhere in `lib/` or `jobs/` (verified 2026-06-05 — `GstTcsBatch` stores `netSupplyPaise` / `tcsCollectedPaise` only, with no rate literal or stale "1%" comment); collection is stubbed pending CA signoff, so there is no incorrect _computation_ in production.** When collection is wired, hardcode 0.5%, not 1%. |
| **Base**      | Net taxable value of supplies through ECO = gross supplies − returns/refunds (Sec 52(3) + Rule 67(1))                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Frequency** | Monthly. **GSTR-8 due 10th of following month.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Liability** | Platform deposits to govt; consultant claims credit in GSTR-2B.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Penalty**   | Equal to TCS not collected (Sec 122(1)(viii)) + 18% p.a. interest (Sec 50(3))                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Implementation:

```
Payment success
  ↓
Compute net taxable amount (gross − refunds)
  ↓
If consultant.gstin → write Payment.gstTcsCollectedPaise + ConsultantEarnings.gstTcsAccruedPaise
  ↓
Monthly aggregator → GstTcsBatch (one per month per consultant)
  ↓
GSTR-8 export (CSV in GSTN format) → file via portal or GSP partner (IRIS / ClearTax)
```

## Required

Phased — TCS first because it has a deadline (monthly):

1. **Schema**: add `Payment.consumerStateCode` (2-char), `Payment.gstTcsCollectedPaise` (Int), `ConsultantEarnings.gstTcsAccruedPaise` (Int), `GstTcsBatch` model (id, monthYear, consultantProfileId, totalSuppliesPaise, tcsCollectedPaise, gstr8Filed Boolean, filedAt). Migrate via Supabase MCP.
2. **`lib/payments/operations/checkout.ts`**: capture `consumerStateCode` from billing address; pass to `deriveGstBreakdown` for B2C path; emit `Payment.gstTcsCollectedPaise` when `consultant.gstin` is set.
3. **`lib/payments/operations/refund.ts`**: emit GST credit note (see [doc 05](./05-refund-and-chargeback-tax-adjustments.md)) and reduce TCS collected for the affected month's batch.
4. **Cron `jobs/gst/aggregate-tcs-batches.ts`**: run on 1st of each month for the prior month — group `Payment.gstTcsCollectedPaise` by consultant, write `GstTcsBatch` rows.
5. **GSTR-8 CSV export**: `app/api/admin/gst/gstr8/[monthYear]/route.ts` returning the filing-ready CSV.
6. **HSN selection logic**: read appointment type → pick **998311** (consulting) vs **999293** (training/coaching). Update `lib/pdf/invoice-renderer.tsx`.
7. **LUT enforcement**: in invoice generator, if `buyerCountry !== "IN"` and platform's LUT is on file, mark `lutNumber` on the invoice; otherwise charge IGST and let the consultant claim the export refund.
8. **GSTIN live verification**: integrate GSTN API (or GSP partner) at consultant onboarding.

## Acceptance

- A B2C purchase by a Karnataka consumer of a Karnataka-registered consultant: invoice shows CGST 9% + SGST 9%, place of supply = KA.
- Same purchase by a Tamil Nadu consumer: invoice shows IGST 18%, place of supply = TN.
- Same purchase by a US consumer: invoice shows zero GST, "Zero-rated export under IGST Sec 16", LUT number on the invoice.
- **CA-gated, not applicable today:** if a chartered accountant overturns the principal-supplier model (ADR 26), a purchase by any consumer of a GST-registered consultant would emit `Payment.gstTcsCollectedPaise` = **0.5%** of net (0.25% CGST + 0.25% SGST intra-state, or 0.5% IGST inter-state), and a monthly cron would write a `GstTcsBatch` per consultant whose GSTR-8 export passes GSTN sandbox validation. Under the current principal-supplier model neither field is populated and no GSTR-8 is filed.
- A refund post-invoice issues a GST credit note (see doc 05).

## Don't build

| Don't build                      | Reason                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| Internal IRP integration         | Use a licensed GSP connector (ClearTax / IRIS / Masters India). Already integrated. |
| B2C IRN today                    | Voluntary pilot only. Wait for mandatory rollout.                                   |
| Self-managed GSTN portal session | GSP partners provide stable APIs; don't reverse the portal.                         |

## References

- [Rule 46 — Tax Invoice (CBIC)](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter6/rule46_v1.00.html)
- [GSTR-8 (ClearTax)](https://cleartax.in/s/gstr-8)
- [HSN/SAC requirement clarification (A2Z Taxcorp)](https://a2ztaxcorp.net/cbic-issued-clarification-on-gstns-tweet-hsn-code-requirement-in-gstr-1-mandatory-for-b2b-optional-for-b2c-below-%E2%82%B95-crore-turnover/)
- [Place of supply for online services (VJM Global)](https://www.vjmglobal.com/blog/clarification-on-place-supply-online-services-supplied-by-suppliers-services-to-unregistered-recipients)
- [GST Sec 9(5) — when ECO is deemed supplier (ClearTax)](https://cleartax.in/s/gst-on-notified-services-ecommerce-operators-95) — _not applicable to consulting/education; we're a facilitator, not deemed supplier_
- [GST 2.0 two-slab rationalization (5% + 18%), effective 22-Sep-2025 — PIB](https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/sep/doc202594628401.pdf) — _verified 2026-06-05; professional services remain 18%_
- [SAC 998311 = management consulting; 999293 = commercial training & coaching, both 18% (ClearTax SAC 9983)](https://cleartax.in/s/other-professional-services-gst-rates-sac-code-9983) — _verified 2026-06-05_
- [GST TCS §52 halved 1% → 0.5% by Notif 15/2024-CT, w.e.f. 10-Jul-2024 (GST Safar)](https://gstsafar.com/tcs-rate-for-e-commerce-operator/) — _verified 2026-06-05_
- [E-invoice AATO ≥ ₹5 cr unchanged; 30-day IRP reporting at ₹10 cr since 1-Apr-2025 (Tally)](https://tallysolutions.com/accounting/e-invoicing-rules-in-india/) — _verified 2026-06-05_
- See also: [05](./05-refund-and-chargeback-tax-adjustments.md) (credit notes), [07](./07-cross-border-flows.md) (LUT, RCM, IGST Sec 16).
