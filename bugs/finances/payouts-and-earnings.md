# Payouts & Earnings

> **Verdict pass 2026-09-03/04.** Every money claim in this file was re-checked against `dev@e1766fa2d` and the live database as part of the 2026-09-03 finance-subsystem verification. Of 9 claims, 5 are still true today, 4 have been addressed since this dossier was written, and 0 are stale. See [`docs/payments/audits/2026-09-03-finance-verdicts.md`](../../docs/payments/audits/2026-09-03-finance-verdicts.md) for the per-item disposition.

## Context

Successful payments create `ConsultantEarnings` / `OrganizationEarnings` (platform fee share, hold period, refund clawback fields). Weekly crons batch READY earnings into `ConsultantPayout` / `OrganizationPayout` with unique idempotency keys, then submit via RazorpayX or Stripe Connect when `ENABLE_LIVE_PAYOUTS=true`. TDS (194-O) and MSME `mustPayByDate` attach at payout time. Path C intentionally avoids Route sub-merchant splits.

Key paths: `lib/payments/payouts/`, jobs under `.github/workflows/*payout*`.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short)                                             | Verdict                                                                                                                       |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Live gateway submission gated → PROCESSING/PENDING freeze | 🔵 by-design gate + CAS terminal guards                                                                                       |
| Non-resident consultants blocked (Sec 195)                | 🟡 LEGIT-DEFERRED (accurate guard)                                                                                            |
| Org clawback after COMPLETED payout is manual             | 🟡 LEGIT-DEFERRED (post-payout netting not in this wave)                                                                      |
| GST TCS fields exist, collection deferred (cites #780)    | 🟡 LEGIT-DEFERRED — note #780 is misattributed (it is the BigInt money migration, not GST TCS)                                |
| Form 26Q / TRACES schema-only (cites #738)                | 🔵 TRACKED #737 — code cites #737, audit said #738                                                                            |
| INVOICE earnings park in `PENDING_TRUST` "forever"        | ✅/🔵 #991 rescopes the park to the sponsor and extends the #687 release valve to consultant rows; dunning-suspend is 🔵 #779 |

## Known gaps / bugs

- **P0/ops:** live gateway submission gated — without the flag, rows freeze PROCESSING/PENDING and consultants never get money.
- Non-resident consultants blocked — Section 195 TDS not implemented.
- Org Stripe Connect payout deferred; org clawback after COMPLETED payout is manual recovery in v1.
- GST TCS fields exist on earnings/payment; collection deferred pending CA (#780).
- Form 26Q / TRACES artifacts largely schema-only (#738).
- INVOICE-funded org bookings park earnings in `PENDING_TRUST` until org KYB/payment trust — can stall forever without policy.

## Unhappy paths & user psychology

- Consultant completes sessions, dashboard shows READY, bank empty — they churn or threaten chargeback on prior customer payments.
- Two admins approve overlapping payout batches — mitigated by batch lock + idempotency keys, but UI may not show “another batch in flight.”
- Refund arrives after payout COMPLETED — clawbackAmount grows; finance must chase consultant/org manually.
- MSME vendor expects 45-day payment; cron alerts exist but no auto-prioritization of MSME queues in product UX.

## Questions (handled?)

1. **Go-live plan for `ENABLE_LIVE_PAYOUTS`?**
   - A) Sandbox UTR reconcile → limited cohort → full prod with kill switch
   - B) Keep manual bank transfers until GMV threshold
   - C) Switch architecture to Route splits before enabling FAA

**Recommendation: A.** Prove sandbox UTRs, then design-partner cohort, then full prod with a kill switch — the only safe way to flip `ENABLE_LIVE_PAYOUTS`.

- Not B: Manual bank transfers do not exercise idempotent RazorpayX batching and hide production failure modes.
- Not C: Redesigning onto Route before FAA delays payouts and abandons Path C without a CA-driven reason.

> 🎯 Locked: rec A stands; batch earnings now move to a BATCHED status (#993) so nothing reads PAID before a UTR exists, and the flag stays the go-live gate.

2. **What happens when INVOICE org never pays — force clawback, write-off, or suspend booking?**
   - A) Auto-suspend org after dunning stage 3 (`ENABLE_DUNNING_SUSPEND`)
   - B) Earnings stay PENDING_TRUST indefinitely (ops review)
   - C) Platform absorbs and invoices org legally

**Recommendation: A.** After dunning stage 3, auto-suspend the org so unpaid invoice funding cannot keep creating `PENDING_TRUST` earnings forever.

- Not B: Indefinite PENDING_TRUST strands consultants and never forces org payment.
- Not C: Platform absorption turns Familiarise into the bad-debt party for unpaid B2B bookings.

> 🎯 Locked: rec A direction — #991 rescopes the park to the sponsor (not the consultant) and dunning→suspend is tracked under #779.

3. **Non-resident / Section 195 timeline before international consultants?**
   - A) Block non-resident until Form 15CA/CB live
   - B) Manual CA process outside product
   - C) Only allow INR-resident consultants at launch

**Recommendation: C.** Launch with INR-resident consultants only until Section 195 / Form 15CA/CB is productized — India settlement first.

- Not A: “Block until 15CA/CB” still invites half-built intl onboarding UI and support exceptions.
- Not B: Manual CA outside product does not scale and will be bypassed under sales pressure.

> 🎯 Locked: rec C — launch with INR-resident consultants only; Section 195 / Form 15CA/CB is deferred.

## High concurrency / multi-device

Payout batch creation uses distributed locks; webhook status updates use CAS terminal guards. Concurrent admin clicks on “process payouts” should no-op via idempotency. Multi-device admin sessions can still race UI — server must remain source of truth.

## Suggested directions

Ship payout status copy in consultant UI that matches flag state. Require written rollback for live payouts (pause cron, reverse pending gateway calls).
