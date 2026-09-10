# Incomplete, Gated & Stubbed Finance Paths

> **Verdict pass 2026-09-03/04.** Every money claim in this file was re-checked against `dev@e1766fa2d` and the live database as part of the 2026-09-03 finance-subsystem verification. Of 13 claims, 6 are still true today, 5 have been addressed since this dossier was written, and 2 are stale. See [`docs/payments/audits/2026-09-03-finance-verdicts.md`](../../docs/payments/audits/2026-09-03-finance-verdicts.md) for the per-item disposition.

## Context

Much of the finance surface is schema-complete and code-complete but **gated**, **stubbed**, or **doc-only**. Shipping without knowing which gates are intentional creates false confidence.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. The gate/stub table below maps as follows:

| Claim (short)                                   | Verdict                                                         |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `ENABLE_LIVE_PAYOUTS` off                       | 🔵 by-design gate                                               |
| `ENABLE_IRP_UPLOADER` off                       | 🔵 TRACKED #713 (ClearTax)                                      |
| Lemon Squeezy / XFlow dead routes               | ✅ FIXED-BY #984 (removed)                                      |
| Multi-currency ledger not built                 | 🔵 TRACKED #783                                                 |
| Section 195 / non-resident blocked              | 🟡 LEGIT-DEFERRED (accurate guard, by-design)                   |
| Overage #715 paths partial                      | 🔵 TRACKED #715 (CLOSED)                                        |
| GST TCS collection schema-only                  | 🟡 LEGIT-DEFERRED (GSTR-8 batching deferred)                    |
| Day-pass product doc-only                       | ✅ FIXED-BY #984 (mentions removed)                             |
| Paid trial checkout "partial schema"            | ❌ OVERSTATED — `trialPriceInPaise` is wired through checkout   |
| Org Stripe Connect deferred                     | 🟡 LEGIT-DEFERRED                                               |
| Payment cancellation helper warn-only → orphans | ❌ OVERSTATED — `reconcile-orphaned-confirmations` backstops it |
| Export tax evidence (FIRC/LUT) TODO             | 🟡 LEGIT-DEFERRED                                               |
| Dec 2025 P0 checkout task reads "Awaiting Fix"  | ✅ code fixes landed; the task file was stale doc drift         |

## Known gaps / bugs

| Item                           | State                                                           | Risk if ignored                  |
| ------------------------------ | --------------------------------------------------------------- | -------------------------------- |
| `ENABLE_LIVE_PAYOUTS`          | Off by default                                                  | Consultants unpaid               |
| `ENABLE_IRP_UPLOADER`          | Off / needs ClearTax                                            | Non-compliant e-invoice at scale |
| Lemon Squeezy / XFlow          | ✅ FIXED-BY #984 (hard-removed)                                 | n/a                              |
| Multi-currency ledger #783     | Deferred                                                        | Blocks true intl settlement      |
| Section 195 / non-resident     | Blocked                                                         | Intl consultants cannot cash out |
| Overage #715 paths             | Partial                                                         | Some refunds/reversals refuse    |
| GST TCS collection             | Schema only                                                     | GSTR-8 gap                       |
| Day pass product               | ✅ FIXED-BY #984 (doc mentions removed)                         | n/a                              |
| Paid trial checkout            | ❌ overstated — `trialPriceInPaise` is wired through checkout   | n/a                              |
| Org Stripe Connect             | Deferred                                                        | Dual-rail complexity             |
| Payment cancellation helper    | ❌ overstated — `reconcile-orphaned-confirmations` backstops it | n/a                              |
| Export tax evidence (FIRC/LUT) | TODO in tax-engine                                              | Audit weakness                   |

Dec 2025 P0 checkout bugs appear fixed in code — the tracking file `tasks/payment-workflow-critical-bugs.md` was retired with the `tasks/` folder (commit e9471aea), closing that drift.

## Unhappy paths & user psychology

- PM ships “payouts” marketing while flag is off — experts feel lied to.
- Eng enables Lemon webhook secretly for a pilot without checkout — phantom events.
- Sales promises USD pricing; currency guard throws at plan create.

## Questions (handled?)

1. **Delete vs quarantine Stripe/Lemon/XFlow code?**
   - A) Delete unused gateways per Mar 2026 evaluation
   - B) Quarantine behind `DEPRECATED_GATEWAYS`
   - C) Keep Stripe test-only

**Historical recommendation (2026-07-12): B.** Quarantine unused gateways behind a deprecation flag to shrink secret/webhook surface without a risky big-bang delete of shared types.

- Not A: Hard delete can break residual imports and webhook routes before the evaluation cleanup is complete.
- Not C: Leaving Stripe “test-only” still keeps dual-rail complexity and asymmetric sync behavior in prod codepaths.

> 🎯 Locked: this superseded the recommendation above — Lemon/XFlow were hard-removed (#984), not quarantined; Stripe is KEPT as a live rail; Dodo Payments is the sanctioned post-MVP second gateway.

2. **Single source of truth for “finance ready for prod” checklist?**
   - A) This bugs pack + shipping checklist sign-off slots
   - B) Notion/Linear only
   - C) Feature-flag dashboard as checklist

**Recommendation: A.** Keep the go-live checklist next to the audited gaps in-repo so eng and finance sign the same artifacts.

- Not B: Notion/Linear drift from code (as already seen on payment-workflow task status).
- Not C: Flags show what is on, not whether Path C, TDS, and IRP are actually signed off.

3. **Are day passes on the roadmap or should skill/docs mentions be removed?**
   - A) Build schema + grant path
   - B) Remove mentions to reduce confusion
   - C) Keep as future marketing only

**Recommendation: B.** Day passes are doc-only with no Prisma model — remove mentions so sales and eng stop treating them as shippable.

- Not A: Building a new product surface before payouts/TDS/refund P0s is growth ahead of money safety.
- Not C: “Future marketing only” still creates false confidence and support confusion.

> 🎯 Locked: rec B — day-pass doc/skill mentions were removed in #984.

## High concurrency / multi-device

Stubs are mostly safe under load (they throw early). Gated live payouts under concurrent cron+admin is the dangerous incomplete path — never flip the flag without concurrency runbook.

## Suggested directions

Maintain a living “gates” table in finances README or ops Notion (the retired `tasks/` register no longer needs reconciling).
