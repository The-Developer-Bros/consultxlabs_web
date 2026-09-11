# Compliance — Overview

## Context

Dual-rail compliance: strong **B2B enterprise** primitives (GST/TDS helpers, invoices, audit logs, DPDP artifacts, MSME, IRP gated) vs weaker **B2C marketplace** (TDS engine drift, TCS unwired, grievance missing, consumer DSAR missing). Primary privacy framework is DPDP (India); GDPR mentioned but not coded as first-class.

Canonical: `docs/compliance/`, `lib/compliance/`, `jobs/compliance/`.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| Legal pages use `[COMPANY NAME]` placeholders — P0 enforceability | ✅ FIXED-BY #989 (name=Practitionist, address removed; email placeholders kept w/ TODO; supersedes #434, does not close it) |
| No consumer grievance officer flow | 🟡 LEGIT-DEFERRED (user deferred) |
| B2C TDS wrong-path risk | ❌ STALE — consultant withholding is already 194-O |
| GST TCS schema-only | 🟡 LEGIT-DEFERRED |
| Age gate not enforced; professional licenses not verified | 🟡 LEGIT-DEFERRED (user deferred) |
| DPDP Phase 3 runway — consumer layer incomplete | 🟡 LEGIT-DEFERRED |

## Known gaps / bugs

- Legal pages use `[COMPANY NAME]` placeholders — **P0** enforceability.
- No consumer grievance officer flow (Consumer Protection Rules).
- B2C TDS wrong-path risk; GST TCS schema-only.
- Age gate not enforced; professional licenses not verified.
- May 2027 DPDP Phase 3 runway — consumer layer incomplete.

## Unhappy paths & user psychology

- User requests data deletion via email; only admin erasure path exists — slow, opaque.
- Consultant assumes platform handles all tax filings; notices wrong TDS.
- Parent lets teen create account — no age check.

## Questions (handled?)

1. **Legal harden before first paid txn?**  
   - A) Hard gate  
   - B) Design-partner MSA covers  
   - C) Ship with draft TOS marked beta  

**Recommendation: A.** Replace placeholders before any paid txn — unenforceable TOS/Privacy is a launch blocker.  
- Not B: MSA does not cover B2C checkout or public page enforceability.  
- Not C: “Beta draft” TOS still fails consumer and enterprise diligence.

2. **B2B-only compliance posture until B2C tax fixed?**  
   - A) Yes  
   - B) Fix TDS/TCS in parallel  
   - C) Manual CA for B2C interim  

**Recommendation: A.** Keep B2B posture until TDS is unified; do not scale B2C payouts on dual engines.  
- Not B: Parallel fix without a payout gate still ships wrong withholdings.  
- Not C: Manual CA interim without a hard stop invites silent wrong filings at volume.

## High concurrency / multi-device

Compliance is mostly process/ correctness; concurrent invoice numbering and consent writes need care (see finances/tax).

## Suggested directions

Replace legal placeholders; unify TDS; appoint grievance + DPDP officers on paper and in product.
