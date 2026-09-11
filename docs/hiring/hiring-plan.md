# Familiarise — Hiring Plan

**Last updated:** 2026-04-22
**Owner:** CEO
**Status:** Living document — review monthly until Phase 2, then quarterly
**Horizon covered:** Pre-launch through first 12 months post-launch

---

## 1. Executive summary

Familiarise is a pre-MVP, 2-3 person expert-services marketplace competing against well-funded incumbents (Topmate ~$1.13M raised, Preplaced, GrowthSchool ~$4M+, Metvy, upGrad). The company's moat is **capital efficiency + founder-led execution + India-native payments + an integrated 4-service-type product** — none of which survive headcount bloat.

This document lays out a phased hiring plan that assumes:

- Every full-time hire costs ~₹7-15L/year fully loaded (salary + laptop + tools + benefits).
- The correct default answer to "should we hire?" is **no**, until a specific constraint has been demonstrated.
- Interns are your cheat code. India's internship pool is exceptional at ₹8-15K/month stipends.
- The first 18 months are about surviving long enough to find product-market fit, not building a company that looks like a company.

The plan gates hires on **evidence of a constraint**, not on "we should probably have a designer by now" logic. Each phase has explicit trigger conditions.

Three-sentence summary:

1. **Phase 0 (now → first 5 paying customers):** stay at 3 FT + 2 interns. Total burn ≈ ₹55K/month.
2. **Phase 1 (first 10-20 paying customers):** add a CS lead, a junior dev, and a content marketer. Total burn ≈ ₹2.0-2.5L/month.
3. **Phase 2 (₹3-5L MRR):** add a senior dev (with equity), optionally a designer, and think about a PM.

Everything else (DevOps, dedicated QA, CFO, HR, Chief of Staff, Growth Engineer, etc.) is either deferred or never hired.

---

## 2. Operating reality

### 2.1 Who we are today

| Role | Person | Compensation | Commitment |
|---|---|---|---|
| CEO / Product / Tech lead | Founder | — (equity) | Full-time |
| Full-stack developer | Shubham | ₹10K base + ₹5K performance | Full-time |
| Sales (commission-based) | Shelu | ₹200-300 per conversion | Pure commission |

### 2.2 Monthly fixed costs (pre-launch, Feb 2026)

| Bucket | Monthly |
|---|---|
| Salaries (Shubham base + performance) | ~₹15K |
| SaaS (Claude Max + Apple Developer + domain) | ~₹12K |
| Gateway fees, misc | Nil at zero volume |
| **Pre-launch burn** | **~₹22-27K/month** |

Reference: `docs/stream/00-pricing-overview.md` (Stream costs) and `docs/finances/09-pricing-strategy.md` (full cost model).

### 2.3 The David vs Goliath reality

Your competitors raised $1M-$4M+ and have 30-100 person teams. You cannot out-hire them. You cannot out-feature them. Attempting to replicate their org chart with 8 people will destroy the company. The playbook is asymmetric:

- **Don't compete on breadth.** Pick the tech-mentor vertical and dominate it.
- **Compete on founder-access.** 6-12 month advantage; milk it.
- **Compete on commission economics.** 10% (UPI-first) beats Topmate's effective 15-17% (Stripe + FX) for Indian creators. Ref: `docs/finances/03-pricing-calculator.md`.
- **Compete on integration depth.** 4 service types + integrated Stream chat/video + document review is unique.

Hiring implication: every hire must serve the asymmetric play. Hires that just replicate what incumbents already do well (broad marketing teams, big CS orgs, enterprise sales teams pre-PMF) are net-negative.

---

## 3. Mental models to use before any hire

### 3.1 Severity vs tier — keep them separate

Two different axes people often confuse:

**Severity — how bad is this issue?**

| Level | Definition | SLA | Who gets paged |
|---|---|---|---|
| P0 | Platform down, payment stuck, data loss | Minutes | CEO + on-call dev |
| P1 | Feature broken for many users | Same-day | Dev team |
| P2 | Bug affecting some users, workaround exists | Next sprint | Dev team |
| P3 | Nice-to-have, feedback | Backlog | Product owner |

