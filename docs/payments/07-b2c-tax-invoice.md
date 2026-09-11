# B2C Tax Invoices and Credit Notes

> How a personal buyer gets the statutory tax invoice for their booking, how a refund reverses it with a credit note, and how both reach the monthly GSTR-1 working file. Introduced by #1365 and #1370.

---

## Why this exists

The platform bills as the principal supplier for GST, which ADR 26 records as a locked decision. Checkout charges 18% on the discounted price through `lib/payments/pricing/derive-checkout-amount.ts` and `lib/payments/tax/tax-engine.ts`, and settlement credits `GST_PAYABLE` in `lib/payments/payouts/earnings-service.ts`. Every one of those charges is our own outward supply, so every one of them needs a document that satisfies CGST Rule 46.

Organizations already had that document: an `OrganizationInvoice` with its own gapless per-org series, its own IRP e-invoice fields and its own dunning lifecycle. Personal buyers had nothing. Between the v0 lockdown in #768 and this change, a consumer who paid 18% GST received a payment confirmation and no invoice at all, and there was no register from which the platform's own outward supplies could be filed.

This change adds the document trail and nothing else. It posts no ledger entries, it derives no tax from a rate, and it builds no IRN. Those exclusions are deliberate and are listed in full at the end of this page.

## What is minted, and when

Two models carry the documents, both defined in the invoicing section of `prisma/schema.prisma`.

| Model                | What it is                                                           | Keyed by                                |
| -------------------- | -------------------------------------------------------------------- | --------------------------------------- |
| `ConsumerInvoice`    | The Rule 46 tax invoice for one successful consumer payment.         | `paymentId`, unique.                    |
| `ConsumerCreditNote` | The section 34 credit note that reverses part or all of one invoice. | `refundId` or `disputeId`, both unique. |

`mintConsumerInvoice` in `lib/payments/billing/consumer-invoice.ts` is called from two places, because a payment reaches its confirmed state by two different routes. The capture webhook calls it from `lib/payments/webhooks/handlers.ts` once the booking is confirmed, and the instant-confirm branch of `lib/payments/operations/checkout.ts` calls it for mock, zero-amount and org-sponsored checkouts, which never see a webhook at all.

Both call sites wrap the mint in a try/catch that reports to Sentry at warning level and never rethrows. A confirmed booking must not roll back because a document could not be produced, and the monthly register export re-attempts anything that was missed.

The mint is a silent no-op, returning a null id rather than throwing, in each of these cases:

- the payment is not `SUCCEEDED`, or has been soft-deleted;
- the payment is org-funded, meaning it carries `billableToOrgInvoiceId` or any payment leg sourced from `WALLET`, `LICENSE`, `INVOICE_ACCRUAL` or `OVERAGE_INVOICE_ACCRUAL`. Those supplies are invoiced to the organization on the org series instead, and giving them a second document would double-count the same supply;
- `getPlatformSupplier()` returns null because `PLATFORM_GSTIN` is unset or malformed. The process logs this once. Issuing a legal-looking invoice with a fabricated GSTIN is worse than issuing none;
- the reconstructed total is zero or less.

The idempotency probe on `paymentId` runs before any sequence number is allocated. That ordering is load-bearing: a webhook redelivery that allocated a number first and then discovered the invoice already existed would leave a permanent gap in a gapless statutory series.

## Numbering

Consumer documents run on a platform-wide series, not a per-buyer one, because the supplier is the platform and the series belongs to the supplier. Two counter tables hold the sequences, `platform_invoice_counters` and `platform_credit_note_counters`, and each allocation is an atomic upsert that returns the pre-increment value, exactly as the org counters do.

| Document    | Format                    | Example            | Ceiling                 |
| ----------- | ------------------------- | ------------------ | ----------------------- |
| Invoice     | `<PREFIX>-<FY>-<SEQ5>`    | `FAM-2026-00001`   | 99,999 per fiscal year. |
| Credit note | `<PREFIX>-CN-<FY>-<SEQ4>` | `FAM-CN-2026-0001` | 9,999 per fiscal year.  |

`PREFIX` comes from the optional `PLATFORM_INVOICE_PREFIX` environment variable and defaults to `FAM`. It passes through `fitPrefixToRule46`, which caps the whole number at the sixteen characters Rule 46(b) allows. The credit-note series is separate from the invoice series because Rule 53 requires it to be. Both use `indianFiscalYear`, so a document issued in March lands in the previous fiscal year, reckoned in IST.

## Place of supply

