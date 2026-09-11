# Enterprise Money — Refunds, Disputes & Overage

> **Verdict pass 2026-09-03/04.** Every money claim in this file was re-checked against `dev@e1766fa2d` and the live database as part of the 2026-09-03 finance-subsystem verification. Of 10 claims, 4 are still true today, 5 have been addressed since this dossier was written, and 1 are stale. See [`docs/payments/audits/2026-09-03-finance-verdicts.md`](../../docs/payments/audits/2026-09-03-finance-verdicts.md) for the per-item disposition.

## Context

Canonical cascade: [`lib/payments/operations/refund.ts`](../../lib/payments/operations/refund.ts) (`applyRefundCascade`) — Serializable, `cascadedAt` claim, reverse legs (wallet credit, accrual reversals, LICENSE utilization), earnings clawback, credit notes, best-effort `REFUND` ledger. Disputes: hold earnings → LOST applies org chargeback (`Dr WALLET` / receivable) + credit note. Overage: PENDING/ACCRUED can reverse on refund; **CHARGED overage (#716) is an explicit gap**.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short)                                             | Verdict                                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| R-01 #716 CHARGED overage lacks auto credit-note / return | 🟡 LEGIT-DEFERRED (#716)                                                               |
| R-02 ledger reversal on refund best-effort                | 🟡 LEGIT-DEFERRED (append-only legs + cron heal)                                       |
| R-03 org chargeback can drive wallet negative             | 🟡 LEGIT-DEFERRED (dunning recovery)                                                   |
| R-04 credit-note serial length / prefix edges             | 🟡 LEGIT-DEFERRED                                                                      |
| R-05 Razorpay dispute reconciler manual-heavy             | 🟡 LEGIT-DEFERRED                                                                      |
| R-06 post-COMPLETED payout clawback manual                | 🟡 LEGIT-DEFERRED (post-payout netting not in this wave)                               |
| R-07 docs claim multi-leg refund incomplete               | ❌ STALE/OVERSTATED (cascade + tax adjustment rows already wired — don't chase ghosts) |

## Known gaps / bugs

| ID   | Severity | Issue                                                                                                    |
| ---- | -------- | -------------------------------------------------------------------------------------------------------- |
| R-01 | **P1**   | #716 — CHARGED `OVERAGE_INVOICE_ACCRUAL` / member side-charge lacks automated credit-note + money return |
| R-02 | **P1**   | Ledger reversal on refund can be best-effort — books lag customer money                                  |
| R-03 | **P1**   | Org chargeback can drive wallet negative — dunning must recover                                          |
| R-04 | **P2**   | Credit note serial length / prefix edge cases for long org codes                                         |
| R-05 | **P2**   | Razorpay dispute list/reconciler still manual-heavy                                                      |
| R-06 | **P2**   | Post-COMPLETED org payout clawback is manual (no auto net-next-batch)                                    |
| R-07 | **P2**   | Readiness docs may still claim multi-leg refund incomplete — **code largely fixed**; don’t chase ghosts  |

Working well: refund vs chargeback Serializable pairing (#785); append-only reversal legs (#786); idempotent credit notes on `refundId`.

## Unhappy paths & multi-device psychology

- AP refunds a booking on desktop while member pays CHARGE_MEMBER overage on phone — states fight; need clear “overage already invoiced” copy.
- Dispute opens in bank app; finance voids invoice on another tab — CAS should 409; opaque errors → double tickets.
- Host already paid out; sponsor refunds — clawbackAmount grows; agency thinks Familiarise stole margin.
- Two BILLING_ADMINs click refund on same payment — one wins; other should see already-cascaded.

## Questions (handled?)

1. **#716 CHARGED overage on refund — priority before enterprise GA?**
   - A) Hard gate — implement credit note + reverse/chargeback policy
   - B) Manual finance runbook only
   - C) Forbid CHARGE\_\* overage until fixed

**Recommendation: A (or C interim).** Un-reversed CHARGED overage destroys AP trust; implement or disable CHARGE paths until done.

- Not B: Manual-only fails at cohort scale.
- C valid freeze if eng capacity tight before A ships.

2. **Org chargeback recovery?**
   - A) Auto-dunning + optional suspend
   - B) Immediate negative wallet + invoice
   - C) Platform absorbs

**Recommendation: A.** Negative wallet is a signal; recover via dunning/suspend policy, not silent absorption.

- Not B alone without dunning UX.
- Not C: Teaches sponsors disputes are free.

3. **Post-payout clawback?**
   - A) Net against next OrganizationPayout
   - B) Manual collection forever
   - C) Hold future host bookings until cleared

**Recommendation: A.** Auto-net next batch; escalate to C only for chronic offenders.

- Not B: Ops debt grows with every refund-after-payout.
- C too harsh as default.

## High concurrency / multi-device / spikes

Refund × dispute × webhook storms are among the best-tested money races. Residual risk is **product completeness (#716)** and clawback ops, not missing CAS. Multi-tab refund UIs must disable after first success.

## Suggested directions

1. Ship #716 with tests for INVOICE + CHARGE_MEMBER parents.
2. Enable dunning suspend when AR policy ready.
3. Clawback auto-net in org payout batch creator.
