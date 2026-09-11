# Recordings & Webhooks

## Context

Webhook route verifies HMAC; handles recording lifecycle, session end, participant join/leave, moderation flags. Recordings start on STREAM_S3 (URL expiry ~14 days) and transfer to Supabase per plan. Jobs transfer expiring, mark expired, cleanup old. Slot completion updated on session/call end.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| Consultation/subscription recording disabled by design — expectation mismatch | 🟡 LEGIT-DEFERRED (product-policy) |
| Transfer failures alert after retries; files `>500MB` unsupported | ✅ FIXED-BY #983 (streaming upload; enqueue-on-ready) |
| Missing MeetingSession for webhook → logged no-op (orphan calls invisible) | 🟡 accurate caveat (by-design) |
| #471/#472 no-show/overrun may not fully consume attendance | ✅ FIXED-BY #992 (no-show automation, consultations) |
| Org calls export DB-backed; live Stream query for orphans incomplete | 🟡 LEGIT-DEFERRED |
| Webhook sweeper parity with Razorpay | 🟡 LEGIT-DEFERRED (#899) |

## Known gaps / bugs

- Consultation/subscription recording often disabled by design — product expectation mismatch.
- Transfer failures alert after retries; files >500MB unsupported.
- Missing MeetingSession for webhook → logged no-op (orphan calls invisible).
- #471/#472 no-show/overrun may not fully consume attendance yet.
- Org calls export DB-backed; live Stream query for orphans incomplete.

## Unhappy paths & user psychology

- User expects download after 1:1; button missing — trust hit.
- Recording shows in Stream briefly then URL expires before transfer — “lost evidence” in disputes.
- Consent for recording not obvious in Setup — legal risk.

## Questions (handled?)

1. **Enable 1:1 recording with explicit consent?**  
   - A) Opt-in per session  
   - B) Plan flag only for webinar/class  
   - C) Org-policy forced recording  

**Recommendation: A.** Opt-in per session with clear Setup consent matches DPDP expectations and dispute needs.  
- Not B: Leaves 1:1 users surprised when they need evidence.  
- Not C: Forced org recording without consent UX is a privacy landmine.

2. **Dispute evidence retention default?**  
   - A) Align with `streamRecordingRetentionDays` + legal hold  
   - B) 14 days max always  
   - C) Transfer-all immediately  

**Recommendation: A.** One retention story in product + legal hold for open disputes beats ad-hoc Stream expiry.  
- Not B: 14 days is Stream URL life, not our policy promise.  
- Not C: Transfer-all burns storage before we know what matters.

> 🎯 Locked: Recording rows expire at `now() + 14d`; Supabase remains the permanent store.

3. **Webhook sweeper for Stream (parity with Razorpay)?**  
   - A) Replay unprocessed  
   - B) Rely on Stream retries only  
   - C) Nightly reconcile vs Stream API  

**Recommendation: A.** Replay unprocessed events mirrors Razorpay discipline and catches missed recording/session ends.  
- Not B: Vendor retries alone leave orphan MeetingSession gaps silent.  
- Not C: Nightly reconcile is slower for live-call state than event replay.

## High concurrency / multi-device

Duplicate recording events should be idempotent. Two hosts starting record from two devices — need clear single controller UX.

## Suggested directions

Consent copy in MeetingSetup. Monitor transfer failure alerts during pilot.

**Scale / durability:** the cron pull-transfer path is a P0 infrastructure risk at growth — see [recording-storage-scale-infrastructure.md](recording-storage-scale-infrastructure.md) (Stream external S3 + durable workflows recommended over GH Actions as the long-term design).