Section 12(2)(b) of the IGST Act says that where the recipient's address is not on record, a B2C supply is made at the **supplier's** location. That is the opposite of the rule the B2B path follows: `deriveGstBreakdown` falls back to IGST on an unknown buyer state and records `IGST_STATE_UNKNOWN`, because a registered buyer is expected to have a state and a missing one is a defect worth surfacing. For a consumer, a missing state is the statutory norm.

`deriveConsumerInvoiceTax` is a pure function that implements this. It never re-derives tax from a rate; the taxable value is the charged total minus the charged tax, so the document agrees with the `GST_PAYABLE` credit to the paise.

The supplier's own state is settled before that derivation runs. `resolveSupplierStateCode` reads the first two digits of `PLATFORM_GSTIN`, which are the state of registration by law, and falls back to `SUPPLIER_STATE_CODE` only when the GSTIN carries none. The same resolved value is handed to the derivation and stored on the row, so the heads on the document can never disagree with the state printed beside them. When the GSTIN and the environment variable name different states the mint fails closed exactly as a missing GSTIN does: no document is issued, a Sentry warning and a `SystemEvent` name both values, and the monthly register healer re-attempts the payment once the configuration is fixed.

| Buyer state            | Result                                                                                                                  | `placeOfSupplySource`                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Same as the supplier's | CGST and SGST, split with CGST floored and SGST absorbing the odd paise                                                 | `DECLARED_AT_CHECKOUT` or `PROFILE_ON_RECORD`  |
| A different state      | IGST for the whole tax                                                                                                  | `DECLARED_AT_CHECKOUT` or `PROFILE_ON_RECORD`  |
| Absent or unresolvable | Placed at the supplier's own state, so CGST and SGST                                                                    | `SUPPLIER_DEFAULT_12_2_B`                      |
| Outside India          | Delegated to `deriveGstBreakdown` for the LUT gate, then mapped back with the amounts kept anchored to what was charged | Either, depending on whether a state was given |

Where the source is `SUPPLIER_DEFAULT_12_2_B`, the rendered PDF carries the footnote "Place of supply determined under s.12(2)(b) IGST Act (no address of the recipient on record)", so a reader can tell a defaulted place of supply from a declared one.

## Capturing the buyer's state

Checkout can ask for the buyer's state, but it never insists. `app/checkout/components/BillingStateSelect.tsx` is mounted on the consultation, subscription, webinar and class checkout pages, labelled "Billing state (for GST)", and it submits the two-digit numeric code that the GST portal, the invoice and `lib/compliance/gst.ts` all compare on. Leaving it blank is a correct answer, not an incomplete one, because the statutory default applies.

The declared value is written to `Payment.consumerStateCode` in the same transaction that creates the payment, and to `ConsulteeProfile.billingStateCode` when it differs from what the profile already held, so a repeat buyer is never asked twice. `/api/checkout/context` returns the remembered value and the checkout pages pre-fill the picker with it.

At mint time the resolution order is the declaration on the payment, then the profile, then the statutory default, and `placeOfSupplySource` records which of the three applied.

## Credit notes on refund

A refund never deletes or rewrites the invoice. `mintConsumerCreditNote` issues a section 34 credit note beside it, and the pair is what reconciles.

The reversal is strictly proportional over the tax-inclusive total and it keeps the same tax head the invoice used, because a credit note may not move a supply from one head to another.

The cap is cumulative rather than per-note. `mintConsumerCreditNote` sums the `totalPaise` of every note already issued against the invoice, inside the same transaction, and credits at most the remainder. This matters because a partial refund and a later lost chargeback are two different idempotency keys against one invoice, so neither one's probe short-circuits the other; without the cumulative cap the pair could reverse more than the platform ever charged and understate the period's output tax. When the invoice is already credited in full the note is refused, a `SystemEvent` is recorded so an operator sees it, and the caller receives a null identifier.

The heads are prorated from the invoice's total tax and then split again by the same floor-CGST rule the invoice itself used, rather than each head being prorated on its own. Flooring three heads independently leaves the stored row short of its own total by a paise or two, which the register reports as a reconciliation warning. Prorating once and letting the taxable value absorb the residual makes the identity `taxable + CGST + SGST + IGST == total` hold by construction, and no head on a note can exceed the corresponding head on the invoice.

It is called from two places, mirroring the org-side `mintRefundCreditNote` it sits beside: Step 7.5 of the refund cascade in `lib/payments/operations/refund.ts`, and the lost-chargeback branch of `app/api/webhooks/utils.ts`. Both are idempotent on their own trigger, so a webhook redelivery or a cron retry re-reads the existing note.

## Downloading a document

| Route                                                          | Returns                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------- |
| `GET /api/payments/[paymentId]/invoice/pdf`                    | A 302 to a 24-hour signed URL for the tax invoice.                  |
| `GET /api/payments/[paymentId]/credit-note/[creditNoteId]/pdf` | The same, for a credit note that belongs to that payment's invoice. |

