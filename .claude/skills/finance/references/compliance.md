# Regime facts the code encodes

This page collects the tax and filing facts the finance code assumes, so a change can be checked against the actual statutory shape rather than a remembered approximation. It does not re-derive the law; it points at the ADR or compliance doc that does, and states the number the code currently uses.

## Income tax: Section 194-O withholding

The platform withholds under Section 194-O — now Section 393(1) Table Sl.8(v) of the Income-tax Act, 2025, payment code 1035 — as an e-commerce operator paying an e-commerce participant, at **0.10%** of the gross consideration. CBDT Circulars 17/2020 and 20/2021 are explicit that the operator's retained commission is not deductible from that base, and `lib/compliance/tds-194o.ts` computes the taxable base as the gross sale, never the platform's fee alone.

The ₹5,00,000-per-financial-year exemption applies only when all three limbs hold at once: the participant is an individual or a HUF, gross financial-year receipts do not exceed the threshold, and PAN or Aadhaar has been furnished. Companies, partnerships, and LLPs are withheld from the first rupee with no threshold at all. A missing PAN triggers 194-O's own 5% no-PAN rate, distinct from the 20% fallback that applies to Sections 194J and 194C, so the code must not collapse the two rates into one constant.

The `TDS_ENGINE` default is CA-gated: `lib/payments/tax/tds-service.ts` (the deprecated consultant path, still flat 10% under a 194J framing) has not yet been consolidated onto `lib/compliance/tds.ts` (the canonical, org-and-consultant path that already carries the correct 194-O rate, threshold, and no-PAN fallback), pending a chartered accountant's sign-off on 194-O precedence for every consultant payout shape.

## Form numbering under the Income-tax Act, 2025

The 2025 Act, in force from 1 April 2026, consolidates every non-salary TDS provision into Section 393 and retires the old alphanumeric section numbers as filing citations. The forms this platform's payout and filing tooling references are renumbered accordingly: **Form 26Q becomes Form 140**, **Form 27Q becomes Form 144**, and **Form 16A becomes Form 131**. The portal validates the section codes on a return against the Income-tax Act 2025 numbering, so a return filed for a transaction on or after 1 April 2026 that still cites `"194O"` rather than the numeric payment code is expected to fail that validation, per the CBDT's "Updated FAQs on Interplay & Transitions". This platform emits the new codes, so the question does not arise for a return it generates. That translation is why `TDSRecord.tdsSection` and `OrganizationPayout.tdsSectionApplied` — both of which still store the old labels for internal classification — must be translated to the §393 payment code at the point a return is generated, not retroactively in the database.

## GST: principal-supplier model (ADR 26)

The platform bills GST as **principal supplier**, not as a facilitator: 18% GST on the full discounted booking price, credited to `GST_PAYABLE` at settlement, with the platform issuing its own tax invoice and credit note rather than relying on the consultant to invoice the buyer. This decision is why **GST-TCS under Section 52 does not apply and is not collected** here — TCS is a facilitator-model obligation, and adopting it alongside principal-supplier GST would double-collect on the same supply. The dormant TCS schema (`Payment.gstTcsCollectedPaise`, `GstTcsBatch`, the GSTR-8 draft builder) stays in the tree at the correct 0.5% rate, annotated as CA-gated, and is wired only if ADR 26 is overturned.

Consulting is not a Section 9(5) notified service, so neither the principal nor the facilitator reading is compelled by statute; ADR 26 records it as a business-model choice pending a chartered accountant's sign-off, alongside four other open questions: whether a platform-funded referral credit reduces the taxable value under Section 15(3)(a) or counts as third-party consideration that does not, whether the Section 12(2)(b) supplier-state default is acceptable for a consumer who declines to give a state or whether checkout must collect one before payment, and whether Section 52 TCS registration is unnecessary while the platform is the supplier of record.

## SAC classification

The platform's outward supply defaults to SAC **999293** (commercial training and coaching, under group 9992), which is what the code currently emits for every consumer document. For an advisory consultation, **998311** (management consulting) or **998399** may be the more accurate classification (#1369). All of 998311, 999293, 999294, and 999299 carry the same 18% rate, so this is an input-tax-credit and audit-trail question, not a tax-amount error, and changing the default does not change what a buyer owes.

## Consumer document numbering

`ConsumerInvoice` and `ConsumerCreditNote` run on a platform-wide gapless series, not a per-buyer one, because the platform is the supplier of record. Invoices are numbered `FAM-<FY>-<SEQ5>` (for example `FAM-2026-00001`, ceiling 99,999 per fiscal year); credit notes are numbered `FAM-CN-<FY>-<SEQ4>` (for example `FAM-CN-2026-0001`, ceiling 9,999 per fiscal year) on a separate series because CGST Rule 53 requires it. Both series use `PLATFORM_INVOICE_PREFIX` (default `FAM`), capped to sixteen characters by `fitPrefixToRule46`, and both allocate their sequence number only after the idempotency probe on `paymentId` confirms no document already exists — allocating first and probing second would leave a permanent gap in a gapless series on a webhook redelivery.

## Period boundaries are IST

Every fiscal-year and monthly-period boundary in the compliance pipeline — `indianFiscalYear`, the outward-register export's monthly window, the quarterly TDS return draft — is reckoned in IST, not UTC. A document minted in the last hours of 31 March IST must land in the fiscal year that is ending, not the one beginning, and the register export explicitly runs for "the previous IST calendar month" rather than a UTC month, because the two disagree for part of every day.

## Supplier state is GSTIN-first

`resolveSupplierStateCode` reads the platform's own state of registration from the first two digits of `PLATFORM_GSTIN`, and falls back to the `SUPPLIER_STATE_CODE` environment variable only when the GSTIN itself carries no state. If the two disagree, the mint fails closed exactly as a missing GSTIN does — no document is issued, and a `SystemEvent` names both conflicting values so an operator can fix the configuration rather than shipping a document with an internally inconsistent state.

## The outward register, not an in-app GSTR builder

`jobs/compliance/gst-outward-register-export.ts` produces a monthly CSV register of every consumer invoice, organisation invoice, and credit note issued in the period, on the third of the month for the previous IST calendar month, ahead of the eleventh-of-the-month GSTR-1 deadline. The chartered accountant files GSTR-1 and GSTR-3B from that export; the platform does not build an in-app GSTR-1 or GSTR-3B JSON generator, because the register is the one artifact both the platform's own reconciliation and the CA's filing tooling need, and a second, parallel builder would be a second place for the two to drift.

## Open questions for the chartered accountant

The five questions ADR 26 records are unresolved by design, not by oversight, and any change to GST or referral-credit handling should check whether it depends on one of these answers before shipping: (1) whether the principal-for-GST plus 194-O-operator pairing holds for a marketplace where the platform sets the commission but the consultant sets the price; (2) whether a referral credit reduces the taxable value or is third-party consideration; (3) whether 999293 or 998311/998399 is the correct SAC code; (4) whether the Section 12(2)(b) default is acceptable without a mandatory state field at checkout; (5) whether Section 52 TCS registration is required at all under this model.

## Sources

`docs/compliance/01-tds-overview.md`, `docs/compliance/02-gst-overview.md`, `docs/enterprise/70-design-decisions/26-gst-principal-model.md`, `docs/payments/07-b2c-tax-invoice.md`, `lib/compliance/tds-194o.ts`.
