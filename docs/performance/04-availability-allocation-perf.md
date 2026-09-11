# Availability-with-allocation — slow wide-window query

## Summary

The **subscription slot-allocation calendar** (consultant → Requests → "Allocate Slots") can hang on "Loading calendar…" for minutes and intermittently 429s. Root cause: `GET /api/slots/availability-with-allocation/[consultantId]` is **O(window width)** and very slow for wide date ranges, and the allocation flow requests the **entire subscription scheduling period** (1 / 6 / 12 months).

This is **production-impacting**: a cold 1-month query measured **~28s**, which exceeds Netlify's serverless function timeout (~26s). For 6- and 12-month subscriptions it is dramatically worse, so consultants would be **unable to allocate** and subscriptions would stay stuck in `PENDING_ALLOCATION`.

## Measurements (dev, local app → remote Supabase, warm-compiled route)

`GET /api/slots/availability-with-allocation/{id}?startDateInUtc=…&endDateInUtc=…&timezone=Asia/Calcutta`

| Window width | Time |
|---|---|
| 1 week | ~0.30 s |
| 2 weeks | ~0.34 s |
| 1 month (cold, single request) | **~28 s** |
| 1 month (× concurrent duplicate requests) | **~132 s**, with `429 Too Many Requests` |

Narrow windows are fine; cost explodes with width. The allocation dialog opened for a 1-month "Basic Subscription" (8 required slots = 4× 1-hour calls) and never finished loading the calendar while two identical month-wide requests were in flight.

## Reproduction

1. As a consultee, book a subscription (Mentorship tab on an expert profile) with Mock Pay. It lands as a pending request.
2. As that consultant, go to **Requests → Allocate Slots**.
3. The dialog shows "Loading calendar…" and hangs; console shows `429 (Too Many Requests)` (4×). Network shows duplicated, long-pending `availability-with-allocation` requests spanning the whole scheduling period.

## Root cause

`app/api/slots/availability-with-allocation/[consultantId]/route.ts` calls `processAvailabilitySlots()` (`utils/timeSlotsProcessing.ts`) over the full requested range. That pipeline:

- `processWeeklySlots()` iterates day-by-day across the whole window.
- `convertToSlotTimings()` runs `getSlotBookingStatus()` **per slot**, which is `O(appointments)` each.
- `breakDownSlotsByDuration()` generates 30-min sliding windows across the whole range.
- Every produced slot/window calls **`date-fns-tz` `formatInTimeZone()`** (and `toZonedTime`/`fromZonedTime`) — heavy `Intl.DateTimeFormat` work, executed tens of thousands of times for a month-wide window. This dominates the cold time (consistent with ~28s cold vs. fast when warm/cached).

Compounding factor: the allocation component fires the wide request **twice concurrently** (React StrictMode in dev). Two cold ~28s computations contend and push wall-clock to ~132s and trip the rate limiter. (Confirm whether prod also double-fires without an AbortController / request-dedup.)

## Impact

- **Netlify timeout (~26s) → subscription allocation breaks in production** for month-plus scheduling periods. 6/12-month subscriptions are effectively unallocatable.
- Even where it doesn't time out, multi-minute "Loading calendar…" is an unusable consultant experience and triggers 429s.

## Recommended fixes

- **Fetch per visible view, not the whole period.** The allocation calendar only renders one week/month at a time — request availability for the visible window and lazy-load as the consultant navigates, instead of the entire scheduling period up front.
- **Kill per-slot `formatInTimeZone`.** Compute the timezone offset once per window and derive local times arithmetically, or format lazily only for slots actually rendered. This is the single biggest win.
- **Make `getSlotBookingStatus` not O(appointments) per slot** — pre-index appointments by day/interval.
- **Add request de-duplication / `AbortController`** so the calendar can't fire two identical wide queries at once.
- **Cache** the computed availability keyed by `(consultantId, windowStart, windowEnd, timezone)` with short TTL; today repeats are fast only by luck of an in-process warm path.

## Notes

Found while validating the subscription allocation flow end-to-end. The booking/allocation *correctness* is fine (the request correctly appears for the consultant as Pending with 8 required slots); the problem is purely performance/scalability of the availability endpoint over wide windows. Related to the dashboard list-query perf issue. Environment: branch `fix/testsprite-infra`.
