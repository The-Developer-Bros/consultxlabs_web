# Stream — Overview

## Context

Stream Chat + Stream Video power messaging and meetings. Lazy `StreamProvider`, server token generation, deterministic call IDs (`slot-{slotId}`), `MeetingSession` 1:1 with slots, webhook lifecycle/recording transfer to Supabase. Circuit breaker and idle deferred connect protect dashboard performance.

Canonical: `docs/stream/`, `lib/stream-client.ts`, `app/meetings/`.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| Recording cron pipeline loses data at scale (P0 infra) | ✅ FIXED-BY #983 (Phase-0: enqueue-on-ready, streaming upload, retention object delete, bounded concurrency, backlog alert) |
| External-S3 / Temporal / microservice rearchitecture | 🎯 DECLINED — Supabase stays the store; monolith + cron; no Temporal now |
| Token server actions accept arbitrary `userId` (#400) | ✅ FIXED-BY #981 (session-bind; #400 was CLOSED but regressed) |
| All app roles mapped to Stream `admin` | ✅ FIXED-BY #981 (demote to `user`; STAFF/ADMIN admin; channel-scoped consultant grants) |
| Client-side call creation ≠ Stream-enforced membership | 🟡 LEGIT-DEFERRED (server-side call create not in this wave) |
| Multi-tab duplicate participation allowed | 🟡 LEGIT-DEFERRED (soft-warn design decision) |
| Collaborator video roles deferred; passcode/hostKeys unused | 🟡 LEGIT-DEFERRED |

## Known gaps / bugs

- **P0 infrastructure:** Stream recordings live on Stream S3 for ~14 days; permanent retention relies on a sequential GH Actions cron (~40 transfers/day, 500MB in-memory) into Supabase — will lose data at webinar scale. See [recording-storage-scale-infrastructure.md](recording-storage-scale-infrastructure.md).
- **P0 security:** token server actions accept arbitrary `userId` without session bind (#400).
- All app roles mapped to Stream `"admin"` — weak channel permission model.
- Client-side call creation; app `validate-access` ≠ Stream-enforced membership.
- Multi-tab duplicate participation allowed.
- Collaborator video roles deferred; passcode/hostKeys unused.

## Unhappy paths & user psychology

- User joins from phone and laptop — echo, double tiles, “who is speaking?”
- Token leak / forged action mints another user’s chat identity.
- Recording expected on 1:1 consultation but disabled by plan rules — surprise.

## Questions (handled?)

1. **Prioritize #400 before any growth marketing?**  
   - A) Yes — hard gate  
   - B) Mitigate with network controls only  
   - C) Move tokens to session-bound API this sprint  

**Recommendation: A.** Unbound token minting is a hard security gate — no growth push until session binding ships.  
- Not B: Network controls do not stop a forged server action with another user’s id.  
- Not C: Sprint timing is the how; the decision must be “blocked until fixed,” not merely scheduled.

2. **Single active device per call?**  
   - A) Enforce  
   - B) Allow multi-device  
   - C) Warn only  

**Recommendation: C.** Warn in Setup first; hard kick can wait until we measure real multi-device abuse vs accessibility needs.  
- Not A: Immediate kick risks locking out legitimate phone↔laptop switches mid-consult.  
- Not B: Silent multi-device produces echo and “who is speaking?” blame on consultants.

## High concurrency / multi-device

Deterministic call IDs + DB unique help join races. Stream concurrent usage and Maker plan limits need monitoring.

## Suggested directions

Fix token binding and Stream role mapping before expanding chat surfaces.
