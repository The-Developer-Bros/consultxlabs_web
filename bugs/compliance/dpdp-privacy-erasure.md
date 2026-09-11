# DPDP, Privacy & Erasure

## Context

`ConsentArtifact` with purpose codes; signup stamps primary + Stream processing; org consent UI; Stream upsert gated; org DSAR export jobs; admin-mediated erasure scrub; cookie preferences; consent retention sweeper; breach 72h alert cron. User `termsAcceptedAt` / `privacyAcceptedAt` on onboarding.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| No consumer self-serve `/api/me` data export or delete | ❌ half-OVERSTATED — a self-serve erasure-REQUEST endpoint already ships; only data-EXPORT self-serve is absent (that part → 🟡 LEGIT-DEFERRED) |
| Consent withdrawal cascade incomplete (marketing processors, full Stream purge) | 🟡 LEGIT-DEFERRED |
| Multilingual notices not implemented | 🟡 LEGIT-DEFERRED |
| Breach model approximates single 72h clock | 🟡 LEGIT-DEFERRED |
| Doc drift: headers call `checkConsent` a stub — it is fail-closed live | ✅ FIXED-BY #989 (docstring corrected) |
| GDPR DPA pack with processors not productized | 🟡 LEGIT-DEFERRED |

## Known gaps / bugs

- No consumer self-serve `/api/me` data export or delete.
- Consent withdrawal cascade incomplete (marketing processors, full Stream purge).
- Multilingual notices not implemented.
- Breach model approximates single 72h clock; law wants immediate intimation + detailed report.
- Doc drift: some headers still call `checkConsent` a stub — it is fail-closed live.
- GDPR DPA pack with processors not productized.

## Unhappy paths & user psychology

- User withdraws consent in org UI; still gets marketing email — rage + regulator complaint.
- Erasure requested; finance retention keeps payment rows scrubbed — user thinks “not deleted.”
- EU user signs up; no GDPR-specific notice — future enforcement risk.

## Questions (handled?)

1. **Consumer DSAR before May 2027?**  
   - A) Self-serve this year  
   - B) Admin-only until Phase 3  
   - C) Email form + SLA cron  

**Recommendation: C.** Admin-mediated DSAR via email/form is fine interim if an SLA cron tracks overdue requests.  
- Not A: Full self-serve this year competes with legal placeholders, TDS, and grievance P0s.  
- Not B: Admin-only without SLA tracking fails the “interim OK if SLA exists” bar.

2. **India-only DPDP for v1 vs accept EU users?**  
   - A) Geo-block EU/UK  
   - B) Accept with GDPR pack  
   - C) Soft accept; fix later  

**Recommendation: A.** India DPDP first — geo-block EU/UK until a real GDPR pack exists.  
- Not B: GDPR pack is not productized; accepting now creates false compliance.  
- Not C: Soft accept is the highest-risk path for future enforcement.

3. **Recording retention default vs privacy policy promise?**  
   - A) Align copy to `streamRecordingRetentionDays`  
   - B) Shorten platform default  
   - C) Per-session user choice  

**Recommendation: A.** Make Privacy Policy match `streamRecordingRetentionDays` so product and legal say the same thing.  
- Not B: Shortening without product need creates storage churn and policy churn.  
- Not C: Per-session choice complicates disputes before baseline alignment ships.

## High concurrency / multi-device

Consent updates from two devices should last-write with audit. Erasure must invalidate sessions everywhere (`auth-broadcast` / session generation).

## Suggested directions

Ship consumer erasure request tracking UI even if processing stays admin. Fix consent withdrawal side effects for email/Novu.