Both routes authorise the payment's own buyer or an ADMIN/STAFF operator, apply the `moneyOpsLimiter` bucket per actor, and return 503 with code `SUPPLIER_GSTIN_UNCONFIGURED` when `PLATFORM_GSTIN` is missing, or 404 with code `INVOICE_NOT_ISSUED` when no document exists. The PDF is rendered on the first request, uploaded to the existing private `org-invoices` bucket under a `consumer/<userId>/<docId>.pdf` path, cached on the row for twenty-four hours, and re-signed without re-rendering on subsequent hits.

The documents render from the snapshot stored on the row rather than from live supplier and buyer records, because a tax invoice must keep saying what it said on the day it was issued.

Both PDFs register Noto Sans Devanagari from `public/fonts/` and apply it to the buyer's name and address only. Helvetica, which the org documents use throughout, has no Devanagari coverage, so a buyer writing in Hindi or Marathi would otherwise see their own name as a row of boxes. The font is read from a copy traced into the deployment bundle by `outputFileTracingIncludes` in `next.config.mjs`, never fetched over the network, and registration falls back to Helvetica if the file is absent rather than failing the download.

The invoice number and a download link appear on the admin payment list and detail pages, and on the consultee's own payments tab. An empty cell there means the payment was org-funded, which is the correct answer rather than a missing document.

## The outward-supplies register

`jobs/compliance/gst-outward-register-export.ts` runs on the third of each month for the previous IST calendar month, well ahead of the eleventh-of-the-month GSTR-1 deadline. `GST_REGISTER_PERIOD_START` and `GST_REGISTER_PERIOD_END` override the period and must be set together; the workflow exposes them as dispatch inputs.

It does four things in order. First it heals: any `SUCCEEDED`, non-deleted payment in the period with no consumer invoice is minted, each in its own short transaction, and a non-zero count is warned about because it means the checkout mint path missed something. Then it reads every `ConsumerInvoice`, issued `OrganizationInvoice`, `ConsumerCreditNote` and issued `CreditNote` in the period and shapes them into one register through the pure builder in `lib/compliance/gst-outward-register.ts`. Then it writes the CSV to `GST_REGISTER_CSV_OUT`, which the workflow uploads as a ninety-day artifact. Finally it stamps `gstr1ExportedAt` on everything it reported, in one transaction, guarded on the stamp being null so a second run in the same month reports the same documents again without moving anyone's first-reported timestamp.

The CSV header is fixed, because the CA's import template depends on it:

```
doc_type,doc_number,doc_date,buyer_type,buyer_gstin,place_of_supply,taxable_paise,cgst_paise,sgst_paise,igst_paise,total_paise,sac_code,original_invoice_number,payment_id
```

The builder raises a warning for any document with no place of supply, any document whose tax heads do not reconcile to the total minus the taxable value, and any B2C document of ₹50,000 or more that lacks the recipient's address and state.

The job is fail-closed on its cron lock and is on the financial job list, unlike the read-only compliance drafts beside it. Its healer allocates numbers from a gapless statutory series, and two concurrent runs would both see a payment as un-invoiced, both take a number, and one would lose the unique constraint, leaving a gap that cannot be filled. Not producing the register is recoverable; a gap in the series is not.

## The ₹50,000 flag

Rule 46 requires a B2C invoice of ₹50,000 or more to carry the recipient's name, address and state. The mint still issues the invoice when those are missing, because withholding a buyer's document is a worse outcome than issuing an incomplete one, and sets `needsBuyerAddress` on the row. The register turns that flag into a warning line so finance can chase the address before filing.

## What this deliberately does not do

- **It posts nothing to the ledger.** Output tax is already credited to `GST_PAYABLE` at settlement. A second posting from the document trail would double-count the liability.
- **It derives no tax from a rate.** The heads are split out of the tax the buyer actually paid. A rate-recomputed figure would drift from the settled amount the first time a discount or a rounding boundary moved.
- **It builds no IRN.** B2C is outside the e-invoicing scope; the IRP fields on `OrganizationInvoice` have no counterpart here.
- **It does not handle GST-TCS under section 52.** That remains with `jobs/compliance/gstr8-draft-export.ts`.
- **It does not block checkout.** The billing-state picker is optional by design, because the statutory default already produces a correct invoice.

## Related

- [B2C ↔ B2B funding seam](./05-b2c-b2b-funding-seam.md)
- [Invoicing (B2B)](../enterprise/10-money-and-ledger/08-invoicing.md)
- [Cron jobs reference](../maintenance/04-cron-jobs-reference.md)
