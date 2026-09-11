# Collaborators — Overview

## Context

Unified `Collaborator` for webinar/class plans: invite, accept, revenue bps (host ≥10%, collaborators ≤90%), permissions booleans, Stream collab channels, multi-party earnings and refund tests. Availability overlay APIs exist. Consultation co-consultant out of scope (1:1). Podcast collaborators not modeled.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| Permission booleans richer in schema than enforced | ✅ FIXED-BY #989 (set on invite; `canSeeAttendees` enforced; `canApprovePayment`/`ViewAnalytics`/`EditEvent` set-only + TODO — no endpoint to gate yet) |
| XOR webinar/class plan IDs app-enforced only (no DB check) | ✅ FIXED-BY #989 (check-constraints.sql, #784) |
| Collaborator video host/moderator roles deferred | 🟡 LEGIT-DEFERRED (stream pack) |
| Org-hosted expert collaborator path gated `ENABLE_HOST_ORGS` | 🔵 by-design gate |
| Legal revenue-share assent not in ToS flow | 🟡 LEGIT-DEFERRED |

## Known gaps / bugs

- Permission flags richer in schema than API enforcement surface — audit needed.
- XOR webinar/class plan IDs app-enforced only (no DB check).
- Collaborator video host/moderator roles deferred (stream pack).
- Org-hosted expert collaborator path depends on `ENABLE_HOST_ORGS`.
- Legal revenue-share agreements not captured in product ToS flow.

## Unhappy paths & user psychology

- Collaborator accepts, expects to end call / approve payments; buttons missing.
- Host changes split after sessions sold — historical earnings frozen but future surprise.
- Concurrent invites push total share >90% — Serializable should block; UI may not explain.
- Removed collaborator still in Stream channel until sync — awkward messages.

## Questions (handled?)

1. **Co-consultation for 1:1 on roadmap?**  
   - A) Never  
   - B) Later product  
   - C) Soft co-host without revenue split  

   **Recommendation: B.** Keep 1:1 co-consult out of scope for now and revisit later — webinar/class collab is the product that already ships.  
   - Not A: “never” closes a plausible future without needing that decision today  
   - Not C: soft co-host without revenue creates support and Stream edge cases now  

2. **Can collaborators schedule?**  
   - A) Host-only forever  
   - B) Permission-gated  
   - C) Role-based (moderator yes)  

   **Recommendation: B.** Permission-gated scheduling later — schema already has booleans; enforce them when the API surface is audited.  
   - Not A: host-only forever blocks real collaborator workflows as the feature matures  
   - Not C: moderator roles pull in Stream complexity before permission flags are enforced  

3. **Capture revenue share legal assent?**  
   - A) Clickwrap on accept  
   - B) External contract only  
   - C) Org MSA covers  

   **Recommendation: A.** Clickwrap on invite accept captures revenue-share assent in-product for SMB hosts without legal ops.  
   - Not B: external contracts alone will not scale beyond a few design partners  
   - Not C: an org MSA does not cover individual collaborator assent on consumer plans  

## High concurrency / multi-device

Invite Serializable + reactivate declined rows — solid. Accept/remove from two devices should CAS status. Earnings per payment snapshot avoids mid-flight split edits affecting past.

## Suggested directions

Audit permission enforcement vs UI. Document host-only video controls until roles ship. Clickwrap on invite accept.
