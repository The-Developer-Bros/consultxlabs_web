# Legal Pages, Grievance & Age

## Context

Privacy/Terms pages exist under `app/(pages)/` but company constants still contain placeholders. Consumer Protection e-commerce rules expect grievance officer, timelines, seller info. Age: `dateOfBirth` optional; no gate. Professional licensing: manual doc review ≠ regulated profession compliance.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| `[COMPANY NAME]` / `[ADDRESS]` / `[EMAIL]` placeholders — launch blocker | ✅ FIXED-BY #989 (name=Practitionist, address removed; email placeholders kept w/ TODO; supersedes #434, does not close it) |
| No `/grievance` page, no Grievance model, no 48h/30d SLA cron | 🟡 LEGIT-DEFERRED (user deferred) |
| No parental consent / 13+ or 18+ enforcement | 🟡 LEGIT-DEFERRED (user deferred) |
| No license number fields for CA/medical/legal verticals | 🟡 LEGIT-DEFERRED |
| CCPA dark-pattern self-audit documented without artifact | 🟡 LEGIT-DEFERRED |

## Known gaps / bugs

- `[COMPANY NAME]`, `[ADDRESS]`, `[EMAIL]` placeholders — launch blocker in hiring/research notes.
- No `/grievance` page, no Grievance model, no 48h/30d SLA cron.
- No parental consent / 13+ or 18+ enforcement.
- No license number fields for CA/medical/legal verticals.
- CCPA dark-pattern self-audit documented as obligation without artifact.

## Unhappy paths & user psychology

- Angry customer has nowhere obvious to escalate; posts on social; Razorpay dispute.
- Minor uses platform for paid consult — regulatory + reputational blowup.
- Regulated professional misrepresents credentials; platform verification rubber-stamped.

## Questions (handled?)

1. **Age policy?**  
   - A) 18+ hard gate with DOB  
   - B) 13+ parental consent  
   - C) No restriction until DPDP Phase 3  

**Recommendation: A.** 18+ with DOB is the cleanest India marketplace posture for paid professional consults.  
- Not B: Parental consent flows are heavy and still risky for paid advice.  
- Not C: Waiting until Phase 3 leaves minors in paid sessions today.

2. **Grievance officer — hire + page before GMV?**  
   - A) Before first paid consumer txn  
   - B) Shared founder email interim  
   - C) Enterprise MSA only; B2C later  

**Recommendation: A.** Publish grievance page and officer before consumer GMV — Consumer Protection Rules expect it.  
- Not B: Founder inbox is not a durable SLA or public grievance channel.  
- Not C: Enterprise MSA does not satisfy B2C e-commerce disclosure duties.

3. **Vertical licensing — marketplace trust or regulated?**  
   - A) Stay generalist ed-tech trust  
   - B) Build license verify for CA/legal/health  
   - C) Ban regulated advice categories  

**Recommendation: A.** Stay generalist trust signals for now; regulated verticals need dedicated compliance programs we are not ready to own.  
- Not B: License verify for CA/legal/health is a multi-year product, not a checkbox.  
- Not C: Hard bans shrink marketplace before we have clear category taxonomy.

## High concurrency / multi-device

Low; primarily policy. Multi-device signup should still hit same age gate once built.

## Suggested directions

Replace placeholders immediately. Publish grievance contacts. Decide age policy in writing.
