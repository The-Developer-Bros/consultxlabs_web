# Enterprise Multi-Device Gaming & Abuse

## Context

Enterprise money + seats + open B2B/B2C boundary (ADR-18) create **incentive surfaces**. Some “bugs” are intentional product openness; others are governance holes. Multi-device and multi-account behavior is how real abusers (and confused employees) reach inconsistent or profitable states.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's implementation gaps map as follows:

| Claim (short) | Verdict |
|---|---|
| No session/device fingerprint on program utilization | 🟡 LEGIT-DEFERRED |
| SCIM seat-cap asymmetry vs invitations | ✅ FIXED-BY #985 |
| `ProgramConsultantAllowlist` / `exclusiveEngagement` never read at checkout | ✅ FIXED-BY #982 (enforced at checkout per ADR 18) |
| KYB hard-gate missing | ✅ FIXED-BY #991 (domain gate) |
| Chaos suite does not simulate gaming scenarios | 🟡 LEGIT-DEFERRED |

## Attack / psychology catalogue

| Scenario | What happens today | Residual |
|----------|-------------------|----------|
| **Credential seat-sharing** | One LEARNER membership; many humans one password | No device binding on utilization — policy gap |
| **Dual-email self-deal** | LEARNER+EXPERT same org blocked; two emails not | Sponsor wallet pays “independent” expert alter ego |
| **Invoice ghost org** | ₹50k unverified cap; weak KYB | Exposure still real; payables may accrue (see payouts P0) |
| **SCIM vs invite cap** | Invites capped at 5 unverified; SCIM not | Token holder bypasses governance |
| **Open sponsor network (ADR-18)** | Wallet can pay any marketplace consultant | Allowlist stub unread — competitor funding |
| **Exclusive engagement stub** | Internal EXPERT still sells B2C | Agency revenue leakage by design until wired |
| **Referral + org wallet** | Referral credits stripped on non-PERSONAL | UX silent — not a money hole |
| **forceOverlap programs** | Operator can force ambiguous programs | Mis-metering / support hell |
| **Multi-org EXPERT** | Oldest membership wins split | Second agency gamed or underpaid |
| **Onboarding dual-role** | Last-write-wins platform role | Identity chaos (sibling onboarding file) |
| **SSO enforce before IdP ready** | Password still works if zero providers | Self-lockout avoidance; window of weak enforce |
| **Break-glass window** | Domain users password-login | Intended; needs audit watching |

## Known gaps / bugs (implementation)

- No session/device fingerprint on program utilization.
- SCIM seat-cap asymmetry vs invitations ([`lib/enterprise/governance.ts`](../../lib/enterprise/governance.ts) wired to invites only).
- `ProgramConsultantAllowlist` / `exclusiveEngagement` never read at checkout.
- KYB hard-gate missing (compliance sibling).
- Chaos suite does not simulate gaming scenarios (ghost INVOICE + expert READY).

## Unhappy paths & multi-device

- Employee shares login across iPads in a training room — one seat, five concurrent Stream joins — agency thinks seats are “broken.”
- Fraudster: signup org on phone, book on laptop, ignore invoice — consultant READY on desktop payout UI.
- Honest hybrid org self-deals (sponsor+host same payment) — harness-verified; finance must understand circular money is allowed.

## Questions (handled?)

1. **Seat-sharing defense?**  
   - A) Soft prompts + AE expansion offers (fingerprint heuristics)  
   - B) Hard single-session / device bind  
   - C) Contractual only  

**Recommendation: A then selective B.** Start with detection + sales motion; hard bind for high-fraud verticals.  
- Not C alone for LICENSED_SEAT SKUs sold on headcount.  
- Not B globally first — breaks legitimate multi-device learners.

2. **ADR-18 allowlist timeline?**  
   - A) Wire before curated enterprise panels  
   - B) Keep forever open  
   - C) Default closed for new sponsor orgs  

> 🎯 Locked: ADR 18 — allowlist/exclusivity now enforced at checkout (#982); open sponsor network stays the default until curated panels require closing.

**Recommendation: A.** Open default OK; enforce allowlist when selling curated panels.  
- Not B if enterprise RFPs demand closed panels.  
- Not C yet — closes marketplace liquidity early.

3. **SCIM vs unverified seat cap?**  
   - A) Apply same cap / KYB to SCIM  
   - B) Trust SCIM token = verified  
   - C) Disable SCIM until ACTIVE  

**Recommendation: A (or C).** Provisioning must not outrank invite governance for unverified orgs.  
- Not B: Stolen/early SCIM tokens become seat factories.  
- C acceptable until KYB live.

4. **Ghost INVOICE + expert payables?**  
   - A) Park consultant earnings + KYB gate (money-payouts file)  
   - B) Cap only  
   - C) Require prepay WALLET for new orgs  

**Recommendation: A.** Cap is insufficient without payable parking.  
- Not B alone.  
- C optional product SKU, not sole control.

## High concurrency / multi-device / spikes

Gaming often uses **parallel devices** (book while admin raises limit; SCIM while invites fire). Controls must be server CAS + governance, not UI. Under traffic spikes, fail **closed** on seats/credits (industry): never “allow” when counter store errors.

## Suggested directions

1. SCIM governance parity + KYB hard gates.  
2. Allowlist enforcement hook at checkout for panel deals.  
3. Fraud dashboard: unverified INVOICE exposure, PENDING_TRUST (once fixed), multi-device login anomalies.  
4. Document hybrid self-deal as allowed economics for finance.
