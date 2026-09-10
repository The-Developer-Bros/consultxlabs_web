# B2C vs B2B Compliance Gaps

> **Verdict pass 2026-09-03/04.** Every money claim in this file was re-checked against `dev@e1766fa2d` and the live database as part of the 2026-09-03 finance-subsystem verification. Of 9 claims, 3 are still true today, 3 have been addressed since this dossier was written, and 3 are stale. See [`docs/payments/audits/2026-09-03-finance-verdicts.md`](../../docs/payments/audits/2026-09-03-finance-verdicts.md) for the per-item disposition.

## Context

Enterprise rail: org tax info, invoices, credit notes, MSME alerts, org payout TDS, audit export. Marketplace rail: consultant verification (manual), PAN encryption, payout tax fields — but filing automation and TCS lag. Shipping checklist grades MUST vs DEFER in `docs/compliance/15-india-compliance-shipping-checklist.md`.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short)                                                        | Verdict                                                                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dual TDS engines (#778 planned consolidation)                        | ❌ STALE — consultant path is already 194-O via `computeTdsForPayout`; `tds-service.ts` is FY-helper/audit only                                   |
| No GSTR-8 aggregator job                                             | 🟡 LEGIT-DEFERRED                                                                                                                                 |
| Refund tax adjustment wiring gaps                                    | ❌ OVERSTATED — TdsAdjustment (via reversal) and GstTcsAdjustment are both wired from `refund.ts`; only monthly `GstTcsBatch` collection deferred |
| Seller disclosure (name/address/GSTIN on public profiles) incomplete | 🟡 LEGIT-DEFERRED                                                                                                                                 |
| RBI PA Path C needs legal confirmation                               | 🎯 legal/CA gate, not code                                                                                                                        |
| Form 26Q/140 automation missing                                      | 🔵 TRACKED #737 (code cites #737; audit said #738)                                                                                                |

## Known gaps / bugs

- Dual TDS engines (#778 planned consolidation). The 2026-09-03 verdict pass marked this stale: the consultant path already runs 194-O via `computeTdsForPayout`, so `tds-service.ts` is FY-helper/audit-only, not a live second engine.
- No GSTR-8 aggregator job.
- Refund tax adjustment wiring gaps. The 2026-09-03 verdict pass marked this overstated: `TdsAdjustment` (reversal) and `GstTcsAdjustment` are both wired from `refund.ts`; only the monthly `GstTcsBatch` collection is deferred.
- Seller disclosure (legal name, address, GSTIN on public profiles) incomplete for e-commerce rules.
- RBI PA Path C needs legal confirmation (finance pack).
- Form 26Q/140 automation missing before quarterly deadlines.

## Unhappy paths & user psychology

- Registered consultant expects platform TCS handling; receives notice from GSTN.
- Org customer audits Familiarise; finds B2C gaps and extrapolates risk to B2B.

## Questions (handled?)

1. **Block B2C payouts until 194-O unified + TCS plan?**
   - A) Hard block
   - B) Soft warn + CA escrow
   - C) Proceed with documented risk acceptance

**Recommendation: A.** Unify TDS before B2C payouts — wrong 194-O path is not acceptable risk at scale.

- Not B: Soft warn still pays out on the wrong engine.
- Not C: Documented risk acceptance does not fix GSTN notices to consultants.

2. **Public seller disclosure minimum on consultant profile?**
   - A) Legal name + address + GSTIN if registered
   - B) Display name only
   - C) Disclosure only at checkout

**Recommendation: A.** E-commerce seller disclosure belongs on the public profile, not only at payment.

- Not B: Display name alone fails consumer disclosure expectations.
- Not C: Checkout-only disclosure is easy to miss and weak for trust/browse.

3. **Who files quarterly TDS returns?**
   - A) In-house automation
   - B) CA retainer
   - C) Hybrid export + CA upload

**Recommendation: C.** Hybrid export + CA upload is the realistic interim until Form 26Q automation is trustworthy.

- Not A: Full in-house automation is not ready before quarterly deadlines.
- Not B: CA-only without clean exports recreates spreadsheet chaos.

## High concurrency / multi-device

N/A beyond payout/invoice races covered in finances.

## Suggested directions

One compliance owner for the shipping checklist sign-off slots.
