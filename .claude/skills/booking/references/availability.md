---
name: booking-availability
description: How a consultant's published availability becomes bookable slots — weekly versus custom rows, the scheduleType discriminator, coalescing on save, the 30-minute atom, union coverage validation, the grid endpoint, the occupancy and dead-hold rules, and the three allocation modes with partial allocation and the collaborator guard. Load when working on availability rows, the booking calendar grid, slot generation, conflict detection, or anything under utils/slotAllocation/, utils/timeSlotsProcessing.ts, app/api/slots/, or the allocate routes.
---

# Booking Availability

Availability is stored as coarse rows, published through one of two mutually
exclusive modes, generated into 30-minute atoms for display, and validated back
against the union of those rows at write time. Most bugs here are a
disagreement between two of those four stages.

## 1. Weekly xor custom — the `scheduleType` discriminator

`ConsultantProfile.scheduleType` is a non-nullable `enum ScheduleType { WEEKLY,
CUSTOM }` with no default, so a consultant publishes in exactly one mode. Both
relations exist side by side, so rows from the dormant mode can persist from a
previous schedule — which is why every reader must gate on the discriminator
rather than unioning both tables.

`SlotOfAvailabilityWeekly` holds recurring rows as `startDay`/`endDay`
(`DayOfWeek`) plus `startTimeUtc`/`endTimeUtc` as minutes since midnight UTC
(0–1439), with `utcOffsetMinutes` as the live source of truth. `startDay` is the
**consultant's local** day (ADR B4): the UTC weekday is derived per row from
that frozen offset by `utcStartDayIndex`
(`utils/schedule/weekly-projection.ts`), and no surface may derive it from the
viewer's clock. `endDay` answers the narrower question of whether the row
crosses midnight **in UTC**, which is why an Asia/Kolkata 23:00–02:00 row is
stored as a single same-day row. The offset is never accepted from a request
body: `resolveWeeklyUtcOffsetMinutes` (`lib/scheduling/weeklyUtcOffset.ts`)
derives it from `User.timezone`, defaults to 330 when the profile carries no
usable zone, and answers a contradicting caller value with a 400 carrying
`code: "UTC_OFFSET_CONFLICT"`. Its `timezone`, `localStartMinutes`,
`localEndMinutes`, `localStartDay` and `localEndDay` columns are the DST-correct
representation; they are dual-written from 2026-09-05 by `weeklyRowLocalColumns`
on every write path and read by nothing until the #872 reader flip, so write
them only through that helper and carry them through any path that recreates
rows.
`SlotOfAvailabilityCustom` holds date-specific rows as `startsAt`/`endsAt` and
has no `isAvailable`, so a custom row is purely additive and can never express a
blackout. Both models gained a `deletedAt` tombstone in wave 5 (#1322, schema
hygiene), but no reader filters on it yet — availability rows are still removed
by a hard delete, so treat the column as frozen-in, not live.

## 2. Rows coalesce on save

