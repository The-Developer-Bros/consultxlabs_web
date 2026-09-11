# What the Availability Grid Costs (#1319 PR 9)

> Status: **measured, 2026-09-02**, against the shared Supabase instance
> (`pzmbxqdgibfkhjwzeprf`, `ap-south-1`) from a developer laptop. Every number
> below came from `EXPLAIN (ANALYZE, BUFFERS)` and from Prisma's own query
> event log; nothing here is an estimate unless it says so.

`GET /api/slots/availability-with-allocation/[consultantId]` is the busiest
read in the booking subsystem, because ADR 16 decided that slot freshness is
polled rather than pushed. Every calendar that is open anywhere in the product
re-asks this endpoint once every sixty seconds
(`lib/scheduling/availabilityPolling.ts`), and the overwhelming majority of
those polls get back exactly the answer the client already had. This page
records what one poll actually costs, so that the conditional GET added in the
same pull request can be judged against a number rather than an intuition.

## How the endpoint spends a poll

The route does its work in phases. The authorization gates run first and are
skipped entirely on the public path. Then it reads the consultant's profile
together with the weekly and custom availability rows, and then it asks the
occupancy question — one `appointment.findMany` carrying
`buildConsultantOccupancyWhere`, which is a five-arm `OR` across consultation,
subscription, webinar, class and trial, intersected with a slot-participation
arm. The consultant Allocate-Slots calendar asks the same question with a much
richer `include` so it can render tooltips.

The table below reports each phase as Prisma executes it. "Statements" is the
number of SQL statements Prisma sends for that phase, which is the figure that
matters most in production: `PG_POOL_MAX=1` on Netlify serialises every Prisma
read onto one connection, so statements are round trips and round trips are
latency. "Wall" is the median of five runs after the connection was warm.

| Phase                                            | Statements | Wall (median) | Notes                                                         |
| ------------------------------------------------ | ---------- | ------------- | ------------------------------------------------------------- |
| Org-admin membership gate (detail path only)     | 1          | 33 ms         | Skipped on the public path and for the owning consultant.     |
| Profile + weekly + custom availability read      | 3          | 59 ms         | Prisma splits the two relations into their own statements.    |
| Occupancy, public path (`appointment.findMany`)  | 5          | 80 ms         | The grid a consultee or a trial browser sees.                 |
| Occupancy, detail path (tooltips + participants) | 15         | 145 ms        | The consultant Allocate-Slots calendar.                       |
| **Total, public poll**                           | **8**      | **~140 ms**   | Anonymous browsing; no session read at all.                   |
| **Total, detail poll**                           | **18**     | **~205 ms**   | Plus the membership gate when an org admin is allocating.     |
| New change-marker read (this PR)                 | 1          | 32 ms         | One statement, and 32 ms is essentially the round-trip floor. |

Passing `consulteeUserId` — which the allocate surfaces do, so the grid and
the allocator agree on what is free for both parties — adds a second
`appointment.findMany` and about five more statements on top of the totals
above.

## The plan of the occupancy query

Prisma compiles the occupancy filter into a single `SELECT` over `Appointment`
with fifteen `LEFT JOIN`s: the five event tables, their four plan tables, and
then the same five tables a second time for the plan-ownership arm. Two
`EXPLAIN (ANALYZE, BUFFERS)` runs against the busiest consultant in the
database (73 slot rows, 45 distinct appointments) gave this:

| Measure                      | Run 1   | Run 2  |
| ---------------------------- | ------- | ------ |
| Planning time                | 19.6 ms | 8.9 ms |
| Execution time               | 9.0 ms  | 7.6 ms |
| Buffers read while planning  | 2263    | 195    |
| Buffers read while executing | 347     | 347    |
| Sequential scans in the plan | 17      | 17     |
| Rows returned                | 0       | 0      |

