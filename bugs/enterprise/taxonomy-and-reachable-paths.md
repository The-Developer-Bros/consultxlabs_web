# Enterprise Taxonomy & Reachable Paths

## Context

Familiarise enterprise uses Arch 4-Modified: three orthogonal axes — **capability** (`canSponsor` / `canHost` → SPONSOR / HOST / HYBRID), **funding** (PERSONAL / WALLET / INVOICE / LICENSE), and **programs** (LICENSED_SEAT / CREDIT_POOL). The locked reachable matrix lives in [`lib/enterprise/reachable-paths.ts`](../../lib/enterprise/reachable-paths.ts) and is enforced at program create. Harness (2026-06): ~31 pass / 5 warn — sponsor rail is design-partner ready; host earn-side is code-complete but flag-gated.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| HOST create gated; `resolveOrgSplit()` null → no earnings until flag on | ✅ FIXED-BY #991 (honesty gate) + 🔵 by-design gate |
| Doc drift: rollout says 501 + hidden checkbox; code is 400 + visible | 🟡 LEGIT-DEFERRED (doc drift) |
| ADR-18 stubs (`ProgramConsultantAllowlist`, `exclusiveEngagement`) schema-only | ✅ FIXED-BY #982 (enforced at checkout per ADR 18) |
| No Postgres RLS — tenancy API-layer only | 🔵 TRACKED #771 (CLOSED — 🎯 accepted API-layer isolation) |
| Hierarchy columns (#771) inert in `requireOrgAccess` | 🔵 TRACKED #771 |

## What is accurately / completely implemented

### Capability

| Shape | Create | RBAC / invites | Dashboard | Org-funded checkout | Org earnings split |
|-------|--------|----------------|-----------|---------------------|--------------------|
| **SPONSOR** | Yes | LEARNER requires `canSponsor` | Billing, contracts, programs | Yes | N/A (pays only) |
| **HOST** | Gated (`ENABLE_HOST_ORGS`) | EXPERT requires `canHost` | Experts, rate cards, payouts | N/A (earn only) | Code yes; **silent null** if flag off |
| **HYBRID** | Gated if `canHost` | Both | Both nav clusters | Yes + earn | Same flag gate as HOST |
| **INERT** (neither) | Rejected | — | — | — | — |

### Funding (sponsor-side)

| Funding | Legs / debit | Programs allowed | Completeness |
|---------|--------------|------------------|--------------|
| **PERSONAL** | Member CARD; `Payment.organizationId` tag | None (no programs) | Done; reimbursement UX still soft |
| **WALLET** | Conditional `walletDebit` + WALLET leg | CREDIT_POOL only | Done; auto-top-up notify-only (#777) |
| **INVOICE** | INVOICE_ACCRUAL + credit-limit recheck in tx | LICENSED_SEAT or CREDIT_POOL | Done; dunning suspend off; KYB unwired |
| **LICENSE** | LICENSE leg amount 0 | LICENSED_SEAT only | Done |

### Programs

| Program | Meter | Cap enforcement | Overage BLOCK / CHARGE_* | Cycles |
|---------|-------|-----------------|--------------------------|--------|
| **LICENSED_SEAT** | Engagement count | Guarded `engagementsUsed` | Yes | Advance / rollover jobs live |
| **CREDIT_POOL** | Paise (`consumedPaise`) | Guarded budget | Yes | Live; finance soak still called out in API comments |

### Explicitly blocked (correct)

- LICENSE + CREDIT_POOL  
- WALLET + LICENSED_SEAT (despite some tour docs — treat tour as wrong)  
- PERSONAL orgs attaching programs  

## Known gaps / bugs

- HOST/HYBRID **create** gated; existing `canHost` orgs can open dashboards while `resolveOrgSplit()` returns null → **no OrganizationEarnings** on new bookings until flag on.
- Doc drift: rollout docs say 501 + hidden host checkbox; code is **400 HOST_ORGS_GATED** + visible checkbox.
- ADR-18 stubs (`ProgramConsultantAllowlist`, `exclusiveEngagement`) schema-only — open sponsor network by design until wired.
- No Postgres RLS — tenancy is API-layer only.
- Hierarchy columns (#771) inert in `requireOrgAccess`.

## Unhappy paths & multi-device psychology

- Operator ticks Host on wizard (phone) while laptop still shows Sponsor-only copy — submit fails with opaque 400.
- Seeded LearnPro looks “host ready” in UI; finance expects 3-way split; books show marketplace 80/20 only.
- Two admins create overlapping programs (one CREDIT_POOL, one LICENSED_SEAT) with `forceOverlap` — learners hit ambiguous assignment resolution.

## Questions (handled?)

1. **Is the SPONSOR rail complete enough to sell without HOST?**  
   - A) Yes — sponsor-first GTM  
   - B) Wait until HOST flag + live payouts  
   - C) Soft-sell both with manual ops  

> 🎯 Locked: sponsor-first (rec A) — sell the E2E sponsor rail now; host is a separate go-live program.

**Recommendation: A.** Sell SPONSOR (WALLET/INVOICE/LICENSE + programs) first — that matrix is E2E and harness-backed; HOST is a separate go-live program.  
- Not B: Blocking all enterprise until host money delays revenue on the finished rail.  
- Not C: Soft-selling host with silent split-off creates enterprise trust debt.

2. **When HOST is sold, flip flags how?**  
   - A) `ENABLE_HOST_ORGS` + `ENABLE_LIVE_PAYOUTS` together  
   - B) Host dashboards first, payouts later  
   - C) Live payouts first without host split  

> 🎯 Locked: sponsor-first — `ENABLE_HOST_ORGS` + `ENABLE_LIVE_PAYOUTS` flip together as one program.

**Recommendation: A.** Split math and disbursement must ship as one program — partial flip yields wrong economics or “PAID” without UTR.  
- Not B: Dashboards without live payouts train hosts that money is stuck.  
- Not C: Payouts without host split mis-attributes org vs consultant shares.

3. **Keep ADR-18 open network or enforce allowlists before enterprise deals?**  
   - A) Keep open; contractually manage leakage  
   - B) Wire `ProgramConsultantAllowlist` at checkout lock  
   - C) Force exclusive engagement for all EXPERT members  

> 🎯 Locked: ADR 18 — allowlist wired at checkout (#982); open network stays the marketplace default.

**Recommendation: B.** Curated-panel enterprises will require allowlists; wire at `revalidateInsideLock` before those deals, keep open as default for marketplace.  
- Not A: Pure contractual control fails when AP asks “who can my wallet pay?”  
- Not C: Blanket exclusivity breaks independent B2C experts prematurely.

## High concurrency / multi-device / spikes

Reachable-path checks are cheap and safe under load. Risk is **product inconsistency under concurrent admin edits** (capability CAS exists on org PATCH; program create can race with funding-source change). Under traffic spikes, incorrect tour docs (WALLET+LICENSED_SEAT) cause support storms, not DB corruption.

## Suggested directions

1. Publish this done-matrix in sales/eng one-pager.  
2. Reconcile host flag docs with code.  
3. Sponsor GTM now; host GTM only with dual-flag runbook.
