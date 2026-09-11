# Enterprise Money — Payouts, Earnings & Trust Parking

> **Verdict pass 2026-09-03/04.** Every money claim in this file was re-checked against `dev@e1766fa2d` and the live database as part of the 2026-09-03 finance-subsystem verification. Of 10 claims, 2 are still true today, 8 have been addressed since this dossier was written, and 0 are stale. See [`docs/payments/audits/2026-09-03-finance-verdicts.md`](../../docs/payments/audits/2026-09-03-finance-verdicts.md) for the per-item disposition.

## Context

Successful org/host flows create `OrganizationEarnings` + `ConsultantEarnings`, hold, then batch into `OrganizationPayout` / `ConsultantPayout`. `PENDING_TRUST` was meant to park payables when **unverified INVOICE sponsors** ghost. Live disbursement requires `ENABLE_LIVE_PAYOUTS`. Host split requires `ENABLE_HOST_ORGS`. This file is about **whether enterprise money-out tells the truth**.

Key: [`lib/payments/payouts/earnings-service.ts`](../../lib/payments/payouts/earnings-service.ts), [`lib/payments/payouts/org-payout-service.ts`](../../lib/payments/payouts/org-payout-service.ts), ADR `docs/enterprise/70-design-decisions/12-pending-trust-earnings-parking.md`.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short)                                              | Verdict                           |
| ---------------------------------------------------------- | --------------------------------- |
| E-01 PENDING_TRUST scopes host not sponsoring org          | ✅ FIXED-BY #991                  |
| E-02 consultant earnings for ghost INVOICE not parked      | ✅ FIXED-BY #991                  |
| E-03 earnings flip PAID at batch creation                  | ✅ FIXED-BY #993 (BATCHED status) |
| E-04 LIVE_PAYOUTS off → batches PAID without UTR           | ✅ FIXED-BY #993                  |
| E-05 post-COMPLETED clawback manual; org-side TDS reversal | 🟡 LEGIT-DEFERRED                 |
| E-06 no RazorpayX balance pre-check before batch           | 🟡 LEGIT-DEFERRED                 |
| E-07 poller vs webhook reverse-status edges                | 🟡 LEGIT-DEFERRED                 |

## Known gaps / bugs

| ID   | Severity | Issue                                                                                                                                                             |
| ---- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E-01 | ✅ fixed | `PENDING_TRUST` scoping — the 2026-09-03 verdict pass confirmed FIXED-BY #991: it now scopes the sponsoring `payment.organizationId`, not the host.               |
| E-02 | ✅ fixed | Marketplace / consultant earnings for unverified INVOICE org bookings — the 2026-09-03 verdict pass confirmed FIXED-BY #991: these now park.                      |
| E-03 | ✅ fixed | Earnings-flip timing — the 2026-09-03 verdict pass confirmed FIXED-BY #993: earnings go BATCHED at batch creation and only PAID after the gateway wire completes. |
| E-04 | ✅ fixed | `ENABLE_LIVE_PAYOUTS` off + no UTR — the 2026-09-03 verdict pass confirmed FIXED-BY #993, tied to the same BATCHED-status change as E-03.                         |
| E-05 | **P2**   | Org clawback after COMPLETED payout is manual; TDS org-side reversal incomplete                                                                                   |
| E-06 | **P2**   | No RazorpayX balance pre-check before batch                                                                                                                       |
| E-07 | **P2**   | Poller vs webhook reverse-status edge cases on payouts                                                                                                            |

## Unhappy paths & multi-device psychology

- Host agency dashboard (iPad) shows READY/PAID; bank (phone) empty — founder escalates publicly.
- Unverified sponsor books ₹40k; consultant sees PENDING→READY normally; invoice never paid — Familiarise pays or fights expert.
- Two admins create payout batches on two laptops — Redis lock should serialize; loser UX unclear.
- Finance exports “PAID” earnings for auditors while payout row still PENDING — audit fail.

## Questions (handled?)

1. **Fix PENDING_TRUST scope before any INVOICE sponsor GA?**
   - A) Park consultant + correct sponsor org id; or block checkout until ACTIVE/KYB
   - B) Keep current host-scoped park
   - C) Rely on ₹50k cap only

**Recommendation: A.** Mis-scoped park is an existential balance-sheet bug for enterprise respect.

- Not B: Current behavior does not match ADR intent.
- Not C: Cap limits size, not wrong payables.

2. **When to mark earnings PAID?**
   - A) Only on payout COMPLETED + UTR
   - B) At batch creation (current)
   - C) Intermediate status `BATCHED` then `PAID`

> 🎯 Locked: BATCHED status (rec C, shipped #993) — earnings go BATCHED at batch creation and only PAID after the gateway wire completes.

**Recommendation: C (or A).** Introduce `BATCHED`/`IN_FLIGHT` so UI never lies; `PAID` only after wire.

- Not B: “Paid” before cash is how enterprise trust dies.
- A alone may be enough if batch UI uses non-PAID labels.

3. **Live payouts go-live coupling?**
   - A) With HOST flag + Path C CA memo + sandbox UTR
   - B) Enable anytime for consultant-only
   - C) Stay manual bank forever

> 🎯 Locked: sponsor-first — the live-payouts flip couples with the host flag as one go-live program after the sponsor rail ships.

**Recommendation: A.** One runbook: host split + live payouts + CA Path C + UTR proof.

- Not B: Consultant-only still needs trust parking + TDS correctness.
- Not C: Manual does not scale past design partners.

## High concurrency / multi-device / spikes

Batch creation uses Redis org lock + Serializable + idempotency keys — solid under multi-admin. Spike risk is **semantic falsehood (PAID)** and **wrong park scope**, not double-disburse (when live). Weeklies under load should pre-check FAA balance.

## Suggested directions

1. Re-implement PENDING_TRUST against `payment.organizationId` + park `ConsultantEarnings`.
2. Rename/split PAID vs BATCHED.
3. Dual-flag go-live runbook before host agency sales.
