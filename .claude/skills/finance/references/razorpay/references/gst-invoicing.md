# GST invoicing

The single most important fact: **Razorpay's Invoices API cannot produce a GST-compliant
invoice, and this repo does not try.** GST invoicing is entirely in-house.

## Why the Razorpay Invoices API is not the answer

Razorpay's own documentation says it outright:

> You cannot create GST compliant invoices using APIs. This means you cannot add the
> following to the invoice when creating an invoice via APIs: tax rate, cess, HSN code,
> SAC code.

The invoice *entity* has all the tax fields — `tax_amount`, `taxable_amount`, `tax_rate`,
`hsn_code`, `sac_code`, `taxes[]`, invoice-level `gstin` — but they are read-only for
API-created invoices and stay null or zero. They are populated only for invoices created
through the Dashboard. On create you may set `name`, `description`, `amount`, `currency`
and `quantity`, and nothing else.

So the pattern of adding "CGST @ 9%" and "SGST @ 9%" as separate line items **does not
produce a compliant tax document**. It produces a line-itemised receipt that happens to
mention GST. If you ever create a Razorpay invoice here, treat it as a payment-collection
artifact only — never as the tax document.

Source: <https://razorpay.com/docs/api/payments/invoices/create-with-details/>

## What this repo actually does

| Concern | Where |
|---|---|
| CGST/SGST/IGST split | `deriveGstBreakdown()` in `lib/compliance/gst.ts` |
| Place of supply | `resolvePlaceOfSupply()`, `isValidGstin()` in the same file |
| Checkout-time tax | `determineTax()` in `lib/payments/tax/tax-engine.ts` |
| Invoice numbering | `lib/payments/billing/invoice-numbering.ts` (CGST Rule 46) |
| Credit notes | `lib/payments/billing/credit-note-numbering.ts` (Rule 53) |
| PDF rendering | `lib/pdf/invoice-renderer.tsx` |
| E-invoicing / IRN | `lib/compliance/irp.ts`, `jobs/compliance/irp-uploader.ts` |
| The stored document | the `OrganizationInvoice` model |

## The split rule

Place of supply decides everything:

- Buyer outside India → **zero-rated** export, no GST.
- Buyer's state **equals** the supplier's state → **CGST + SGST**, half each.
- Buyer's state **differs** → **IGST**, the whole levy.

`deriveGstBreakdown` falls back to IGST when the buyer's state is unknown — a documented,
deliberate gap, not a bug to "fix" without thinking about the consequences.

Rounding is not free-form: the levy is `Math.round`ed once, then split floor-and-remainder
so CGST + SGST always re-add to the exact total. Never compute the two halves
independently — odd paise will drift and the invoice will not foot.

**Every GST field is an integer number of paise.** No floats anywhere near tax.

## SAC / HSN codes

Derive them from `lib/payments/payouts/constants.ts` — `999293` consulting, `999294`
education, `999295` training — and note `OrganizationInvoice.hsnCode` already defaults to
`999293`. Do not hardcode a different code in new work: generic SaaS advice reaches for
`998314`/`998315` (IT design and development), which is the wrong family for a consulting
marketplace and would put generated invoices out of step with the payout constants.

## Numbering is a compliance surface

Rule 46 requires a gapless, sequential series per financial year. `OrgInvoiceCounter` and
`OrgCreditNoteCounter` provide that with an atomic upsert-returning per org per FY. Do not
generate invoice numbers in application code, do not reuse a number, and do not backfill
one into a gap.

## Deferred, on purpose

GST TCS under section 52 (`GstTcsBatch`, `GstTcsAdjustment`,
`Payment.gstTcsCollectedPaise`) is flag-gated pending CA signoff, and the IGST-vs-CGST
split at **B2C** checkout is explicitly deferred — `Payment.consumerStateCode` is captured
so the data exists when it is turned on. Live IRP upload is stubbed; the field shape is
final.