**Tier — who does the work?**

| Level | Definition | Owner |
|---|---|---|
| L1 | First-line: FAQ, password resets, how-to, ticket triage, canned responses (~80% of volume) | CS intern / CS lead |
| L2 | Investigates bugs: reads logs, reproduces, writes clean repro (~15% of volume) | CS lead + junior engineer rotation |
| L3 | Engineering fix: dev touches code (~5% of volume) | Dev team |

An issue can be **L1 severity P2** (common how-to question) or **L1 severity P0** (user can't log in, can't use platform at all — contact CS, but also page the dev on-call). The two axes are independent.

### 3.2 When to hire

Hire only when **both** of these are true:

1. **A specific constraint is blocking value creation.** "Shipping is delayed because I'm doing manual customer onboarding" is a constraint. "We should probably have a PM" is not.
2. **The cost of the constraint exceeds the cost of the hire.** Fully-loaded cost of a ₹60K/month hire is ~₹75-85K/month (salary + laptop + tools + SaaS seats + overhead). If the constraint doesn't cost you at least that much in revenue or opportunity, don't hire.

### 3.3 Interns vs full-time

| Dimension | Intern | Full-time |
|---|---|---|
| Stipend / Salary | ₹8-15K/month | ₹25K-2L/month |
| Commitment | 3-6 months | Indefinite |
| Risk | Low (short contracts) | High (firing cost + emotional) |
| Upside | Pattern-match to FT hire | Full productivity after ramp |
| Best for | Bounded, well-defined tasks | Ownership-requiring roles |

**Always hire an intern first, convert to FT only after demonstrated performance.** 3-month paid trials with explicit success metrics.

---

## 4. Phased hiring plan

### Phase 0 — Pre-launch → first 5 paying customers

**Trigger to enter Phase 0:** today.
**Trigger to exit Phase 0:** 5+ paying customers + retention signal (2+ months of continued use).
**Target burn:** ≤ ₹60K/month.

**Team:**

| Role | Count | Type | Compensation | Responsibility |
|---|---|---|---|---|
| CEO / Product / Tech lead | 1 | Founder | Equity | Everything strategic + product + closing first customers |
| Full-stack dev | 1 | FT | ₹15-25K + performance | Feature dev, bug fixes |
| Sales (outbound) | 1 | Commission | ₹200-300 per conversion | Close hand-picked creators |
| CA (compliance) | — | Retainer | ₹5-8K/month | GST / ITR / Sole Prop filings |
| Customer success intern | 1 | 3-6 mo paid | ₹10-12K/month | L1 support, onboarding calls, FAQ, customer interview notes |
| Marketing / content intern | 1 | 3-6 mo paid | ₹10-12K/month | SEO blogs, social, competitor teardowns, community |

**DO NOT HIRE IN PHASE 0:**

- More developers — 2 devs shipping is enough pre-launch. More devs = merge conflicts + coordination cost, not more throughput.
- Dedicated QA/tester — devs write tests; CEO does manual QA on release candidates.
- Designer FT — use Figma community + Fiverr for ₹3-8K per piece.
- Finance FT — CA retainer + Zoho Books (₹500/month) handles everything under ₹50L revenue.
- Growth / PM / DevOps specialists — premature.

**Milestones that unlock Phase 1:**

- 5 paying customers.
- At least 2 months of retention (not just sign-ups).
- Clear signal that the product solves a real problem (NPS > 30, or qualitative evidence of retention).
- Runway of at least 12 months at Phase 1 burn.

### Phase 1 — First 10-20 paying customers (months 3-5 post-launch)

**Trigger to enter Phase 1:** 5 paying customers + retention + runway.
**Trigger to exit Phase 1:** ₹1L+ MRR + 20+ active customers.
**Target burn:** ₹2.0-2.5L/month.

**Hire in this order, one at a time, only after the previous hire is producing signal:**

