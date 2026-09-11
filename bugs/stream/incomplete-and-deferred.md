# Stream Incomplete & Deferred

## Context

Documented deferrals and dead code around Stream.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| Collaborator video roles (host/moderator/speaker) deferred | 🟡 LEGIT-DEFERRED |
| Instant `createMeeting()` in `lib/meeting.ts` has no callers (dead code) | ✅ FIXED-BY #983 (deleted) |
| Passcode / hostKeys unused | 🟡 LEGIT-DEFERRED |
| Backfill org metadata scripts exist for channels/calls | 🟡 LEGIT-DEFERRED (tooling, not a bug) |
| Hard-delete soft-deleted Stream users >30 days (script TODO) | 🔵 TRACKED #535 |
| Channel naming duplication / policy issues | 🟡 LEGIT-DEFERRED |
| Maker plan concurrent limits — monitoring unclear | 🟡 LEGIT-DEFERRED |

## Known gaps / bugs

- Collaborator video roles (host/moderator/speaker) deferred — `docs/collaborators/05-stream-integration.md`.
- Instant `createMeeting()` in `lib/meeting.ts` — no callers.
- Passcode / hostKeys unused.
- Backfill org metadata scripts exist for channels/calls.
- Hard-delete soft-deleted Stream users >30 days — script TODO.
- Channel naming duplication / policy issues in `tasks/stream-comms-issues.md`.
- Maker plan concurrent limits — monitoring unclear (`docs/competition/...` brutal gaps).

## Unhappy paths & user psychology

- Collaborator expects host controls; only primary consultant can end call.
- Support cannot find ad-hoc meeting without MeetingSession row.

## Questions (handled?)

1. **Collaborator roles before host-org GA?**  
   - A) Required  
   - B) After ENABLE_HOST_ORGS  
   - C) Never — host-only end  

**Recommendation: B.** Ship collaborator video roles with host-org GA when multi-expert economics actually need them.  
- Not A: Pulls Stream role work ahead of sponsor-first sequencing.  
- Not C: “Never” contradicts webinar/class collaborator product already in schema.

2. **Delete dead `createMeeting` or productize instant rooms?**  
   - A) Delete  
   - B) Productize personal rooms  
   - C) Keep internal/admin only  

**Recommendation: A.** Dead entry points confuse ownership of MeetingSession and orphan-call debugging — delete until productized.  
- Not B: Instant rooms expand surface before #400 and server-side create land.  
- Not C: “Internal only” still leaves unowned code paths support will hit.

## High concurrency / multi-device

Deferred roles matter most when multiple experts join the same webinar from different devices.

## Suggested directions

Either schedule collaborator video roles or document “host-only controls” in UI.