The striking part is that planning costs more than execution, and that the
query costs the same whether it returns rows or not. Postgres seq-scans
`Appointment` (1,091 rows), both copies of each event table and every plan
table, because at this data size a scan genuinely is cheaper than an index
probe. The consultant-selective work — the slot participation arm — is the one
part that does use an index (`_SlotOfAppointmentToUser_B_index`, then a hash
semi-join). In other words, the endpoint pays a fixed cost per poll that is
almost independent of how busy the consultant is, and that fixed cost is a
whole-table read of the booking core.

## What a minute of polling costs

One open calendar issues one poll per minute. On the public path that is 8
statements and roughly 140 ms of function time per calendar per minute; on the
consultant's Allocate-Slots page it is 18 statements and roughly 205 ms. For
N open calendars the arithmetic is linear, because there is no shared cache in
front of the route — the `Cache-Control` is `private`, since the same URL
answers differently by session.

| Open calendars | Statements per minute (public) | Statements per minute (detail) | With conditional GET |
| -------------- | ------------------------------ | ------------------------------ | -------------------- |
| 1              | 8                              | 18                             | 1                    |
| 10             | 80                             | 180                            | 10                   |
| 50             | 400                            | 900                            | 50                   |
| 200            | 1,600                          | 3,600                          | 200                  |

The response body is worth counting too. A generated grid costs a measured 405
bytes per thirty-minute cell; the consultant in the database with the most
weekly availability rows (26) produces 62 cells and a 25 KB body for a one-week
window, and the month view is roughly four times that. Every one of those bytes
is currently serialized, sent and re-parsed on a poll that changed nothing.

## The change marker

The conditional GET added in this pull request answers "has anything this
response depends on changed?" in a single statement before any of the work
above happens, and returns `304 Not Modified` when the answer is no. The marker
lives in `lib/scheduling/availabilityGridMarker.ts` and is deliberately one raw
`SELECT` rather than ten Prisma aggregates: cost here is round trips, and ten
aggregates would be ten round trips, which is slower than the query the marker
exists to skip. Its measured plan is 3.4–5.5 ms of planning and 3.3–4.7 ms of
execution, with 21–24 index scans against 4–7 sequential scans, and 32 ms of
wall time end to end — which is the network round trip and almost nothing else.

The marker is the tuple of seven values, hashed together with the request
parameters into a strong ETag:

1. `ConsultantProfile.updatedAt`, which covers `scheduleType` flipping between
   weekly and custom, and which doubles as the existence check that keeps the
   route's 404 reachable.
2. The maximum `updatedAt` across the consultant's `SlotOfAvailabilityWeekly`
   and `SlotOfAvailabilityCustom` rows, which covers every availability edit,
   including the coalescing that #1323 does on save, together with the count
   of those rows. The count is what catches a deletion: removing an older row
   leaves the maximum timestamp untouched, and without the count the grid
   would answer 304 for a calendar that just lost a window.