| Order | Role | Type | Salary | Why now |
|---|---|---|---|---|
| 1 | CS Lead | FT | ₹35-50K | Interns churn; need an owner for onboarding + L1/L2 + churn playbook + NPS |
| 2 | Junior dev | FT | ₹40-60K | Bug fixes + minor features; lets Shubham + CEO focus on the roadmap |
| 3 | Content marketer | FT | ₹30-45K | Paid acquisition won't scale until you have organic proof (SEO + case studies) |

**Remaining interns in Phase 1:** rotate 1 CS intern (reporting to CS Lead) + 1 marketing intern (reporting to content marketer) for ongoing junior throughput.

**STILL DO NOT HIRE in Phase 1:**

- Senior dev / CTO-level hire — wait until product is differentiated enough that the role is definable.
- FT designer — use contract designer at ₹25-40K/piece.
- DevOps / SRE — Netlify + Supabase + Upstash handle scale.
- HR / Chief of Staff / Growth Lead — premature titles.

### Phase 2 — Growth (₹3-5L MRR, months 6-12)

**Trigger to enter Phase 2:** ₹3-5L MRR sustained 2+ months + first enterprise customer in pipeline.
**Target burn:** ₹4-6L/month.

| Role | Type | Salary | When to hire |
|---|---|---|---|
| Senior full-stack dev / tech co-founder | FT + equity | ₹1-1.5L cash + 0.5-2% equity | Only if you find someone materially better than you at something specific. Don't dilute for a generic hire. |
| Designer | FT ₹40-60K or contract ₹25-50K/piece | When customer research says UX is the blocker, not features |
| Growth marketer (paid channels) | FT | ₹60-90K | When paid channels are showing early signal (CAC < 0.5 × LTV) |
| Product manager | FT | ₹80K-1.2L | Only if 3+ devs + conflicting customer feature asks you can't resolve yourself |
| Enterprise account manager (if B2B traction) | FT | ₹80K-1.2L base + commission | Only after 3+ enterprise customers paying ≥ ₹1L/month |

### Phase 3 — Scale (₹10L+ MRR, month 12+)

Out of scope for this document. Revisit when you actually hit this stage — the economics change dramatically at ~₹8.5L revenue due to the Stream.io cost cliff (Maker account → paid tier, ~₹36K/month jump — ref: `docs/stream/00-pricing-overview.md`).

---

## 5. Role definitions

Each role below has explicit scope, success metrics, and the constraint that unlocks the hire.

### 5.1 Customer Success intern (Phase 0)

**Stipend:** ₹10-12K/month, 3-month paid trial, conversion possible to FT CS Lead.
**Hours:** 25-30 hours/week; flexible for student / recent graduate.
**Reports to:** CEO (until CS Lead is hired).

**Responsibilities:**

- Onboard each new paying customer via a 30-minute Zoom call (mandatory for first 20 customers).
- Handle L1 support: inbound email / WhatsApp / Intercom chat. Target: first-response within 4 business hours.
- Maintain FAQ + canned-response library. Tag every ticket with a category.
- Write post-mortem notes on the first 50 customer interactions: what confused them? What did they praise? What made them almost leave?
- Weekly tag-cluster report to CEO: top-5 ticket categories this week, with suggestions.

**Success metrics (90-day trial):**

- 100% of new paying customers get an onboarding call.
- NPS tracked from week 2; running average > 35 by end of trial.
- Tag-coverage > 80% (tickets without a category = failure).
- First-response time p50 < 4 business hours.

**What they do NOT do:**

- Write code.
- Close sales.
- Own product decisions.

### 5.2 Marketing / content intern (Phase 0)

**Stipend:** ₹10-12K/month, 3-month paid trial.
**Reports to:** CEO.

**Responsibilities:**

- 2 SEO blog posts per week (minimum 1500 words, competitor keyword research driven).
- 1 competitor teardown post per month (public-ready, published).
- Daily social content: 3 LinkedIn posts per week + 5 Twitter posts per week.
- Weekly engagement report: impressions, clicks, sign-ups attributable.
- Own community channel (Discord / Telegram / WhatsApp community) for beta creators.

