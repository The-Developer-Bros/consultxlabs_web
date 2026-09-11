# Referrals — Overview

## Context

`ReferralCode` → `Referral` attribution → `ReferralCredit` spend at checkout. Deferred qualify on first paid booking (Serializable, budget gates, program pause). Pending code in localStorage + `/r/[code]` + `?ref=`. Crons expire credits/referrals. Launch economics conservative (₹300/₹300 class defaults; docs may still mention older amounts).

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| Signup wipes stashed referral code (#891) | ✅ FIXED-BY #989 (Closes #891) |
| Cross-device attribution loss (localStorage) | 🔵/🎯 accepted — post-auth entry deferred (rec C) |
| Phone step-up anti-sybil (#884) planned | 🔵 TRACKED #884 |
| Doc/code drift on reward amounts | 🟡 LEGIT-DEFERRED |
| Org-funded checkout credit blocking (#766) audit | 🔵 TRACKED #766 (enforced; audit periodically) |
| Consultant commission waiver later phases | 🟡 LEGIT-DEFERRED |

## Known gaps / bugs

- **Cross-device attribution loss:** localStorage pending code does not survive OAuth on another device (documented acceptable).
- Phone step-up anti-sybil (#884) planned, not done.
- Doc/code drift on reward amounts.
- Org-funded checkout credit blocking (#766) must stay enforced everywhere — audit periodically.
- Consultant commission waiver “later phases.”

## Unhappy paths & user psychology

- Friend shares link; user finishes Google auth on desktop without `?ref=` — attribution lost; both angry.
- Farming rings create many accounts — without phone verify, budget cap is main defense.
- Partial refund restores credit usage — user confused why credit returns differently than cash.

## Questions (handled?)

1. **Cross-device attribution?**  
   - A) Server-side cookie / account claim code entry  
   - B) Accept localStorage loss  
   - C) Require code entry post-signup always  

   > 🎯 Locked: current localStorage behavior accepted; post-auth code-entry capture deferred (rec C not built this wave).


   **Recommendation: C.** Always offer post-auth “have a referral code?” entry so OAuth on another device does not silently drop attribution.  
   - Not A: cookies still fail across devices and browsers after OAuth  
   - Not B: accepting localStorage loss guarantees friend-share betrayal  

2. **Economics lock for launch?**  
   - A) Keep ₹300/₹300 + caps  
   - B) Ramp referrer to ₹500 later  
   - C) Pause program via config  

   **Recommendation: A.** Keep conservative ₹300/₹300 plus caps at launch so farming risk stays bounded while docs catch up.  
   - Not B: ramping to ₹500 early raises sybil payout before phone verify lands  
   - Not C: pausing is a kill switch, not a launch economics decision  

3. **Phone verify before credit spend or qualify?**  
   - A) Before qualify  
   - B) Before spend  
   - C) Defer #884  

   **Recommendation: A.** Require phone verify before qualify so fake accounts never mint referral credit into the budget.  
   - Not B: before-spend still lets farm rings burn the program budget at qualify time  
   - Not C: deferring #884 leaves the main anti-sybil gap open at launch  

## High concurrency / multi-device

Apply/qualify use Serializable retries — good. Multi-device signup races on same code should unique-constrain. Budget gate under parallel qualifies needs the serializable path (present).

## Suggested directions

Add post-auth “have a referral code?” field. Reconcile docs with constants. Keep org-funded credit block tested.