3. The maximum `SlotOfAppointment.updatedAt` over the appointments that reach
   this consultant. Reachability is the union of the denormalized
   `consultantProfileId` (#440), the `user` edge to the consultant, and — when
   the request names one — the `user` edge to the consultee. The allocator
   stamps both keys on every slot it writes, so this set is the same set the
   occupancy query paints from.
4. The maximum `updatedAt` over the parent request rows of those same
   appointments, plus the request rows belonging to the consultant's own plans.
   This is what catches a status flip that starts or stops occupying a cell
   without rewriting the slot.
5. The maximum `Payment.updatedAt` over those same appointments, so a capture
   that flips a payment without rewriting the slot or the request still moves
   the tag.
6. The earliest still-future `Payment.expiresAt` among `PENDING` payments on
   those appointments. This is the clock fold, and it is the only entry that
   is not a row version.

### Why the clock fold works

A payment hold lapsing is the one input that changes the answer without
changing a row: `isOccupiedByLiveAppointment` compares `expiresAt` against
`now`, so a slot can free itself while the database sits still. Carrying the
raw earliest deadline in the ETag would not help, because that value does not
change when the clock passes it. Carrying the earliest deadline **that is still
in the future** does: the moment `now()` crosses it, that row falls out of the
subquery, the minimum moves to the next hold or to null, and the ETag changes.

### What the marker does not cover

Two things, both deliberate, and both in the safe direction.

The marker is conservative rather than exact. It is scoped to a consultant, not
to the requested window, so an edit to a booking six months away invalidates
this week's grid. That costs one unnecessary recompute; it can never serve a
stale 304.

Authorization is not in the marker at all, and does not need to be. The route
computes the ETag **after** its permission gates, so a caller who has lost org
admin or consultant ownership is refused up there and never reaches the
conditional branch. The gates' own resolved outcome — whether appointment
details are included, and which consultee id was accepted — is hashed into the
tag, so the two payload shapes for the same URL cannot collide.

### A defect found while measuring

Both occupancy branches select `payment: { select: { expiresAt: true } }`, but
`isOccupiedByLiveAppointment` reads `p.paymentStatus`, and the public branch
also omits `consultation.bookingSource`. With those fields undefined the
`allPaymentsDead` test can never be true, so the route's expired-hold handling
is currently inert and the grid paints a lapsed hold as busy until the sweep
tidies it. This is a correctness bug, not a performance one, and it is left for
its own change. It means the clock fold described above is, today, defensive
rather than load-bearing — the ETag will change when a hold lapses even though
the current response would not have changed. That is over-invalidation, which
is the harmless direction.

## Indexes

No new index was added, and none was needed. The marker's plan shows every
consultant-scoped arm already served by an existing index:
`SlotOfAppointment_consultantProfileId_startsAt_endsAt_idx` for the
denormalized arm, `_SlotOfAppointmentToUser_B_index` for both participation
arms, the four `*Plan_consultantProfileId_idx` indexes for the plan-ownership
arms, `Payment_expiresAt_paymentStatus_idx` for the clock fold, and the primary
keys for the profile and the event rows. The sequential scans that remain are
on tables of 200 to 1,800 rows, where the planner is right to prefer a scan and
will switch on its own as those tables grow.

One index is worth revisiting later rather than now. Computing the maximum
`updatedAt` for a consultant's slots currently reads all of that consultant's
rows through the composite above — 73 rows, 0.06 ms, at today's scale. A
`@@index([consultantProfileId, updatedAt])` would turn that into a one-row
backward seek. It was not added because `SlotOfAppointment` is written on every
allocation, and paying a write-path cost for 0.06 ms of read is not a trade
worth making until a consultant's slot count is measured in thousands.

## A note on the data

The database this was measured against is seeded, not organic: 1,795
`SlotOfAppointment` rows, 1,091 appointments, 83 consultants, and no `PENDING`
payment with a future `expiresAt` anywhere. Most seeded slot rows also leave
the denormalized `consultantProfileId` null, which real allocations never do —
`SlotAllocationService` sets it on every slot it creates. The absolute
milliseconds are therefore a floor, and the plan shapes are what should be
trusted: the occupancy query's cost is structural (fifteen joins, whole-table
reads, planning heavier than execution) and will grow with the tables, while
the marker's cost is a single indexed probe per input and will not.

## What we did not do

We did not build the `ConsultantBusyInterval` read-model table (U8 in the
wave-5 plan) — a denormalized, pre-merged busy-interval projection that the
grid would read instead of recomputing occupancy from appointments. It is
deferred until the measurement says the query, rather than the payload and the
round trips, is the bottleneck under load. Today it plainly is not: the
occupancy query executes in under ten milliseconds and spends more time being
planned than run, while the cost that actually shows up is eight to eighteen
serialized round trips and a 25 KB body, both of which the conditional GET
removes outright. A read model would also introduce a second source of truth
for occupancy that must be kept in step with every booking write, which is
exactly the kind of machinery worth deferring until a load measurement demands
it. Revisit under #874 when capacity work provides one.
