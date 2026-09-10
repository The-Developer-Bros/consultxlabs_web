# Tax, GST, TDS & Invoicing

> **Verdict pass 2026-09-03/04.** Every money claim in this file was re-checked against `dev@e1766fa2d` and the live database as part of the 2026-09-03 finance-subsystem verification. Of 11 claims, 8 are still true today, 1 have been addressed since this dossier was written, and 2 are stale. See [`docs/payments/audits/2026-09-03-finance-verdicts.md`](../../docs/payments/audits/2026-09-03-finance-verdicts.md) for the per-item disposition.

## Context

B2B enterprise tax is relatively mature: GST breakdown (`lib/compliance/gst.ts`), org invoices with sequential numbering, credit notes, MSME 43B(h) dates, TDS derivation for org payouts, IRP uploader gated by `ENABLE_IRP_UPLOADER`. B2C marketplace tax is weaker: wrong/legacy TDS path risk, GST TCS Sec 52 schema-only, place-of-supply state not captured at consumer checkout, legal docs still have placeholders elsewhere.

Key paths: `lib/compliance/`, `lib/payments/tax/`, `docs/compliance/15-india-compliance-shipping-checklist.md`.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short)                                       | Verdict                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| B2C consultant TDS still on 194J (P0)               | ❌ STALE — 194-O is live via `computeTdsForPayout` (payout-service.ts:592-607)                    |
| GST TCS / GSTR-8 batching not wired (`GstTcsBatch`) | 🟡 LEGIT-DEFERRED                                                                                 |
| Refund tax cascade incomplete                       | ❌ OVERSTATED — `TdsAdjustment` (reversal) and `GstTcsAdjustment` are both wired from `refund.ts` |
| Form 15CA/CB stub returns nulls                     | 🟡 LEGIT-DEFERRED (explicit stub in `form15.ts`)                                                  |
| IRN filing gated (ClearTax)                         | 🔵 TRACKED #713                                                                                   |
| HSN defaults static                                 | 🟡 LEGIT-DEFERRED                                                                                 |
| Consultant GSTIN format-only, no registry check     | 🟡 LEGIT-DEFERRED                                                                                 |

## Known gaps / bugs

- B2C consultant TDS on the deprecated 194J@10% path — the 2026-09-03 verdict pass marked this stale: 194-O is already live via `computeTdsForPayout` (payout-service.ts:592-607).
- GST TCS / GSTR-8 batching not wired (`GstTcsBatch` schema-only).
- Refund tax cascade incomplete for some adjustment models — the 2026-09-03 verdict pass marked this overstated: `TdsAdjustment` and `GstTcsAdjustment` are both wired from `refund.ts`.
- Form 15CA/CB stub returns nulls — cross-border payouts blocked/deferred.
- IRN filing gated; ClearTax credentials required.
- HSN defaults static; webinar/class may need different codes.
- Consultant GSTIN verified as format only — no GSTN registry live check.

## Unhappy paths & user psychology

- Consultant receives payout net of “wrong” TDS; CA complains; platform reputation with experts collapses.
- Org finance team cannot download IRN-ready invoices before ₹5cr AATO threshold — still need process clarity.
- Consultee wants GST invoice for personal booking; B2C invoice story unclear vs org invoices.
- Dispute/refund after invoice issued — credit note not visible to customer.

## Questions (handled?)

1. **Consolidate TDS engines before any B2C live payout?**
   - A) Hard cutover to `lib/compliance/tds.ts` only, CA-signed rates
   - B) Keep dual until B2C GMV threshold
   - C) Outsource all TDS calc to CA spreadsheet

**Recommendation: A.** Wrong 194J vs 194-O rates on live B2C payouts is a P0 expert-trust and compliance failure — cut over to one CA-signed engine first.

- Not B: Dual engines until a GMV threshold guarantees some consultants are under-withheld or over-withheld in prod.
- Not C: Spreadsheet TDS cannot stay consistent with ledger clawbacks and concurrent payout batches.

> 🎯 Locked: the premise is ❌ STALE — the consultant payout path already withholds at 194-O via `computeTdsForPayout`, so no cutover is required.

2. **When does GSTR-8 / TCS become launch-blocking?**
   - A) Before first B2C payout
   - B) After N consultants registered
   - C) Defer with CA retainer filing manually

**Recommendation: C.** After TDS unification, design-partner GSTR-8 can be filed via CA retainer until collection volume justifies productized TCS batches.

- Not A: Blocking every B2C payout on schema-only `GstTcsBatch` stalls Path C after the higher-priority TDS fix.
- Not B: Consultant headcount is a weak proxy for TCS liability and still leaves early GMV unfiled.

> 🎯 Locked: rec C — GST TCS / GSTR-8 batching is LEGIT-DEFERRED; file via CA retainer until volume justifies productised TCS.

3. **IRP — enable for all orgs or only above AATO?**
   - A) Flag on for everyone with ClearTax
   - B) PENDING IRN below threshold
   - C) PDF-only until first audit

**Recommendation: B.** Keep IRN pending below AATO and enable ClearTax IRP where the threshold actually requires it.

- Not A: Forcing IRP for every org adds ClearTax cost/ops before legal necessity.
- Not C: PDF-only past the threshold is non-compliant once e-invoicing applies.

> 🎯 Locked: rec B — IRN stays PENDING below AATO and gated behind #713 (ClearTax) where the threshold requires it.

## High concurrency / multi-device

Invoice numbering uses per-org counters — concurrent invoice generation must stay gapless (CGST Rule 46). Parallel refunds minting credit notes need unique constraints (`CreditNote.refundId`). Multi-admin tax settings edits should use optimistic versioning where present.

## Suggested directions

Treat tax go-live as a finance+legal gate separate from product feature flags. Unify TDS first; then TCS; then IRP.
