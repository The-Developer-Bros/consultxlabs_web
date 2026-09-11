# Enterprise Incomplete Work & Feature Flags

## Context

Large schema/API surface with deliberate gates. Readiness audits score design-partner readiness higher than self-serve production readiness.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| `ENABLE_HOST_ORGS` / `ENABLE_LIVE_PAYOUTS` / `ENABLE_TDS_ADMIN_VIEW` gates | 🔵 by-design gates |
| `ENABLE_IRP_UPLOADER` | 🔵 TRACKED #713 |
| `ENABLE_DUNNING_SUSPEND` | 🔵 TRACKED #779 |
| #777 auto-charge notify-only | 🔵 TRACKED #777 |
| #715 overage partial | 🔵 TRACKED #715 (CLOSED) |
| #716 CHARGED overage credit-back | 🟡 LEGIT-DEFERRED |
| #771 hierarchy stub / no RLS | 🔵 TRACKED #771 (CLOSED — 🎯 accepted API-layer isolation) |
| `exclusiveEngagement` unenforced | ✅ FIXED-BY #982 (enforced at checkout per ADR 18) |
| Bulk members 405 stub | 🟡 LEGIT-DEFERRED |
| Doc drift: SCIM parked vs live; HOST error codes | 🟡 LEGIT-DEFERRED (doc drift) |

## Known gaps / bugs

| Flag / area | Effect |
|-------------|--------|
| `ENABLE_HOST_ORGS` | Host create, EXPERT flows, 3-way split |
| `ENABLE_LIVE_PAYOUTS` | Real disbursement |
| `ENABLE_IRP_UPLOADER` | E-invoice IRN |
| `ENABLE_TDS_ADMIN_VIEW` | Form 26Q surfaces |
| `ENABLE_DUNNING_SUSPEND` | Auto-suspend after dunning |
| #777 auto-charge | Notify-only |
| #715 / #716 overage | Partial refund/credit-note paths |
| #771 hierarchy | Stub |
| RLS | None |
| `exclusiveEngagement` | Unenforced |
| Bulk members | 405 stub |

Doc drift: SCIM parked vs live; HOST gate error codes inconsistent in docs vs routes.

## Unhappy paths & user psychology

- Sales demo turns on host org in staging; prod flag off — “it worked yesterday.”
- Customer reads outdated SCIM doc and assumes unsupported.

## Questions (handled?)

1. **Single enterprise go-live checklist owner?**  
   - A) Eng lead  
   - B) Founder + CA + eng  
   - C) Per-flag owners  

**Recommendation: B.** Flags span tax, payouts, and product law — founder + CA + eng must co-sign go-live.  
- Not A: Eng alone cannot own GST/TDS/MSA risk.  
- Not C: Per-flag owners fragment the sponsor→host program into unsafe partial flips.

2. **When to flip `ENABLE_HOST_ORGS`?**  
   - A) With live payouts + rate-card QA  
   - B) Soft launch without live money  
   - C) Defer indefinitely; sponsor-only  

> 🎯 Locked: sponsor-first — flip `ENABLE_HOST_ORGS` only after the sponsor rail ships, coupled with live payouts as one program.

**Recommendation: A.** Host orgs without live money teach the wrong economics; flip with payouts as one program after sponsor path is stable.  
- Not B: Soft launch creates demo/prod confusion and fake rate-card expectations.  
- Not C: “Indefinitely” kills the host roadmap; sponsor-first is sequencing, not abandonment.

## High concurrency / multi-device

Flags are process risk more than race risk — except enabling live payouts under load.

## Suggested directions

Publish internal flag matrix with owner + rollback. Reconcile SCIM documentation.