As of wave 5 (#1323), `utils/slotAllocation/mergeAdjacentWeeklyRows.ts` folds
adjacent rows on every availability write, across all four write routes under
`app/api/slots/availability/` (`weekly`, `weekly/[id]`, `custom`,
`custom/[id]`). Each of those routes runs its overlap check, its write and the
coalescing pass inside **one** Serializable transaction under
`withSerializableRetry`, so the check-then-act window is closed and the row ids
the response returns are the post-merge ones. Despite the file name the module
covers both modes, and the two rules differ because the row shapes do.

Weekly rows merge only on exact adjacency and only when both are single-day,
share a `startDay`, are not overnight and carry the same `utcOffsetMinutes`;
overnight and cross-offset rows are left alone. `coalesceConsultantWeeklyRows`
deletes and recreates, so every weekly row id changes, and it recomputes the
five dual-written DST columns for the merged row rather than copying them —
a fold moves the row's end, and a row written before the dual-write has no zone
to recompute from and keeps its nulls.

Custom rows merge on adjacency **or overlap**, keeping the later `endsAt`, and
`coalesceConsultantCustomRows` preserves the surviving row's id, deleting only
the folded rows, because a booking names a custom row. That asymmetry is
load-bearing; do not "simplify" it.

Both folds stop at `MAX_DURATION_MINUTES` (`utils/timeSlotValidation.ts`, twelve
hours). A merge that would cross that bound starts a new row instead, because
`isValidTimeRange` rejects anything longer and the settings loader filters its
rows through that validator — a thirteen-hour merged row would vanish from the
form and the next save would delete it.

## 3. Checkout validates against the union of rows, atom by atom

Every slot is uniformly 30 minutes (ADR B1), but there is no single canonical
constant — the value is redeclared under at least six names, of which the
exported forms are `SLOT_DURATION_MS` (`lib/appointments/contiguous-slot-run.ts`)
and `THIRTY_MIN_MS` (`utils/timeSlotsProcessing.ts`). Do not add a seventh.

`utils/slotAllocation/availabilityCoverage.ts` is the write-time gate.
`windowAtoms(start, end)` chops the half-open window into atoms and
`findUncoveredAtom` returns the first atom that **no** row covers, so no single
row need cover the whole window — coverage is per-atom across the union.
`loadPublishedCoverage` makes "published" concrete: it reads `scheduleType` and
returns weekly rows only in WEEKLY mode and custom rows only in CUSTOM mode,
never querying the dormant arm, so a stale row from a previous schedule mode
cannot cover an atom no surface offers. It also **fails closed** on the profile
itself — a missing or soft-deleted `ConsultantProfile` returns
`{ scheduleType: null, weeklyRows: [], customRows: [] }`, so a deleted expert
publishes nothing whatever rows survived the deletion. As of wave 5 (#1323)
exactly two callers enforce this inside their transaction: checkout
(`lib/payments/operations/checkout.ts`), and the trial route
(`app/api/trials/[trialId]/route.ts`), which throws
`OutsideAvailabilityWindowError` even when the consultant is the one scheduling,
because a trial is a booking.

The display path matches: `mergeConsecutiveSlots` (`utils/timeSlotsProcessing.ts`)
joins free slots on **exact** adjacency — the merged end is the next start — and,
as of #1320, **across** availability rows, accumulating every covering id into
`slotOfAvailabilityIds`. Merging across rows was forbidden until union validation
replaced the single-row-id check, and the old ±60 s tolerance had to go with it:
rows ending 10:30 and starting 10:31 would otherwise be offered as one window
whose 10:30 atom no row publishes, which checkout's union coverage then rejects.

## 4. Generation and the grid endpoint

`SlotCalculationService` is a static date and duration utility, **not** the
generator. Generation happens in two places that must agree:
`processAvailabilitySlots` (`utils/timeSlotsProcessing.ts`) for the grid and the
private `SlotAllocationService.findAvailableSlots` for the allocator.

What makes them agree is that both project weekly rows through the same
generator, `weeklyRowOccurrencesInRange` (`utils/schedule/weekly-projection.ts`),
which walks the requested range in UTC and emits half-open `[start, end)`
occurrences on the row's derived UTC weekday, starting one day early so an
overnight row keeps the tail that falls inside the range. Checkout then
re-checks each atom through `isMinuteWithinWeeklySlot`, which derives the
weekday through the same helper — the invariant is that the grid offers only
atoms the validator accepts, pinned in
`__tests__/booking-algorithm/weekly-day-semantics.test.ts`. The grid used to
bucket rows on the **viewer's** weekday instead, so an overseas customer was
shown an IST pre-05:30 row a day away from the day checkout would accept
(#1342); if you touch either generator, keep them on the shared helper.

Segmentation and merging carry two more boundary rules. `splitSlotsByDay` cuts a
window at the next local day's midnight rather than at 23:59:59.999, because a
23:30–23:59:59.999 remainder is not a thirty-minute atom and a block published
up to local midnight otherwise lost its last slot (#1415). Both merge functions
— `mergeConsecutiveSlots` for booking and `mergeConsecutiveSlotsForDisplay`
(`app/explore/experts/[consultantId]/utils/mergeSlots.ts`) for the expert page —
require exact adjacency, and differ only in which atoms are eligible; a
tolerance on either side advertises a seam no row publishes (#1416).

The grid is `GET /api/slots/availability-with-allocation/[consultantId]` with
`startDateInUtc`, `endDateInUtc` and `timezone`, public in `middleware.ts`.
There is no polling interval on it and none should be added: ADR 16
(`docs/enterprise/70-design-decisions/16-slot-freshness-without-realtime.md`)
records freshness here as a user-experience concern met by a precise 409 toast,
per-query refetch on focus and invalidate-on-mutation.

## 5. Occupancy, and when a hold is dead

`utils/slotAllocation/occupancyPolicy.ts` answers "what blocks this slot".
`OCCUPIED_REQUEST_STATUSES` is `PENDING`, `APPROVED`, `APPROVED_PENDING_PAYMENT`
and `SCHEDULED`; `OCCUPIED_EVENT_STATUSES` is `SCHEDULED` and `IN_PROGRESS`;
trials occupy at `SCHEDULED` and `AWAITING_PAYMENT`, because a paid trial's slot
is reserved the moment the consultant accepts. `buildConsultantOccupancyWhere`
asks both questions the grid and allocator once asked separately: busy if
connected to a live slot **or** if the appointment runs under one of their
plans.

A hold that is no longer live must stop blocking, and the rule lives in two
places asserted to agree by `hold-expiry-predicate.test.ts`:
`isOccupiedByLiveAppointment` (`utils/slotAllocation/SlotValidationService.ts`)
is the JS predicate, and `buildDeadHoldFilter` (`occupancyPolicy.ts`) is its SQL
twin, added in wave 5 (#1328) for callers that select slots and so cannot run
the predicate — checkout's first step and the trial route.

A payment row is **dead** when the sweep marked it `EXPIRED`, the gateway marked
it `FAILED`, or it is still `PENDING` past its `expiresAt` — never by the clock
alone, because a `SUCCEEDED` row keeps its `expiresAt` and must never free the
slot it paid for. The hold is free only when _every_ payment row is dead and
there is at least one; in Prisma that needs `some: {}` alongside `every`, since
`every` is vacuously true on an appointment with no payments. Two shapes
qualify: an `APPROVED_PENDING_PAYMENT` request, and — new in wave 5 (#1328) — a
`PENDING` request whose `bookingSource` is `DIRECT_CHECKOUT`, which never sees a
consultant approval and so stayed blocked until the sweep caught up. A `PENDING`
`REQUEST_SUBMITTED` request waits on a human, not a payment, and always
occupies.

## 6. Allocation modes, partial allocation, and the collaborator guard

There is one endpoint per event type — `PATCH
/api/bookings/{consultations|subscriptions|webinars|classes}/[id]/allocate` —
and the mode comes from the body, not the URL: `useRequestedSlots` wins, else
`isAuto` (a required field), else manual, which needs a non-empty `slots` array
of ISO datetimes. `AllocationMode` is the union `"auto" | "manual" |
"requested"` in `utils/slotAllocation/types.ts`.

As of wave 5 (#1329), `allowPartial` lets the consultant say "place what fits
now, the rest later". It defaults to false, is honoured only for the event's
consultant or a privileged caller (`body.allowPartial === true && canOverride`),
reaches only the `auto` path, and applies only to recurring event types — a
consultation or webinar is one session, so it either fits or it does not. A
partial success returns `partial`, `placedSessions`, `requiredSessions` and
`unplacedSessions`; a refusal returns `SLOT_SHORTAGE` with `placeableSessions`
so the client can offer the partial option instead of a dead end. The consultee
learns of it through the Novu workflow `appointment-partially-scheduled`.

Also as of wave 5 (#1329), the co-host guard runs in **every** allocation mode:
`SlotAllocationService.assertCollaboratorsFree` calls
`assertCollaboratorsAvailableForWindows` (`lib/collaborators/availability.ts`)
from all three paths, short-circuits for anything that is not a webinar or
class, checks only `ACCEPTED` collaborators against live slots on a half-open
overlap, and throws `CollaboratorUnavailableError` → 409
`COLLABORATOR_UNAVAILABLE`. As of #1319 "live" means the shared occupancy
predicate rather than the tentative flag: the slot's appointment must be in an
occupying state and must not be a dead hold, so a co-host's live checkout hold
blocks an allocation even though its slot is still tentative. It was previously reachable from one route only, so
a class scheduled through the allocator could land on a time a co-host was
already busy (AE-2, #784).
