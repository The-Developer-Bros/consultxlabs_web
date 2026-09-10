# Enterprise Money — Checkout, Wallet, Invoice, License

> **Verdict pass 2026-09-03/04.** Every money claim in this file was re-checked against `dev@e1766fa2d` and the live database as part of the 2026-09-03 finance-subsystem verification. Of 9 claims, 2 are still true today, 7 have been addressed since this dossier was written, and 0 are stale. See [`docs/payments/audits/2026-09-03-finance-verdicts.md`](../../docs/payments/audits/2026-09-03-finance-verdicts.md) for the per-item disposition.

## Context

Org-funded checkout ([`lib/payments/operations/checkout.ts`](../../lib/payments/operations/checkout.ts)) resolves membership + program, then funds via WALLET (conditional debit), INVOICE (accrual leg + credit-limit recheck inside Serializable tx), or LICENSE (zero-amount leg + utilization). Ledger `BOOKING` posts usually via `createEarningsFromPayment` **after** checkout commit (try/catch + cron heal). Enterprise trust requires books to match what finance sees in wallet and invoices.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short)                                                               | Verdict                                         |
| --------------------------------------------------------------------------- | ----------------------------------------------- |
| C-01 checkout↔ledger non-atomic → `WALLET_BALANCE_DRIFT` / missing earnings | ✅ FIXED-BY #994                                |
| C-02 payment leg sum mismatch warn-only                                     | 🟡 LEGIT-DEFERRED (nightly reconcile backstops) |
| C-03 INVOICE booking for PENDING_VERIFICATION without hard KYB              | ✅ partial via #991 (domain gate)               |
| C-04 CHARGE_MEMBER on non-INVOICE parent fail-closed (#715)                 | 🔵 TRACKED #715                                 |
| C-05 auto-top-up notify-only (#777)                                         | 🔵 TRACKED #777                                 |
| C-06 dunning suspend behind flag                                            | 🔵 TRACKED #779                                 |

## Known gaps / bugs

| ID   | Severity | Issue                                                                                                                                                                         |
| ---- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-01 | ✅ fixed | Wallet/legs vs earnings + `BOOKING` journal — the 2026-09-03 verdict pass confirmed FIXED-BY #994; checkout and the journal are no longer split across a swallowed try/catch. |
| C-02 | **P1**   | Payment leg sum mismatch is **warn-only** at checkout (nightly reconcile catches)                                                                                             |
| C-03 | **P1**   | INVOICE booking allowed for `PENDING_VERIFICATION` under ₹50k-ish governance cap without hard KYB                                                                             |
| C-04 | **P2**   | CHARGE_MEMBER on non-INVOICE parent fail-closed (#715) — correct but misconfig hard-fails                                                                                     |
| C-05 | **P2**   | Auto-top-up schema present; cron is **notify-only** (#777)                                                                                                                    |
| C-06 | **P2**   | Dunning reminders live; booking suspend behind `ENABLE_DUNNING_SUSPEND` (off)                                                                                                 |

Working well: wallet `updateMany WHERE balance >= amount`; in-tx INVOICE exposure re-check; LICENSE metering without money legs; Redis + Serializable for slots/capacity.

## Unhappy paths & multi-device psychology

- CFO sees wallet drop on phone push; laptop ledger export lags until cron — “books don’t tie.”
- Two learners book last CREDIT_POOL rupees on two tabs — one 402; loser retries after top-up on another device.
- Unverified org hits invoice cap mid-cohort enroll — partial class booked, rest refused; HR blames product.
- Admin raises credit limit on tab A while checkout on tab B still uses old exposure — mitigated by in-tx re-read if both hit same path.

## Questions (handled?)

1. **Org-sponsored checkout + earnings + ledger atomicity?**
   - A) Single Serializable tx for org paths
   - B) Compensating wallet credit if earnings fail
   - C) Keep try/catch + nightly heal

**Recommendation: A (or B as interim).** Enterprise cannot respect “eventual books”; prefer one tx, or immediate compensating credit + alert.

- Not C: Cron heal is fine for B2C noise; fatal for design-partner CFOs.
- B acceptable short-term if A is large; never silent swallow alone.

2. **Leg sum mismatch — throw or warn?**
   - A) Hard throw / 500 abort checkout
   - B) Warn + ship (current)
   - C) Quarantine payment to manual review state

**Recommendation: A.** Bad legs must not reach SUCCEEDED — overnight reconcile is too late for trust.

- Not B: Warn-only ships corrupt money shapes.
- Not C: Quarantine is heavier than fail-closed at write time.

3. **INVOICE for PENDING_VERIFICATION orgs?**
   - A) Block until ACTIVE + KYB/domain
   - B) Keep ₹50k pilot cap
   - C) Cap + park all payables (see payouts file)

**Recommendation: C near-term, A for GA.** Cap alone still creates platform liability if consultants accrue; park payables or block.

- Not B alone: Cap limits blast radius but still burns trust and cash.
- A alone without payable parking still needed for GA.

## High concurrency / multi-device / spikes

Month-end + cohort enroll: many Serializable checkouts + wallet row contention → P2034 retries / 503s, not double-spend (if CAS holds). Multi-device double-submit should hit `clientIdempotencyKey`. Spike improvement (industry): CREDIT_POOL **reserve-confirm-release** holds before long webinar enroll — today commit-at-checkout CAS is OK for current scale, brittle if enroll becomes multi-second.

## Suggested directions

1. Unify org checkout money write with ledger/earnings.
2. Throw on leg sum mismatch.
3. Pair with KYB + PENDING_TRUST sponsor-scope fixes (sibling files).
