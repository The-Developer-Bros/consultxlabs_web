# Explore & Discovery — Overview

## Context

Public discovery: `/explore/experts` (cached consultant cards, filters, infinite scroll), `/explore/programs` (classes/webinars), enterprise org browse. Community page is marketing placeholder. Trials via `TrialBookingModal`. Marketplace visibility helpers in `lib/api/plans/visibility.ts`. Verified consultants only on public explore.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| Public search OR includes consultant email (PII) | ✅ FIXED-BY #987 |
| "top rated" filter misranks (rating denorm wrong) | ✅ FIXED-BY #987 (rating denorm fixed on create/update/delete) |
| Paid trial wiring partial — conversion funnel soft | ❌ OVERSTATED (`trialPriceInPaise` wired through checkout) |
| Prisma `contains` search weak at scale (no Algolia/Typesense) | 🟡 LEGIT-DEFERRED |
| Community backend missing | 🟡 LEGIT-DEFERRED |
| Smart matching / badges roadmap only | 🟡 LEGIT-DEFERRED |
| `ENABLE_HOST_ORGS` gates affiliation badges | 🔵 by-design gate |

## Known gaps / bugs

- Prisma `contains` search — no Algolia/Typesense; weak at scale.
- Public search OR includes consultant **email** (PII).
- Community backend missing.
- Smart matching / badges roadmap only.
- `ENABLE_HOST_ORGS` gates affiliation badges — confusing when flag off.
- Paid trial wiring partial — conversion funnel soft.

## Unhappy paths & user psychology

- User filters “top rated” — rating denormalization wrong (see feedback pack) → misranked experts.
- Search by partial email finds people — privacy incident.
- Trial books last slot race — explore UI still shows available until refetch.
- Community CTA dead-ends — SEO bounce.

## Questions (handled?)

1. **When to add search infra?**  
   - A) At N consultants / QPS threshold  
   - B) Before launch  
   - C) Stay on Prisma  

   **Recommendation: A.** Stay on Prisma until a clear consultant/QPS threshold forces dedicated search — premature Algolia/Typesense is unused ops cost.  
   - Not B: search infra before launch delays PII and rating fixes that matter more  
   - Not C: “stay on Prisma forever” ignores eventual scale cliffs  

2. **Unverified consultants in org catalogs only?**  
   - A) Yes — public VERIFIED only (current leaning)  
   - B) Show with badge  
   - C) Hide entirely until verified  

   **Recommendation: A.** Keep public explore verified-only so marketplace trust stays intact while orgs can still surface their own roster.  
   - Not B: badges still pollute public rankings with unverified noise  
   - Not C: hiding everywhere breaks org catalog needs  

3. **Community: build or remove?**  
   - A) Remove placeholder  
   - B) Ship MVP feed  
   - C) Keep SEO shell  

   **Recommendation: A.** Remove the community placeholder now — a dead CTA hurts SEO and trust more than no page.  
   - Not B: shipping an MVP feed now dilutes focus from booking and explore quality  
   - Not C: an SEO shell that dead-ends still bounces users  

## High concurrency / multi-device

Read-heavy; cache OK if checkout revalidates. Multi-device browsing is fine; booking races belong to booking pack.

## Suggested directions

Strip email from public search immediately. Align rating integrity with explore sort. Decide community fate.