**Success metrics (90-day trial):**

- 24+ SEO blog posts published.
- Organic traffic from 0 → > 5K monthly visits by end of trial.
- Community > 100 active members.
- At least 3 pieces of content with > 5K organic reach.

### 5.3 CS Lead (Phase 1)

**Salary:** ₹35-50K/month. Convert from best-performing CS intern if possible.
**Reports to:** CEO.

**Responsibilities:**

- Own onboarding of all paying customers.
- Own L1 + L2 support: can triage, reproduce bugs, write clean repros for devs.
- Build + maintain the Intercom / Crisp setup; own canned-response library.
- Weekly churn review with CEO — who canceled, why, what would have saved them.
- Monthly NPS survey + reporting.
- Train and manage the CS intern.

**Success metrics:**

- First-response p50 < 2 business hours.
- NPS > 40.
- Churn < 5% monthly (logo churn) after month 3.
- Bug repros submitted to dev team are actionable (dev doesn't bounce them back for missing info).

### 5.4 Junior dev (Phase 1)

**Salary:** ₹40-60K/month.
**Reports to:** CEO (or senior dev once hired).

**Responsibilities:**

- Bug fixes + minor features under guidance.
- Pair-program with Shubham on harder features.
- Write tests for every shipped feature (minimum: 1 unit test + 1 integration test per feature).
- Rotate through L3 support (investigate + fix code-level issues from L2 escalations).

**Success metrics:**

- 2+ PRs merged per week with passing CI.
- Zero P0 regressions attributable to their commits.
- Test coverage on their commits > 70%.

### 5.5 Content marketer (Phase 1)

**Salary:** ₹30-45K/month.
**Reports to:** CEO.

**Responsibilities:**

- SEO strategy + editorial calendar (content marketing intern reports to them).
- Case study production — 1 per month, featuring a real paying creator.
- YouTube / Instagram / LinkedIn organic growth.
- Email newsletter — weekly, with open-rate benchmarks > 25%.

**Success metrics:**

- Organic traffic 5K → 50K monthly sessions within 6 months.
- At least 3 blog posts ranking on page 1 of Google for target keywords.
- 20%+ of new sign-ups attributable to content (tracked via UTM).

### 5.6 Senior dev (Phase 2)

**Salary:** ₹1-1.5L cash + 0.5-2% equity.
**Reports to:** CEO.

**Responsibilities:**

- Architecture ownership of a defined surface (e.g. payments infrastructure, or Stream integration).
- Code review for all major PRs.
- Mentor junior dev.
- On-call rotation (CEO + senior dev share P0 paging).

**Success metrics:**

- Quarterly architecture review with zero critical tech debt accumulated.
- Junior dev's output quality improves.
- P0 incident count trending down.

**When to hire:** only when you find someone materially better than you at a specific axis (security, performance, DevOps, specific domain). Do NOT dilute for a generic hire.

---

## 6. Support tier staffing model

As MAU grows, support volume grows roughly linearly. Rule of thumb: **~1% of monthly active users file a support ticket per month**. Staff accordingly:

| Stage | MAU | Tickets/month | L1 owner | L2 owner | L3 owner |
|---|---|---|---|---|---|
| Pre-launch | 0-100 | 0-10 | CEO | CEO | CEO |
| Post-launch early | 100-500 | 20-50 | CS intern | CS intern + Shubham | Shubham |
| Post-launch growth | 500-2,000 | 50-200 | CS Lead + intern | CS Lead | Dev team rotation |
| Scale | 2,000+ | 200-500+ | CS team (2-3) | CS Lead + support engineer | Dev team rotation |

**Tooling guidance:**

- 0-50 tickets/month: Gmail shared inbox + labels. Don't over-engineer.
- 50-200 tickets/month: Crisp (starter plan ~₹2-3K/month) or Intercom (starter ~₹5-8K/month).
- 200+ tickets/month: Intercom or Zendesk, with escalation rules, SLA timers, CSAT surveys.

**P0 escalation path:** PagerDuty free tier. CEO + on-call dev paged within 5 minutes of P0 trigger (payment stuck, platform down, data loss). Document the runbook in `docs/enterprise/23-runbooks.md`.

---

## 7. Key risks + mitigations

### 7.1 Shubham retention risk (SEVERE)

**Current state:** Shubham is on ₹10K base + ₹5K performance bonus (per memory). This is below tier-2 / fresher software engineer market rates (₹30-40K/month). The moment a recognizable startup or Flipkart-style company offers him ₹40K, you lose him. Losing the sole full-stack dev is an existential risk.

**Mitigations (pick one):**

- **Equity offer:** 0.25-1% founder-equivalent equity vesting over 4 years with a 1-year cliff. Formalize in a Sole Prop → Pvt Ltd conversion plan (required for clean equity).
- **Cash raise:** ₹25-35K/month base + retain performance bonus. Closes the market gap.
- **Both (best):** ₹25K base + ₹5-10K performance + 0.5% equity.

**Action:** Have this conversation with Shubham within 30 days. Document outcome.

### 7.2 Founder burnout

**Current state:** CEO is doing product + engineering + sales + fundraising + customer success + hiring.

**Mitigation:** Phase 0 intern hires are primarily to offload CS + content from the CEO. If after 60 days you still don't have time to close sales or ship features, that's the signal that interns aren't enough — but more likely it's a prioritization problem, not a headcount problem.

**Self-check every Friday:** did I ship code or close a customer this week? If neither for 2 weeks running, something is wrong.

### 7.3 Hiring under pressure

**Risk:** a crisis (bug, churn spike, fundraising delay) creates pressure to hire without discipline.

**Mitigation:** every hire must pass the two-gate test (Section 3.2) before a JD is even written. Keep this document updated; refer to it before any offer.

### 7.4 Wrong first FT hire

**Risk:** you hire a CS Lead when what you actually need is a junior dev, or vice versa. The wrong first FT hire sets a bad cultural tone + consumes ~3-6 months before you realize.

**Mitigation:** always convert from intern to FT when possible (you have 3 months of performance data). Never hire an FT "cold" in Phase 1 without at least 3 reference calls + a paid 2-week trial project.

---

## 8. Roles NOT to hire (ever, or for a long time)

| Role | Reason to skip |
|---|---|
| Chief of Staff | Pure vanity for pre-Series-A companies. Do the operations yourself. |
| VP of Growth / Head of Growth | Premature title. Hire a content marketer + growth marketer instead. |
| HR Manager | Not until 15-20 employees. Use Razorpay Payroll + automation. |
| Legal counsel (FT) | Retainer with a startup lawyer (₹15-25K/month) until contracts get gnarly. |
| DevOps / SRE engineer | Your devs + Netlify + Supabase handle it until 10K+ MAU. |
| Dedicated QA / tester | Dev team writes tests. Contract QA for launch blitz if needed. |
| Full-time CFO / finance | CA on retainer + Zoho Books up to ₹50L revenue. FT CFO only at 8-figure revenue. |
| "CTO" for hire | If you're the tech lead, don't dilute for a title. Hire a senior dev instead. |

---

## 9. Salary benchmarks (India, 2026)

Updated from recent hiring data + conversations with peer founders. Adjust ±20% for Bengaluru / Mumbai product companies vs tier-2 city remote.

| Role | Fresher (0-1 yr) | Junior (1-2 yr) | Mid (3-5 yr) | Senior (5+ yr) |
|---|---|---|---|---|
| Software dev | ₹30-40K | ₹40-70K | ₹80K-1.5L | ₹1.5-3L |
| Customer success | ₹20-30K | ₹30-50K | ₹50-80K | ₹80K-1.5L |
| Content marketer | ₹25-35K | ₹35-55K | ₹55-90K | ₹90K-1.5L |
| Designer (UI/UX) | ₹25-40K | ₹40-65K | ₹65K-1.2L | ₹1.2-2.5L |
| Sales (base only) | ₹25-35K | ₹35-55K | ₹55-90K | ₹90K-1.8L |
| Product manager | — | ₹60-80K | ₹80K-1.2L | ₹1.5-3L |
| Intern stipend | ₹8-15K | — | — | — |

Commission adders (for sales roles): typically 5-15% of net revenue closed. Shelu's ₹200-300/conversion is fine for MVP; formalize to 5-10% of GMV once he closes > 10 customers.

---

## 10. Hiring criteria checklist (use before writing any JD)

Before any hire — intern or FT — answer these four questions in writing:

1. **What constraint is this hire removing?** (Specific. "Too many support tickets for me to handle alongside shipping" is specific. "We need a CS person" is not.)
2. **How will we know this hire is working?** (3-5 measurable success metrics, reviewable at 30/60/90 days.)
3. **What happens if this hire doesn't work?** (Firing plan. For interns, end of contract. For FT, documented 30-day PIP.)
4. **Can we afford this hire for 12 months even if revenue stays flat?** (If no, don't hire.)

If you can't answer any of the four, don't open the requisition.

---

## 11. 60-day action list

Concrete, week-by-week:

### Week 1-2

- [ ] Write down the Shubham retention decision (cash / equity / both) and have the conversation.
- [ ] Retainer a CA (₹5-8K/month). Shortlist: 3 local firms, pick one with SaaS experience.
- [ ] Write intern JDs + success metrics for CS + marketing.
- [ ] Set up Gmail + Linear + Intercom (or Crisp) before any intern starts.

### Week 3-4

- [ ] Post intern roles on Internshala, LinkedIn, Superset.
- [ ] Pre-screen with a 15-min phone call + a paid micro-task (1 hour, ₹500-1000 honorarium) before formal offer.
- [ ] Aim to hire 1 CS intern + 1 marketing intern within 3 weeks of posting.

### Week 5-8

- [ ] Onboard interns on Day 1 with written scope, success metrics, and weekly check-in cadence.
- [ ] CEO: 30-min weekly 1:1 with each intern.
- [ ] By end of month 2, tag-cluster report from CS intern should be actionable product input.

### Week 9-12

- [ ] Month-3 review on both interns. Performance-based decision: extend, convert to FT, or end contract.
- [ ] If conversion: draft FT offer letters with ₹35-50K (CS Lead) or ₹30-45K (content marketer).

**DO NOT during these 60 days:**

- Post any FT role (other than conversion offers).
- Hire a designer, dev, QA, finance person, or PM.
- Engage recruiters.

---

## 12. Review cadence

This document is **living**. Treat it as the source of truth for hiring decisions.

- **Weekly (Fridays, 30 min):** CEO self-review against hiring criteria checklist. Did any Phase 1 trigger activate?
- **Monthly (last Friday of month):** CEO + any senior hires review the Phase transitions. Adjust trigger thresholds if reality has moved.
- **Quarterly:** rewrite salary benchmarks using latest hiring data + peer-founder conversations.

**Escalate for discussion if:**

- A Phase trigger activates earlier than expected (good problem — may need to pull forward a hire).
- Runway drops below 9 months (bad problem — freeze Phase 2 hires).
- A key-person risk materializes (Shubham resigns, CEO burns out).

---

## 13. Appendix — sources + related docs

- `docs/stream/00-pricing-overview.md` — Stream cost baseline + cliff detail.
- `docs/finances/09-pricing-strategy.md` — full cost model and competitive pricing.
- `docs/finances/03-pricing-calculator.md` — commission tiers + creator savings vs Topmate.
- `docs/competition/04-pricing-strategy.md` — competitive positioning.
- `docs/competition/01-threat-matrix.md` — competitor ranking + threat levels.
- Memory: `project_deployment_target.md`, `feedback_pause_before_commit.md` (workflow preferences).
- External: [Topmate pricing page](https://topmate.io/pricing), [Stream.io Maker Account](https://getstream.io/blog/maker-account/), [Preplaced pricing](https://www.preplaced.in/blog/preplaced-mentorship-fees).

---

_End of document. Next review: 2026-05-22._
