# DST & Timezone Posture (#872 stub — read before touching availability)

> Status: **IST-first launch, DST deliberately deferred** (#872). This page is
> the caveat sheet the audit asked for: what the stub does, what silently
> breaks, and the rules for any code that touches availability time math.

## What the launch model is

- `SlotOfAvailabilityWeekly` stores **minutes-since-midnight UTC**
  (`startTimeUtc`/`endTimeUtc`) plus a **frozen `utcOffsetMinutes`** captured
  at row creation. That frozen offset — NOT an IANA zone — is the live source
  of truth for projecting weekly rows onto concrete dates.
- The DST-correct representation (local wall-clock + IANA `timezone` +
  `localStartMinutes`/`localEndMinutes`/`localStartDay`/`localEndDay`) exists as
  nullable columns and is **dual-written from 2026-09-05 and read by nothing**.
  Every weekly write path fills the five columns from
  `weeklyRowLocalColumns` (`utils/schedule/weekly-projection.ts`), so the reader
  flip inherits correct values for every row written from that date onward
  without a backfill; going DST-aware still needs no migration, only the
  algorithm and UI work tracked in #872.
- Custom availability (`SlotOfAvailabilityCustom`) stores absolute UTC instants
  — unaffected by the stub.
- Event bucketing (`dayKey`/`weekKey`, ADR B9) uses each event's
  `schedulingTimezone` via date-fns-tz, which IS DST-correct for the zones it
  evaluates. The stub only affects **weekly availability projection**.

## The silent hazard

A consultant whose UTC offset changes after publishing availability (travels,
or their zone enters DST) gets future sessions materialized at the OLD offset:
a Mon 09:00 IST row becomes Mon 03:30 UTC forever, even after the consultant
is at UTC+1. Both parties then see consistent-but-wrong local labels, because
every surface renders in viewer-local time.

## Rules until #872 lands

1. Never READ the local\* columns from new code, and never write them by hand.
   They are dual-written for the #872 reader flip and nothing else consults
   them, so a reader added now would be a second source of truth against a
   frozen offset that is still the live one. Write them only by calling
   `weeklyRowLocalColumns`, and if you add a write path that creates or
   recreates weekly rows — `coalesceConsultantWeeklyRows` is the one that
   deletes and recreates — carry the five columns across, or the next coalesce
   silently unwrites them.
2. Any NEW consumer of weekly availability MUST go through the shared
   projection helpers — `utcStartDayIndex`, `weeklyRowDurationMinutes` and
   `weeklyRowOccurrencesInRange` in `utils/schedule/weekly-projection.ts`, or
   the `isMinuteWithinWeeklySlot` / `getNextOccurrenceWeekly` /
   `matchWeeklySlotToDay` wrappers that call them — so the frozen-offset
   semantics stay in one place. Deriving a weekday from the viewer's clock is
   the specific mistake this rule exists to stop (#1342).
3. Do not "fix" a +5:30 mismatch by editing offsets by hand — regenerate the
   consultant's availability rows instead. `utcOffsetMinutes` is never taken
   from a request body either: `resolveWeeklyUtcOffsetMinutes`
   (`lib/scheduling/weeklyUtcOffset.ts`) derives it from the consultant's
   `User.timezone`, falls back to 330 when the profile carries no usable zone,
   and answers a caller-supplied value that contradicts the profile with a 400
   carrying `code: "UTC_OFFSET_CONFLICT"` (#1326, #1348).
4. The drift warning asked for here now exists. Every weekly save whose
   consultant profile names a zone other than `Asia/Kolkata` reports one
   Sentry warning per write (never one per row), which is the signal that a
   consultant is publishing from outside the launch market and that the #872
   reader work has become due. `PIN_TO_LAUNCH_OFFSET` in the same module is the
   one-line switch that hard-pins every row to IST if that answer is ever
   preferred to the profile's own offset.

## Related

- Schema doc-comment block on `SlotOfAvailabilityWeekly` (prisma/schema.prisma)
- #1168 — draw the slot grid in `schedulingTimezone` (prerequisite for #872)
- #1200 — the travel-hazard operational caveat this page documents; folded into
  #872 as a single post-MVP DST issue (2026-09-02 decision, tracked under
  #1319)
