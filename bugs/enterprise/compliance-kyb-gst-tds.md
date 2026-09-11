# Enterprise Compliance — KYB, GST, TDS, MSME, IRP

> **Verdict pass 2026-09-03/04.** Every money claim in this file was re-checked against `dev@e1766fa2d` and the live database as part of the 2026-09-03 finance-subsystem verification. Of 12 claims, 7 are still true today, 4 have been addressed since this dossier was written, and 1 are stale. See [`docs/payments/audits/2026-09-03-finance-verdicts.md`](../../docs/payments/audits/2026-09-03-finance-verdicts.md) for the per-item disposition.

## Context

Enterprise buyers expect audit-ready invoices, TDS on org payouts, MSME timelines, and eventually IRN. Schema and helpers are deep ([`lib/compliance/`](../../lib/compliance/), org tax models, invoice counters). Several **gates are UI/docs only** — money APIs still move without KYB/domain hard checks. That is incompatible with “enterprise respect.”

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short)                                           | Verdict                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| K-01 KYB not a hard gate on INVOICE                     | 🔵/✅ partial via #991 (domain gate)                            |
| K-02 `assertVerifiedDomainOrThrow` unwired              | ✅ FIXED-BY #991 (INVOICE now hard-requires verified domain)    |
| K-03 IRP uploader gated / stub                          | 🔵 TRACKED #713                                                 |
| K-04 `requireActive` inconsistent across money surfaces | 🟡 LEGIT-DEFERRED                                               |
| K-05 MSME §16 interest not accrued                      | 🟡 LEGIT-DEFERRED                                               |
| K-06 `TdsAdjustment` / Form 26Q export schema-only      | 🔵 TRACKED #737 (audit cited #738 — misattribution)             |
| K-07 Dual TDS engines vs B2C deprecated 194J path       | ❌ STALE (194-O already live via `computeTdsForPayout`)         |
| K-08 Invoice GST not per-line; credit-note length       | 🟡 LEGIT-DEFERRED                                               |
| Refund tax cascade incomplete (implied)                 | ❌ OVERSTATED (`TdsAdjustment` + `GstTcsAdjustment` both wired) |

## Known gaps / bugs

| ID   | Severity | Issue                                                                                                                                                 |
| ---- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| K-01 | **P0**   | `OrgKybVerification.kybVerifiedAt` / Sumsub fields — **not a hard gate** on INVOICE booking, invoice issue, or funding-source switch                  |
| K-02 | ✅ fixed | `assertVerifiedDomainOrThrow` for INVOICE_FUNDING — the 2026-09-03 verdict pass confirmed FIXED-BY #991: INVOICE now hard-requires a verified domain. |
| K-03 | **P1**   | IRP uploader gated / stub without ClearTax — B2B ITC buyers may require IRN                                                                           |
| K-04 | **P1**   | Manual invoice POST / rollup paths weak on `requireActive` vs top-up which requires ACTIVE                                                            |
| K-05 | **P2**   | MSME `mustPayByDate` alerts live; §16 interest not accrued; deadline semantics soft                                                                   |
| K-06 | **P2**   | `TdsAdjustment` / Form 26Q export largely schema-only                                                                                                 |
| K-07 | ❌ stale | Dual TDS engines vs B2C deprecated path — the 2026-09-03 verdict pass marked this stale: 194-O is already live via `computeTdsForPayout`.             |
| K-08 | **P2**   | Invoice GST not always per-line; credit-note length limits                                                                                            |

Working well: GST derive helper, sequential invoice numbers, org payout TDS 194-O compute, MSME alert cron, credit note mint on refund.

## Unhappy paths & multi-device psychology

- Sales marks org “verified” in checklist UI on laptop; KYB never stamped; INVOICE bookings proceed from phone apps.
- Buyer AP rejects invoice without IRN; host already delivered sessions — commercial deadlock.
- Two admins: one switches funding to INVOICE without domain claim; SSO admin verifies domain later — window of ungated risk.
- MSME host expects 45-day pay; Familiarise batch delayed; CA flags 43B(h) — relationship damage.

## Questions (handled?)

1. **Hard-gate INVOICE on KYB + verified domain?**
   - A) Yes on funding switch, checkout, invoice issue
   - B) Soft checklist forever
   - C) Cap-only for unverified

**Recommendation: A.** Enterprise INVOICE without KYB/domain is a fraud and reputation hole.

- Not B: Checklists do not stop API clients.
- Not C: Cap is blast-radius control, not identity assurance.

2. **IRP before enterprise invoice GA?**
   - A) Enable for orgs above AATO / all B2B
   - B) PDF-only until first audit ask
   - C) Per-customer ClearTax allowlist

**Recommendation: C then A.** Allowlist design partners who need IRN; expand when ClearTax prod-ready.

- Not B if selling to GST-registered enterprises that demand IRN now.
- A immediately only if ops ready.

3. **MSME payment SLA productization?**
   - A) Prioritize MSME payouts in batch + surface mustPayByDate in UI
   - B) Alerts-only (current-ish)
   - C) Accrue statutory interest in ledger

**Recommendation: A.** UI + batch priority first; interest accrual (C) after legal sign-off.

- Not B alone at host-agency scale.
- C without legal template is premature.

## High concurrency / multi-device / spikes

Invoice numbering must stay gapless under concurrent rollups (Serializable present). Multi-admin tax-info edits need optimistic locking where missing. Spike: month-end IRP upload queue — not GH Actions-naive if volume grows (same lesson as Stream recordings).

## Suggested directions

1. Wire domain + KYB asserts on INVOICE paths.
2. Align `requireActive` across money surfaces.
3. ClearTax allowlist for IRP; keep TDS on single engine for org payouts.
