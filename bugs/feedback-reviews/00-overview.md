# Feedback & Reviews — Overview

## Context

Two concepts: **platform Feedback** (user → product, staff workflow) and **ConsultantReview** (consultee → consultant rating). Reviews surface on explore profiles; staff can moderate/delete. Novu notifies on feedback and new reviews. Moderation reports are a separate adjacent system.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| Review create does not denormalize `ConsultantProfile.rating` | ✅ FIXED-BY #987 |
| No unique constraint per consultee–consultant pair | ✅ FIXED-BY #987 (⚠️ de-dupe existing rows before db push) |
| No completed-booking eligibility gate | ✅ FIXED-BY #987 |
| Review POST does not prove `consulteeProfileId` ownership | ✅ FIXED-BY #987 |
| Public consultant search matches on email (PII) | ✅ FIXED-BY #987 |

## Known gaps / bugs

- Review create does **not** reliably denormalize `ConsultantProfile.rating` (delete path recalculates; create may not) — explore sort drift.
- No unique constraint per consultee–consultant pair — spam/multiple reviews possible.
- No completed-booking eligibility gate — unverified praise or revenge reviews.
- Review POST may not prove `consulteeProfileId` belongs to session user (ownership hole).
- Public consultant search can match on **email** — PII leak risk on explore API.

## Unhappy paths & user psychology

- Competitor creates five 1-star reviews without booking — trust collapse.
- Consultant rating stuck high after many new low reviews until someone deletes.
- User leaves feedback expecting product reply; ticket-like status unclear.

## Questions (handled?)

1. **One review per pair, gated on completed paid session?**  
   - A) Yes — unique + eligibility  
   - B) Allow updates to single review  
   - C) Open reviews; badge “verified booking”  

   **Recommendation: A.** Unique constraint plus completed paid-booking eligibility stops spam and revenge reviews while keeping explore trustworthy for Familiarise now.  
   - Not B: updates without an eligibility gate still allow an unverified first review  
   - Not C: open reviews invite competitor spam before any badge helps  

2. **Rating source of truth?**  
   - A) Live aggregate query  
   - B) Denormalized field with triggers on all mutations  
   - C) Nightly recompute job  

   **Recommendation: B.** Update the denormalized rating on every create/update/delete so explore sort stays correct without scanning all reviews per request.  
   - Not A: live aggregates are too expensive for card grids and infinite scroll  
   - Not C: nightly recompute leaves ratings wrong for a full day  

3. **Remove email from public search?**  
   - A) Immediate  
   - B) Admin-only search  
   - C) Hash/obfuscate  

   **Recommendation: A.** Strip email from public explore search immediately — it is a PII leak with no product upside.  
   - Not B: admin-only still widens blast radius if staff tools or logs leak  
   - Not C: hashing adds complexity without fixing that email should not be a discovery key  

## High concurrency / multi-device

Concurrent creates + deletes race the denormalized rating. Two devices submitting reviews — without unique key both succeed.

## Suggested directions

Gate reviews, fix rating updates on create/update/delete, strip email from public explore search.
