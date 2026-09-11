# Multi-Currency & Ledger

> **Verdict pass 2026-09-03/04.** Every money claim in this file was re-checked against `dev@e1766fa2d` and the live database as part of the 2026-09-03 finance-subsystem verification. Of 7 claims, 3 are still true today, 4 have been addressed since this dossier was written, and 0 are stale. See [`docs/payments/audits/2026-09-03-finance-verdicts.md`](../../docs/payments/audits/2026-09-03-finance-verdicts.md) for the per-item disposition.

## Context

Money is modeled as integer paise with double-entry postings via `postLedgerTxn()`: deterministic ledger account IDs, sorted balance-cache updates (deadlock avoidance), COMMIT-time balance triggers, nightly `reconcile-ledgers`. Chart includes CASH, WALLET, PLATFORM_FEE, CONSULTANT_PAYABLE, ORG_PAYABLE/RECEIVABLE, TDS/GST payables, etc. Currency enum includes INR/USD/EUR/GBP, but settlement and ledger postings are **INR-only** today. International buyers may see `displayCurrencyAtCheckout` + `exchangeRateAtCheckout` as audit labels while Razorpay IBT still settles INR.

Key paths: `lib/payments/ledger/post.ts`, `lib/payments/validation/currency-guards.ts`, `prisma/sql/ledger-triggers.sql`.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short)                                       | Verdict                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| True multi-currency ledger not built                | 🔵 TRACKED #783                                                                       |
| Wallet cache drift possible until nightly reconcile | ✅ FIXED-BY #990 (freeze + page when reconcile `ok=false`; nightly reconcile remains) |
| Display FX not used in refund math                  | 🟡 by-design (gateway settles INR)                                                    |
| Stripe/legacy paths add mental load                 | 🎯 Stripe KEPT by decision                                                            |

## Known gaps / bugs

- True multi-currency ledger (#783) not built — non-INR plan pricing throws.
- Wallet balance on `BillingAccount` is a denormalized cache; journal is source of truth — drift possible until nightly reconcile.
- Display FX not used in refunds math beyond audit fields — customer may expect FX-aware refund amounts.
- Stripe/legacy paths increase mental load without multi-currency benefit.

## Unhappy paths & user psychology

- US consultee believes they paid $X; statement shows INR conversion + bank FX fee — they dispute “wrong amount.”
- Finance export mixes display currency and settlement currency without clear columns — reconciliation pain.
- Hot wallet org: many parallel bookings debit wallet cache; one fails mid-ledger posting — user sees balance flicker across tabs.

## Questions (handled?)

1. **Is INR settlement + local FX acceptable until meaningful US/EU consultant supply?**
   - A) Yes — document clearly in checkout UI
   - B) No — block non-INR buyers until #783
   - C) Dual books: display FX wallet separate from INR ledger

**Recommendation: A.** Stay INR settlement with clear checkout copy until real US/EU supply justifies #783 — matches the India-first money model already in code.

- Not B: Blocking all non-INR buyers cuts international consultees without fixing consultant payout reality.
- Not C: Dual display-FX books before a true multi-currency ledger invites reconcile bugs and support disputes.

> 🎯 Locked: rec A — INR settlement retained; true multi-currency stays tracked under #783.

2. **On wallet drift detection, auto-heal from journal or page humans?**
   - A) Auto-correct cache from ledger balance
   - B) Freeze wallet + ops alert
   - C) Log only until N paise threshold

**Recommendation: B.** Freeze the wallet and page ops when cache drifts from the journal so further bookings cannot spend a wrong balance.

- Not A: Silent auto-heal can mask a posting bug and keep moving bad money.
- Not C: Log-only lets orgs keep booking against a lying denormalized balance.

> 🎯 Locked: rec B — #990 freezes the wallet and pages Sentry (P0) on reconcile `ok=false`; no silent auto-heal.

3. **Should refunds always return gateway-settled INR, ignoring display currency?**
   - A) Yes (gateway truth)
   - B) Attempt display-currency refund where gateway supports
   - C) Credit wallet in INR equivalent only

**Recommendation: A.** Refund the gateway-settled INR amount — that is what Razorpay captured and what the ledger posted.

- Not B: Display-currency refunds fight IBT settlement and create amount-mismatch recovery loops.
- Not C: Wallet credit instead of gateway refund leaves the card/UPI customer unpaid.

> 🎯 Locked: rec A — refunds return the gateway-settled INR by design.

## High concurrency / multi-device

Ledger idempotency keys prevent double-post on webhook retry. Sorted account lock ordering reduces deadlock; under extreme parallel wallet debit + refund + top-up, expect P2034 retries. Multi-tab wallet UI must refresh from server after each mutation.

## Suggested directions

Add checkout copy: “Charged in INR; your bank may show a foreign transaction.” Prioritize ledger reconcile paging before multi-currency expansion.
