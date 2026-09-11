# Host Agency Product Coverage

## Context

Host agencies (`canHost`) supply experts and catalog (consultations, subscriptions, webinars, classes), take a RateCard bps cut via `OrganizationEarnings`, and pay out through org payout batches. Public discovery: `/explore/enterprise/organisations/[orgSlug]`. EXPERT membership is org RBAC; marketplace `UserRole.CONSULTANT` is separate. Critical: **product surfaces can look complete while 3-way split is silently disabled** when `ENABLE_HOST_ORGS` is false.

Key files: [`lib/payments/payouts/earnings-service.ts`](../../lib/payments/payouts/earnings-service.ts), [`lib/api/organizations/rate-card.ts`](../../lib/api/organizations/rate-card.ts), [`app/explore/enterprise/organisations/`](../../app/explore/enterprise/organisations/).

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| P0: flag-off → `resolveOrgSplit()` null → silent no-split | ✅ FIXED-BY #991 (honesty gate on host earnings data paths) |
| Wizard shows host checkbox; API rejects create | 🟡 LEGIT-DEFERRED (doc/UX drift — code is 400 HOST_ORGS_GATED) |
| Webinar/class `Appointment.organizationId` host-vs-sponsor confusion | 🟡 LEGIT-DEFERRED (reporting caveat) |
| `payoutRecipient=ORGANIZATION` + independent B2C allowed (ADR-18 leakage) | ✅ FIXED-BY #982 (exclusiveEngagement/allowlist enforced at checkout per ADR 18) |
| Explore affiliation badges confuse when host flag off + seed data | 🟡 LEGIT-DEFERRED |

## Product matrix (consult / sub / webinar / class)

| Product | B2C checkout | Org-sponsored checkout | Host org stamp | 3-way earnings (flag on) | Gaps |
|---------|--------------|------------------------|----------------|--------------------------|------|
| Consultation | Yes | Yes | Via membership / payment org | Yes | Multi-org EXPERT → oldest membership wins |
| Subscription | Yes | Yes; cap often at **allocation** | Yes | Yes | Partial reschedule noise (#448 booking) |
| Webinar | Yes | Yes | Often **plan.organizationId** (host) | Yes | Sponsor vs host org attribution confusion |
| Class | Yes | Yes | Similar to webinar | Yes | CRUD booking guards TOCTOU (booking pack) |

### Supporting surfaces

| Surface | Status |
|---------|--------|
| RateCard CRUD + immutable bump | Done |
| EXPERT invite / roster | Done (`canHost`); create-org still gated |
| Public catalog (4 plan types, visibility enum) | Done if `isPublic` + ACTIVE |
| Collaborator multi-party + org earnings (#773) | Largely done |
| Live org payout disbursement | Gated `ENABLE_LIVE_PAYOUTS` |
| Consultant picks earning org per booking | Stub — oldest EXPERT wins |
| Curated panel / exclusive B2C hide | Stub ADR-18 |

## Known gaps / bugs

- **P0 economics:** Flag-off → `resolveOrgSplit()` null → host agency believes they earn; platform books marketplace split only.
- Wizard shows host checkbox; API rejects create — bad UX / doc drift.
- Webinar/class `Appointment.organizationId` may be host plan org while sponsor funded — reporting must not assume one org id.
- `payoutRecipient=ORGANIZATION` + independent B2C still allowed (ADR-18) — internal experts can sell outside agency terms.
- Explore affiliation badges confuse when host flag off but seed data exists.

## Unhappy paths & multi-device psychology

- Agency owner configures RateCard on iPad; bookings on Friday produce no org earnings — discovers Monday via reconcile, not UI.
- Same consultant EXPERT in two host orgs; revenue always to older membership — second agency disputes.
- Learner books hosted webinar on phone with sponsor wallet; finance on laptop attributes cost to wrong org id in export.
- Collaborator expects host-end-call; only primary consultant can end (stream pack) — agency ops look broken.

## Questions (handled?)

1. **Sell host agencies before `ENABLE_HOST_ORGS`?**  
   - A) Never — flag required for any host commercial  
   - B) Soft launch with manual journal adjustments  
   - C) Allow dashboards only, disclose no live split  

> 🎯 Locked: sponsor-first — host commercial waits for flag-on split; do not sell host agencies before `ENABLE_HOST_ORGS`.

**Recommendation: A.** Do not commercially host until flag-on split is proven in staging with real RateCard snapshots.  
- Not B: Manual journals do not scale and destroy audit trust.  
- Not C: Dashboards without economics train the wrong mental model.

2. **Multi-org EXPERT revenue routing?**  
   - A) Keep oldest-membership heuristic  
   - B) Require per-booking org selection  
   - C) Block consultants from >1 EXPERT membership  

**Recommendation: B.** Per-booking org selection (or plan-owned org always) before multi-agency scale — heuristic will create disputes.  
- Not A: Deterministic wrong is still wrong for the second agency.  
- Not C: Over-restricts real multi-affiliation experts.

3. **Webinar/class org stamp — sponsor vs host?**  
   - A) Always host (plan owner) for catalog analytics; sponsor on Payment  
   - B) Always sponsor  
   - C) Dual fields required in every report  

**Recommendation: A.** Keep plan/host on appointment for catalog; payment carries sponsor — document dual ids in finance exports.  
- Not B: Loses host agency performance analytics.  
- Not C: Dual required everywhere without defaults slows every query; prefer clear column semantics.

## High concurrency / multi-device / spikes

Flash webinar for a host agency: last-seat Serializable + org wallet debit + RateCard snapshot must stay consistent. Multi-tab RateCard edits should bump immutable history (they do); concurrent EXPERT invites are safe via membership unique. Spike risk is **silent no-split** under flag-off, not deadlock.

## Suggested directions

1. Feature-flag check on host money dashboards (“earnings disabled”) when split null.  
2. Staging go-live: flag on → book all 4 products → assert OrganizationEarnings rows.  
3. Spec per-booking org selection before multi-agency GTM.
