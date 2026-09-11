# Video Calls & Multi-Device

## Context

Join: lazy meeting create with `slot-{id}` → `/meetings/[id]` → validate-access → Setup → `call.join()`. Host end via consultant EndCallButton. Attendance upserted from webhooks (`MeetingAttendance` per user, not per device). Join windows: consultee ~10 min early, consultant ~15.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| Client `getOrCreate` can create Stream call before DB row (orphan window) | 🟡 LEGIT-DEFERRED (server-side call create not in this wave) |
| Multi-tab: multiple `user_session_id`s — echo, double-billing risk | 🟡 LEGIT-DEFERRED (soft-warn design decision) |
| Meeting unmount `leave()` fights another tab still in call | 🟡 LEGIT-DEFERRED |
| `useGetCallById` fallback may create calls despite subtle access story | 🟡 LEGIT-DEFERRED |
| Consultee path still static-imports SDK (bundle debt #248 partial) | 🔵 TRACKED #248 |
| Passcode / hostKeys in schema unused | 🟡 LEGIT-DEFERRED |
| Call ID + stolen token bypasses page gate (ties to #400) | ✅ FIXED-BY #981 (token session-bind) |

## Known gaps / bugs

- Client `getOrCreate` can create Stream call before DB row — orphan call window if DB fails.
- Multi-tab: multiple `user_session_id`s — echo, double billing risk on Stream concurrent.
- Meeting unmount `leave()` can fight another tab still in call.
- `useGetCallById` fallback may create calls even when access story is subtle.
- Consultee path still static-imports SDK (bundle debt #248 partial).
- Passcode / hostKeys in schema unused.

## Unhappy paths & user psychology

- iPad + phone both join; audio feedback ruins session; consultee blames consultant.
- Host ends on one device; other device shows rejoin loop.
- Late join after endedAt set — confusing empty room vs blocked UI.
- Knowing call ID + stolen token bypasses page gate (ties to #400).

## Questions (handled?)

1. **Create all calls server-side with Node SDK?**  
   - A) Yes — membership + roles server-defined  
   - B) Keep client getOrCreate  
   - C) Hybrid: server create, client join only  

**Recommendation: A.** Server-defined members and roles close the orphan-call window and stop client-created bypasses.  
- Not B: Client getOrCreate is the orphan and membership gap.  
- Not C: Hybrid still risks client create fallbacks unless getOrCreate is fully removed.

2. **Multi-device policy?**  
   - A) Kick older session  
   - B) Allow; show “you’re in this call elsewhere”  
   - C) Soft warn in Setup  

**Recommendation: C.** Soft warn before hard kick — educate on echo without locking out legitimate device switches yet.  
- Not A: Hard kick first is harsh until we see real abuse rates.  
- Not B: Allowing without a Setup friction still causes double-tile chaos.

3. **Enforce call membership in Stream, not only validate-access?**  
   - A) Stream call members required  
   - B) App gate enough  
   - C) Backstage + waiting room  

**Recommendation: A.** App `validate-access` alone fails when token binding is wrong — Stream membership is the real gate.  
- Not B: Page gate is bypassable with call ID + forged token (#400).  
- Not C: Waiting room is product polish after membership enforcement exists.

## High concurrency / multi-device

Concurrent joins same slot: DB unique + P2002 handler. Webhook join storms: idempotent attendance upsert; joinCount may inflate on replay.

## Suggested directions

Server-side call create + single-session policy decision. Use attendance for #471 no-show.
