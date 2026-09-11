# Booking — Overview

## Context

Familiarise books consultations, subscriptions, webinars, classes, and trials as 30-minute `SlotOfAppointment` atoms. Paid flows use tentative→confirmed via checkout/webhooks; request flows allocate after consultant approval. Defense in depth: Redis distributed locks, in-transaction revalidation, Postgres GiST exclusion for 1:1 confirmed overlaps, Serializable capacity recount for events.

Canonical engineering: `docs/booking/`, `utils/slotAllocation/`, `lib/payments/operations/checkout.ts`, race suite under `tests/typescript/race-conditions/`.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| `allocationIdempotencyKey` unwired | ✅ FIXED-BY #988 (#837) |
| No-show automation (#471) | ✅ FIXED-BY #992 (consultations; subscriptions remain a deferred TODO#471) |
| Partial subscription reschedule flips whole plan PENDING (#448) | ✅ FIXED-BY #988 (now scoped partial-vs-full) |
| DST deferred (#872) | 🔵 TRACKED #872 |
| Double-booking loser both pay, manual refund | ✅ FIXED-BY #990 |
| Reconcile detector SUCCEEDED-only scope | ✅ FIXED-BY #988 (`buildOccupiedAppointmentFilter`) |
| Lemon/XFlow appointment stubs | ✅ FIXED-BY #984 |
| Docs vs code drift on cancel auth (code stricter) | 🟡 doc drift (minor) |
| Enterprise dunning does not cascade to booking suspend | 🔵 TRACKED #779 |

## Known gaps / bugs

- Happy path is mature; residual gaps: unwired `allocationIdempotencyKey`, no-show automation (#471), partial subscription reschedule status bug (#448), DST deferred (#872), incomplete reconcile detector scope, Lemon/XFlow appointment stubs.
- Docs vs code drift on cancel auth (code is stricter).
- Enterprise dunning does not yet cascade to booking suspend (#779).

## Unhappy paths & user psychology

- Calendar showed green; at pay time slot is gone — “bait and switch” feeling if messaging is weak.
- Both parties pay for same 1:1; loser charged until refund — panic and chargebacks.
- Consultant juggles phone allocate while consultee reschedules on laptop — confusing PENDING states.

## Questions (handled?)

1. **Is Redis required for correctness or optimization?**  
   - A) Treat Redis as optimization; DB is law (true for 1:1 GiST)  
   - B) Fail closed without Redis for all paid booking  
   - C) Hybrid: events fail closed, 1:1 degrade  

**Recommendation: C.** Fail closed on events without Redis; let 1:1 continue with GiST as the confirmed-overlap backstop.
- Not A: Treating Redis as optional for webinars/classes risks unlocked capacity recount under seat contention.
- Not B: Failing all paid booking on a Redis blip over-blocks 1:1 when GiST already enforces no confirmed overlap.

> 🎯 Locked: rec C matches shipped behaviour — events fail closed without Redis, 1:1 continues on the GiST backstop.

2. **What is the product SLA for tentative slot holds (24h + 2h cron)?**  
   - A) Shorten hold to 30–60 minutes for paid checkout  
   - B) Keep 24h; improve early release UX  
   - C) Dynamic hold by plan type  

**Recommendation: A.** Short paid checkout holds (30–60 min) free abandoned seats faster and reduce double-pay pressure before flash campaigns.
- Not B: 24h tentatives make calendars look free while seats are ghost-held through campaigns.
- Not C: Dynamic holds add policy complexity before fixing known #448/#837/#827 gaps.

## High concurrency / multi-device

See sibling files. Same-user multi-device booking is partially serialized via `lockConsulteeBooking`. Cross-user same-slot races are the core design problem — largely handled, refund-of-loser still soft.

## Suggested directions

Verify loser-refund automation after `#827` blocks. Wire allocation idempotency before marketing flash events.
