# Onboarding Multi-Device Role Race

## Context

`User.email` is unique; `User.role` is **singular**. CONSULTANT/CONSULTEE roles commit mainly at final `processOnboardingData`; ORG_WORKSPACE commits earlier at step 0. Two devices, same email, different role wizards, simultaneous submit → **last write wins**. Transaction clears profile FKs and upserts one role’s profile — orphan profile rows possible.

This is the exact unhappy path: firm onboarding on one device as consultant, other device as consultee, both hit submit.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| No optimistic locking / version CAS on `User` during onboarding | ✅ FIXED-BY #985 (CAS on onboardingCompleted) |
| No onboarding mutex (unlike invite accept) | ✅ FIXED-BY #985 |
| `sessionGeneration` not always bumped on mid-onboarding role flips | ✅ FIXED-BY #985 |
| Chaos suite covers login, not multi-role onboarding | 🟡 LEGIT-DEFERRED |
| Orphan `ConsultantProfile` / `ConsulteeProfile` rows linger | 🟡 LEGIT-DEFERRED (soft-keep for audit by design) |

## Known gaps / bugs

- No optimistic locking / version CAS on `User` during onboarding.
- No onboarding mutex (unlike invite accept atomic claim).
- `sessionGeneration` bumps on membership changes, not always on mid-onboarding role flips.
- Chaos suite covers multi-device **login**, not multi-role **onboarding**.
- Orphan `ConsultantProfile` / `ConsulteeProfile` rows can linger after role flip.

## Unhappy paths & user psychology

- Founder starts consultant onboarding on laptop, tries consultee “just to see” on phone, submits both — ends as wrong role with half-filled profile.
- ORG_WORKSPACE step-0 commit on device A; device B still shows consultee steps from cache.
- User thinks they can be both consultant and learner under one email without understanding Membership vs UserRole.

## Questions (handled?)

1. **Is one email = one platform role permanent product law?**  
   - A) Yes — dual needs = Membership LEARNER + CONSULTANT user  
   - B) Allow dual platform roles (schema change)  
   - C) Separate accounts encouraged  

**Recommendation: A.** Singular `UserRole` plus Membership for cross-org needs matches Arch 4 and avoids dual-wizard races.  
- Not B: Schema change reopens the exact multi-device race we need to close.  
- Not C: Separate accounts punish real dual-need users and fragment SSO identity.

2. **Concurrent onboarding submit — how to handle?**  
   - A) Role lock at step 0 for all roles + CAS on submit  
   - B) Reject second submit if `onboardingCompleted` or role mismatch  
   - C) Accept last-write-wins; cleanup orphans via job  

**Recommendation: A.** Early role lock plus CAS makes last-write-wins impossible and matches invite-accept hardness.  
- Not B: Still allows mid-wizard flips before `onboardingCompleted`.  
- Not C: Leaves founders in the wrong role with silent orphan profiles.

3. **After role flip, delete unused profiles?**  
   - A) Hard delete unused  
   - B) Soft keep for audit  
   - C) Merge data where possible  

**Recommendation: B.** Soft-keep preserves audit/dispute evidence if a flip was accidental or contested.  
- Not A: Hard delete erases forensic trail on a high-stakes identity change.  
- Not C: Merge is ambiguous across consultant vs consultee shapes and delays the fix.

## High concurrency / multi-device

Worst case is simultaneous final submits. Also bad: one device completes while other still editing local wizard state and overwrites later.

## Suggested directions

Add explicit “You started as X on another device” banner via polling `User.role`. Wire CAS on `processOnboardingData`. Add chaos test for dual-role submit.
