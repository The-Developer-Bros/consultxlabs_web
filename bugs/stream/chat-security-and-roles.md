# Chat Security & Roles

## Context

Channels: DMs (`dm-…`), webinar/class team channels, collab channels, legacy consultation/subscription names. Server creates/syncs channels; org tagging on custom data. DPDP consent gates Stream user upsert. Unread badges read client singleton.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| `chatTokenProvider` not proving `session.user.id === userId` (#400) | ✅ FIXED-BY #981 (session-bind) |
| `mapRoleToStream()` maps everyone → Stream `admin` | ✅ FIXED-BY #981 (demote to `user`; STAFF/ADMIN admin; channel-scoped consultant grants) |
| Consultee↔consultee / consultant↔consultant chat policy incomplete | 🟡 LEGIT-DEFERRED |
| Docs claim token issuance verifies user existence; code may not | ✅ FIXED-BY #981 (session-bound issuance) |
| In-memory server caches ineffective across serverless instances (perf) | 🟡 LEGIT-DEFERRED (perf, not auth) |

## Known gaps / bugs

- `chatTokenProvider(userId)` / related actions not proving `session.user.id === userId` (#400).
- `mapRoleToStream()` maps CONSULTEE (and others) to Stream `admin`.
- Consultee↔consultee and consultant↔consultant chat policy incomplete (`tasks/stream-comms-issues.md`).
- Docs claim token issuance verifies user existence — code may not.
- In-memory server caches ineffective across serverless instances (perf, not auth).

## Unhappy paths & user psychology

- Blocked user still reachable via another channel type.
- Org admin exports chat metadata expecting redaction; PII slips.
- Consent withdrawn mid-thread — upsert fails; existing WS session degrades oddly.

## Questions (handled?)

1. **Stream role model?**  
   - A) `user` / channel_member with typed grants  
   - B) Keep admin for simplicity (reject)  
   - C) Separate Stream apps for consult vs org  

**Recommendation: A.** Demote everyone off Stream `admin` and grant channel-scoped permissions by product role.  
- Not B: Admin-for-all is an explicit reject — any member can escalate channel powers.  
- Not C: Two Stream apps double ops cost before we fix the mapping bug.

2. **Consultee↔consultee messaging?**  
   - A) Forbid  
   - B) Allow in class/webinar only  
   - C) Allow DMs with report button  

**Recommendation: B.** Class/webinar channels need peer chat; open DMs wait until abuse reporting exists.  
- Not A: Breaks cohort/classroom product expectations.  
- Not C: Broad DM graph without report tooling invites harassment and support load.

3. **Token API shape?**  
   - A) Authenticated route; ignore body userId  
   - B) Server action with assertSession  
   - C) Short-lived call-scoped tokens only  

**Recommendation: A.** Session-bound route that ignores client-supplied `userId` closes #400 cleanly for chat and video.  
- Not B: Assert helps but still tempts “pass userId” call sites to drift.  
- Not C: Call-scoped alone does not fix chat token minting.

## High concurrency / multi-device

Each tab may hold StreamChat instance; logout must disconnect. Cross-tab unread can desync until refresh.

## Suggested directions

Ship #400 + demote Stream roles. Add abuse report path before opening broader DM graph.
