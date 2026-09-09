---
title: Slot freshness via server-authoritative conflicts and focused refetch, not Supabase Realtime
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-09-03
---

# ADR 16 — Slot freshness without Supabase Realtime

## Context

A consultee can have a booking surface open in several tabs or on several
devices, and a slot they are looking at can be taken, relinquished, or
rescheduled by someone else between the moment the page loads and the moment
they act. The recurring question is whether the platform needs Supabase
Realtime (Postgres change subscriptions) to keep the request tab, the event
planner, the heat map, and the settings views live.

## Decision

The platform does not adopt Supabase Realtime. Correctness here is already
server-authoritative and does not depend on the freshness of any screen: a
booking is serialized by the interval-atom locks minted in
`utils/appointmentlock.ts` (one `slot-booking:<consultantProfileId>:<atomStartISO>`
key per half-hour atom a request touches), the status CAS transitions in
`lib/booking/transitions.ts` (ADR 13), and the `slot_no_confirmed_overlap`
exclusion constraint (#440). A stale screen can therefore never cause a
double booking — the second writer loses cleanly with a 409, never with
corrupt data. Freshness is consequently a user-experience concern, not a
correctness one, and it is met with three in-architecture mechanisms rather
than a new subscription transport:

1. **A precise conflict experience.** A 409 from `/api/checkout` or the
   allocation routes (the `LOCK_CONTENTION` and `AVAILABILITY` error types) is
   routed through the shared error-toast map, so the loser sees "this slot was
   just taken — pick another time" instead of a generic failure. This applies
   on both the mock and the real-payment paths across every checkout page.
2. **A bounded poll instead of a push.** The availability grid polls every
   sixty seconds while the tab is visible (`lib/scheduling/availabilityPolling.ts`,
   #1164), and its route serves `Cache-Control: private, max-age=30` with
   deliberately no `stale-while-revalidate`, so a repaint is never more than
   one interval old. The consultant planner and the consultee events queries
   additionally refetch when their view regains focus, so switching back to a
   tab or device shows current state without waiting out the poll window.
   Reconnect refetch is already global; the global on-focus refetch stays off
   for the performance reasons recorded against the query client, so the
   refresh is scoped per query rather than applied to every mounted query.
3. **Invalidate on mutation.** A successful booking or allocation invalidates
   the affected slot and planner queries so a returning user sees the slot
   consumed, and the post-allocation refetch bypasses the HTTP cache
   (`lib/scheduling/allocationService.ts`) so the consultant who just booked
   sees it immediately rather than on the next poll tick.

## Why not Realtime

Supabase Realtime would deliver the lowest-latency updates, but it is the wrong
tool here. It introduces a second data path — the `supabase-js` client running
alongside the Prisma data layer the application otherwise uses exclusively —
and with it an RLS-policy surface the stack does not currently rely on. It is a
stateful, connection-oriented dependency whose fan-out and connection limits
become a cost centre precisely at the "hundreds of thousands of users" scale
the platform targets, and that statefulness runs against the serverless,
broker-free posture of ADR 13 and ADR 14. Because the 409 guard is required
regardless, Realtime would be pure polish layered on top of work that is
already done.

If telemetry later shows a genuine freshness gap that focused refetch cannot
close, the reconsidered step is narrow: a presence check on the checkout screen
that confirms a single selected slot is still free, not a global subscription
to a high-write slot table.
