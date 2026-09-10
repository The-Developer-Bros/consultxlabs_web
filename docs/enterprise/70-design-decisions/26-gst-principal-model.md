---
title: GST — the platform bills as principal supplier
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-09-03
---

# ADR 26 — GST: the platform bills as principal supplier

## Context

Checkout has always charged 18% GST on the full discounted booking price (`lib/payments/pricing/derive-checkout-amount.ts` → `lib/payments/tax/tax-engine.ts`), and the booking journal credits `GST_PAYABLE` for that amount (`lib/payments/payouts/earnings-service.ts`). That is the behaviour of a supplier of record: the platform sells the consultation to the buyer and remits output tax on the whole consideration. Income tax was wired the other way round: the platform withholds Section 194-O as an e-commerce operator paying an e-commerce participant (`lib/compliance/tds-194o.ts`, `lib/compliance/tds.ts`), which is the behaviour of a facilitator.

The 2026-09-03 financial audit assumed the facilitator reading for GST as well and filed GST-TCS Section 52 collection (#1360) and GSTR builders (#1361) as launch blockers. The two readings cannot both drive the code: a facilitator charges GST only on its commission and collects 0.5% TCS on registered suppliers' sales; a principal charges GST on the whole price, issues the tax invoice to the buyer, and collects no TCS because it is the supplier. Consulting is not a Section 9(5) notified service, so neither reading is forced by statute; it is a business-model choice with a chartered accountant's sign-off.

## Decision

The platform bills as **principal supplier for GST**. Concretely:

1. GST stays at 18% on the full discounted price, booked to `GST_PAYABLE` at settlement, exactly as today.
2. The platform will issue a numbered **B2C tax invoice** for every consumer supply and a **credit note** for every refund (`ConsumerInvoice`, `ConsumerCreditNote`, platform-wide gapless series under CGST Rule 46 and Rule 53), alongside the existing org invoices for sponsored supplies. This is design intent, not yet shipped: the models do not exist in the schema as of this ADR and land with PR-E (`feat/finance-b2c-tax-invoice`, in flight).
3. Place of supply for a consumer is the declared or remembered billing state; when no address is on record, it defaults to the **supplier's state under Section 12(2)(b)** of the IGST Act, which makes the supply intra-state (CGST + SGST). This is the opposite of the B2B derivation's IGST fallback, which stays as an audit signal for org invoices.
4. GST-TCS under Section 52 **does not apply** on this model and is not collected. The dormant schema (`Payment.gstTcsCollectedPaise`, `GstTcsBatch`, the GSTR-8 draft builder) stays in place, correctly annotated at 0.5%, and is only wired if the CA overturns this decision.
5. The platform's own outward-supply return is produced as a period **register export** (all tax invoices and credit notes, with place of supply and tax heads) that the CA files GSTR-1 and GSTR-3B from. No in-app GSTR JSON builders.
6. Income tax is unchanged: 194-O at 0.1% with the three-limb ₹5 lakh exemption, withheld on both the consultant and the host-org payout rails and reported on Form 140 (formerly 26Q) with Section 393 payment codes.

## Alternatives considered

The facilitator model — GST only on the platform's commission, 0.5% Section 52 TCS collected on registered consultants' sales, and monthly GSTR-8 filing — was rejected because it does not match the code that already exists: checkout has always charged 18% GST on the full discounted price and the booking journal has always credited `GST_PAYABLE` for that full amount, which is principal-supplier behaviour, not facilitator behaviour. Adopting the facilitator reading now would mean re-deriving every historical GST figure, wiring the dormant TCS schema, and building GSTR-8 tooling that the platform does not currently need — a pricing, invoice and ledger re-architecture rather than a continuation of the current design. It remains the fallback if the CA rejects the principal-supplier pairing (see Consequences below).

## Consequences

Every consumer payment will leave a statutory document trail the buyer can download once the B2C tax-invoice work lands, which closes the "incomplete information" gap in the money journey; that work (`ConsumerInvoice`, `ConsumerCreditNote`) is in flight and not yet in the schema (tracked as PR-E, `feat/finance-b2c-tax-invoice`). The register export gives the CA one file per month instead of a database query, once it ships alongside the invoices. Consultants who hold a GSTIN invoice the platform, not the buyer; that is a contractual and onboarding matter, not a code path, and belongs in the consultant terms.

The pairing of principal-for-GST with operator-for-income-tax is defensible but unusual, and it is the first question on the CA list below. If the CA rejects it, the facilitator model is a pricing, invoice and ledger re-architecture (GST only on the platform fee, TCS on registered consultants, GSTR-8 monthly) and would be a new ADR.

## Questions for the chartered accountant

1. Does the principal-for-GST plus 194-O-operator pairing hold for a consultation marketplace where the platform sets the commission but the consultant sets the price and delivers the service?
2. Referral credits are platform-funded and are applied **after** tax at checkout (price → discount code → tax → credits), so a buyer using a ₹500 credit pays GST on the pre-credit base. Is a platform-funded credit a discount recorded on the invoice under Section 15(3)(a), which would reduce the taxable value, or third-party consideration, which would not? The code path is `deriveCheckoutAmount`; nothing changes until this is answered.
3. SAC classification: the platform defaults to 999293 (commercial training and coaching). For advisory consultations 998311 or 998399 may be the correct code; rates are unaffected, input-tax-credit trails are not.
4. Is the Section 12(2)(b) supplier-state default acceptable for consumers who decline to declare a state, or must the checkout collect a state before payment?
5. Confirm that Section 52 TCS registration is not required while the platform is the supplier of record.

## Related

- ADR 21 (single writer for payment confirmation) — the invoice is minted inside the same pipeline, never by a second writer.
- ADR 08 (gapless invoice counters) — the platform series reuses the same atomic counter shape.
- docs/compliance/02-gst-overview.md, docs/compliance/15-india-compliance-shipping-checklist.md, docs/compliance/10-rbi-pa-and-payment-architecture.md (Path C).
- #1360 (relabelled CA-gated), #1361 (re-scoped to the register export), #1365, #1370.
