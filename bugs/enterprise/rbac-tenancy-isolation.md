# RBAC & Tenant Isolation

## Context

Org RBAC: `MemberRole` ladder + surface permissions (`members.manage`, `billing.manage`, …). Enforcement: `requireOrgAccess` requires ACTIVE membership (ADMIN stub exception), optional capability/funding gates. BetterAuth `Member` kept for invite tokens; `Membership` is source of truth. LEARNER ↔ EXPERT transitions blocked — remove and re-invite.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| No Postgres RLS — service-role Prisma | 🔵 TRACKED #771 (CLOSED — 🎯 accepted API-layer isolation) |
| Hierarchy scoping not in `requireOrgAccess` (#771); APIs 501 | 🔵 TRACKED #771 |
| `exclusiveEngagement` unenforced | ✅ FIXED-BY #982 (enforced at checkout per ADR 18) |
| Settings UI/API permission drift (#779 class) | 🔵 TRACKED #779 |
| Bulk member API 405 anti-lockout | 🟡 LEGIT-DEFERRED (by-design anti-lockout) |
| Invite EXPERT vs SSO JIT lazy-create asymmetry | 🟡 LEGIT-DEFERRED |

## Known gaps / bugs

- No Postgres RLS — service-role Prisma; defense-in-depth deferred.
- Hierarchy `parentOrganizationId` / subtree scoping not in `requireOrgAccess` (#771) — APIs stub 501.
- `exclusiveEngagement` unenforced — experts may still sell B2C independently.
- Settings: some UI fields MAINTAINER-visible but OWNER-only in API (#779 class of bugs).
- Bulk member API returns deterministic 405 (anti-lockout) — HRIS expectation mismatch.
- Invite EXPERT requires existing ConsultantProfile; SSO JIT can lazy-create — asymmetry.

## Unhappy paths & user psychology

- Disgruntled MANAGER keeps billing bookmark; role demoted but cached UI still offers actions until 403.
- Two orgs claim same domain — SSO exclusivity is global unique; loser blocked without clear dispute UX.
- Last OWNER tries to leave — need anti-lockout; bulk ops disabled may frustrate IT.

## Questions (handled?)

1. **RLS timeline vs design-partner contracts?**  
   - A) Document API isolation as sufficient  
   - B) RLS before any SOC 2 language  
   - C) RLS only when Supabase client exposure  

> 🎯 Locked: accepted API-layer isolation for design partners (rec A); RLS stays roadmap defense-in-depth (#771 CLOSED).

**Recommendation: A.** Honest API-tenancy language unblocks design-partner DPAs; put RLS on the roadmap, not on the critical path.  
- Not B: Over-commits before we have RLS design and migration plan.  
- Not C: Waiting for client exposure leaves a known gap undated.

2. **EXPERT invite — lazy-create consultant profile?**  
   - A) Parity with SSO JIT  
   - B) Keep strict “onboard as consultant first”  
   - C) Org-hosted expert profile distinct from marketplace consultant  

**Recommendation: B.** Keep marketplace consultant onboarding as the gate until host-org expert identity is a real product path.  
- Not A: Lazy-creates marketplace consultants for org invites and blurs sponsor vs host.  
- Not C: Premature while `ENABLE_HOST_ORGS` is still off.

3. **Domain claim disputes process?**  
   - A) Manual admin arbitration  
   - B) DNS re-verify winner takes all  
   - C) Allow shared domains with break-glass  

**Recommendation: A.** Design-partner volume is low enough that founder/ops arbitration is faster and clearer than automated winner-take-all.  
- Not B: DNS races and spoof edge cases still need humans.  
- Not C: Shared domains weaken SSO exclusivity and complicate enforceSSO.

## High concurrency / multi-device

Invite accept atomic; pending invite unique; seat counters conditional. Session veto for SSO-enforced domains. Stale sessions up to clock skew if `sessionGeneration` missed.

## Suggested directions

Align invite vs SSO expert creation rules. Fix UI/API permission drift on settings.
