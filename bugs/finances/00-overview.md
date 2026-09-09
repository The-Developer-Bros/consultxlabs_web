# Finances — Overview

> **Verdict pass 2026-09-03/04.** Every money claim in this file was re-checked against `dev@e1766fa2d` and the live database as part of the 2026-09-03 finance-subsystem verification. Of 10 claims, 4 are still true today, 4 have been addressed since this dossier was written, and 2 are stale. See [`docs/payments/audits/2026-09-03-finance-verdicts.md`](../../docs/payments/audits/2026-09-03-finance-verdicts.md) for the per-item disposition.

## Context

Familiarise’s money stack is Razorpay-primary (Stripe legacy/fallback), with integer paise amounts, a double-entry ledger (`LedgerTransaction` / `LedgerEntry`), and enterprise funding paths (wallet, invoice accrual, license). Consumer checkout creates tentative bookings; webhooks confirm payment and slots. Consultant/org payouts run through RazorpayX (Path C: PG → operating account → FAA), gated by `ENABLE_LIVE_PAYOUTS`.

Canonical engineering: `docs/payments/`, `docs/enterprise/10-money-and-ledger/`, `lib/payments/`.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short)                                    | Verdict                                                                                                                                         |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Live payout disbursement flag-gated off          | 🔵 by-design gate (`ENABLE_LIVE_PAYOUTS`); not a bug                                                                                            |
| INR-only ledger, FX fields cosmetic              | 🔵 TRACKED #783 (multi-currency deferred)                                                                                                       |
| Phase-2 side effects outside confirm tx          | 🔵 by-design ACK-before-complete; sweeper backstop                                                                                              |
| Amount mismatch marks recovery, no auto-refund   | ✅ FIXED-BY #990 (auto-refund + Sentry, manual-recovery fallback)                                                                               |
| Dual TDS engines, B2C consultant on 194J (P0)    | ❌ STALE — consultant withholding is already 194-O via `computeTdsForPayout` (payout-service.ts:592-607); the P0 does not exist in current code |
| Lemon Squeezy / XFlow `NOT_IMPLEMENTED` + routes | ✅ FIXED-BY #984 (removed; Stripe kept; DODO_PAYMENTS enum added post-MVP)                                                                      |
| Day-pass doc-only, no Prisma model               | ✅ FIXED-BY #984 (doc mentions removed)                                                                                                         |

## Known gaps / bugs

- Live payout disbursement is feature-flagged off by default — earnings accrue without real money movement until ops flips the flag.
- Ledger and plan pricing are **INR settlement only**; display FX fields exist for international buyers but are audit cosmetics (#783).
- Phase-2 webhook side effects (earnings, notifications) sit outside the confirmation transaction — temporary inconsistency until crons heal.
- Amount mismatch on capture — the 2026-09-03 verdict pass confirmed this FIXED-BY #990 (auto-refund + Sentry paging, with manual-recovery as the fallback).
- Dual TDS engines — the 2026-09-03 verdict pass marked this stale: consultant withholding is already 194-O via `computeTdsForPayout` (payout-service.ts:592-607); the B2C-on-194J path described here does not exist in current code.
- Lemon Squeezy / XFlow checkout — the 2026-09-03 verdict pass confirmed this FIXED-BY #984 (removed; Stripe kept as the live rail; Dodo Payments added post-MVP).
- Day-pass product doc-only — the 2026-09-03 verdict pass confirmed this FIXED-BY #984 (the doc mentions were removed).

## Unhappy paths & user psychology

- User pays successfully, booking stays pending for minutes because `after()` crashed — they refresh, open support, try to pay again.
- Consultant sees “earnings READY” for weeks with no bank credit — trust erodes if live payouts are off without clear UI copy.
- International buyer sees USD-ish display, is charged INR via IBT, disputes the FX gap with their bank.
- Org admin books on INVOICE funding; invoice never paid; consultant earnings sit in `PENDING_TRUST` forever.

## Questions (handled?)

1. **Is Path C (operating account + RazorpayX) signed off by a CA under RBI PA Directions 2025?**
   - A) Written CA/RBI memo before first live payout
   - B) Ship design partners with escrow-like hold language only
   - C) Move to Razorpay Route sub-merchants per consultant

**Recommendation: A.** Money movement under Path C needs a written CA/RBI memo before the first live payout so Familiarise does not invent escrow language or redesign onto Route.

- Not B: Hold copy without a memo still leaves RBI PA exposure once real UTRs flow.
- Not C: Route sub-merchants abandon the intentional Path C architecture and delay go-live.

> 🎯 Locked: rec A stands — this is a legal/CA sign-off gate, not a code change.

2. **What is the customer SLA when payment succeeds but booking confirmation lags (async webhook gap)?**
   - A) Confirm within N minutes via sweeper + status page
   - B) Poll client until SUCCEEDED or timeout with auto-refund
   - C) Accept ops tickets; document “eventual confirmation”

**Recommendation: A.** Sweeper + status page matches the existing ACK-before-complete webhook design and keeps paid users informed without premature refunds.

- Not B: Client-timeout auto-refunds can claw back legitimate slow confirms and fight the sweeper.
- Not C: Ops-ticket-only acceptance erodes trust when payment already succeeded.

> 🎯 Locked: rec A — the sweeper + status-page design is already the shipped behaviour.

3. **Who owns finance reconciliation when `LedgerReconciliationReport.ok=false`?**
   - A) On-call eng pages nightly
   - B) Finance ops dashboard with weekly review
   - C) Auto-open support ticket per finding

**Recommendation: A.** Ledger `ok=false` is a money-correctness P0 and should page engineering the night it appears, not wait for a weekly ops glance.

- Not B: Weekly review is too slow when wallet/cache drift can compound under load.
- Not C: Support tickets do not fix journal/cache imbalance and create noise without owners.

> 🎯 Locked: rec A — #990 partially delivers this (wallet freeze + Sentry P0 page when reconcile `ok=false`).

## High concurrency / multi-device

Checkout uses `clientIdempotencyKey`, Redis locks, Serializable transactions, and webhook `eventId` dedup. Same user on two devices double-tapping pay should replay via unique key; two _different_ users racing a 1:1 slot may both pay — confirmation guard blocks the loser (see booking pack). Mobile: **web checkout only** today — no native Razorpay SDK.

## Suggested directions

1. Treat finances go-live as a checklist: live payouts sandbox UTR proof, Path C memo, TDS engine unification, IRP decision, amount-mismatch runbook.
2. Read sibling files in this folder before changing money code.
