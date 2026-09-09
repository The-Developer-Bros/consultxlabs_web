# Refunds & Disputes

> **Verdict pass 2026-09-03/04.** Every money claim in this file was re-checked against `dev@e1766fa2d` and the live database as part of the 2026-09-03 finance-subsystem verification. Of 8 claims, 2 are still true today, 5 have been addressed since this dossier was written, and 1 are stale. See [`docs/payments/audits/2026-09-03-finance-verdicts.md`](../../docs/payments/audits/2026-09-03-finance-verdicts.md) for the per-item disposition.

## Context

Canonical refund path is `refundPayment()` + `applyRefundCascade()` in a Serializable transaction: Refund row, reverse payment legs (wallet, invoice accrual, referral credit), reverse booking utilization, proportional earnings clawback, ledger `REFUND` posting, GST credit note minting, TDS reversal, stamp `cascadedAt`. Disputes use a legal transition guard (`dispute-status.ts`); LOST triggers earnings reversal and chargeback accounting. Razorpay disputes are webhook-only (no list API).

Key paths: `lib/payments/operations/refund.ts`, `docs/payments/refunds-disputes/`.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short)                                       | Verdict                                                                                                                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tax adjustment rows incompletely wired from refund  | ❌ OVERSTATED — `recordTdsReversal` (refund.ts:593) and `gstTcsAdjustment.create` (refund.ts:723) are both wired; only the `GstTcsBatch` monthly collection is deferred |
| Overage credit-back refuses non-invoice reversals   | 🔵 TRACKED #715                                                                                                                                                         |
| Org payout COMPLETED → clawback manual              | 🟡 LEGIT-DEFERRED                                                                                                                                                       |
| Double-booking loser holds SUCCEEDED, manual refund | ✅ FIXED-BY #990                                                                                                                                                        |
| Chargeback evidence SLA timers in admin UI          | 🟡 UNVERIFIED (alert cron exists; the UI timer was not confirmed)                                                                                                       |

## Known gaps / bugs

- Cascade is strong; the tax adjustment rows (`TdsAdjustment` / `GstTcsAdjustment`) were documented elsewhere as incompletely wired from refund, but the 2026-09-03 verdict pass found this overstated — both are wired from `refund.ts` (`recordTdsReversal` at refund.ts:593, `gstTcsAdjustment.create` at refund.ts:723); only the monthly `GstTcsBatch` collection is deferred.
- Overage member credit-back (#715) refuses some non-invoice reversals — certain refunds may block.
- Org payout already COMPLETED → clawback is not auto-recovered from consultant/org bank.
- Double-booking loser holding a SUCCEEDED payment with a tentative slot — the 2026-09-03 verdict pass confirmed this FIXED-BY #990.
- Chargeback evidence SLAs (documented ~7 days) may not be operationalized in admin UI timers.

## Unhappy paths & user psychology

- Consultee cancels inside policy window, expects instant UPI refund; gateway is “normal” refund (days) — support tickets spike.
- Consultant no-show (policy promises full refund) but no automation (#471) — refund depends on support judgment.
- Dispute opens while refund already PENDING — Serializable re-read helps, but UX shows conflicting statuses across devices.
- User files both support ticket and Razorpay dispute — two recovery paths fight each other.

## Questions (handled?)

1. **Should consultant no-show auto-trigger full refund?**
   - A) Auto from MeetingAttendance / UNVERIFIED after SLA
   - B) Support-only with scripted playbook
   - C) Partial credit note + mandatory reschedule

**Recommendation: A.** Policy already promises full refund on consultant no-show — automate from MeetingAttendance / UNVERIFIED after SLA (#471) instead of hoping support catches it.

- Not B: Support-only leaves paid consultees waiting and contradicts published refund copy.
- Not C: Partial credit plus forced reschedule underpays the customer relative to the promised full refund.

> 🎯 Locked: rec A — no-show refunds are automated in #992 (#471) for consultations; subscriptions remain a deferred TODO#471.

2. **Refund vs dispute race — which wins as product policy?**
   - A) Dispute freezes refund UI; finance owns
   - B) Refund completes; dispute maps to already-refunded
   - C) Always escalate to human before either terminal state

**Recommendation: A.** Freeze in-product refunds when a dispute opens so finance owns one recovery path and two devices cannot fight each other.

- Not B: Completing refunds while a dispute is open risks double recovery and confused chargeback evidence.
- Not C: Human-gating every terminal state recreates ticket latency on an already Serializable money path.

3. **Post-payout clawback — auto debit next earnings or legal invoice?**
   - A) Net against next ConsultantPayout batch
   - B) Manual collection only (current v1 leaning)
   - C) Hold future bookings until clawback cleared

**Recommendation: A.** Net clawbacks against the next payout batch so refunded sessions do not permanently strand platform receivables after COMPLETED payouts.

- Not B: Manual collection does not scale and leaves `clawbackAmount` growing with no recovery path.
- Not C: Holding future bookings punishes consultees and consultants for a finance recovery problem.

> 🎯 Locked: post-payout clawback netting is LEGIT-DEFERRED — not in this wave; manual recovery remains the v1 stopgap.

## High concurrency / multi-device

Cancel API and payment webhook can race — CAS transitions ensure one wins. Refundable balance nets existing refunds + lost chargebacks. Two tabs submitting cancel+refund should hit appointment lock / status guards.

## Suggested directions

Publish customer-facing refund timing by method (UPI/card). Wire ops dashboards for `cascadedAt IS NULL` SUCCEEDED refunds (cron already backstops).
