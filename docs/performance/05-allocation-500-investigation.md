# Subscription auto-allocate — HTTP 500 / transaction-start timeout

## Summary

Submitting a subscription slot allocation (consultant → Requests → Allocate Slots → **Auto Allocate**) can fail with **HTTP 500** after ~**115 seconds**. The subscription stays `PENDING_ALLOCATION`, so the consultee never receives their sessions. The booking is paid for but cannot be fulfilled.

This is the functional failure mode of the performance problem in #907 — the allocation transaction cannot start because the connection pool is starved by the heavy `availability-with-allocation` computation running (repeatedly/concurrently) around it.

## Evidence (dev server log)

```
{"event":"lock_acquired","key":"auto-allocate:fbe6e6b7-3b85-4747-b37c-bfcdc914641b","attempts":1,"duration_ms":318,"ttl":148500}
{"event":"lock_released","key":"auto-allocate:fbe6e6b7-3b85-4747-b37c-bfcdc914641b","held_duration_ms":33245}
[Subscription Allocation] Failed after 35338ms: Transaction API error: Unable to start a transaction in the given time.
PATCH /api/bookings/subscriptions/cmqnxpyib0005sfyosp8e3ctr/allocate 500 in 115772ms
```

Client console also shows `429 (Too Many Requests)` (×4) from the calendar's duplicated wide availability requests immediately before.

## Endpoint

`PATCH /api/bookings/subscriptions/[subscriptionId]/allocate` (`app/api/bookings/subscriptions/[subscriptionId]/allocate/route.ts`).

## Reproduction

1. As a consultee, buy a 1-month "Basic Subscription" (4 sessions) with Mock Pay.
2. As that consultant: Requests → Allocate Slots. The calendar takes ~28s+ to load (see #907).
3. Click **Auto Allocate**. After ~30–115s the request returns 500; the dialog closes but the request is still **Pending** and no session appointments are created.

## Root cause

`"Transaction API error: Unable to start a transaction in the given time"` is Prisma failing to acquire a connection / begin the interactive transaction within its wait budget. Contributing factors:

- The allocation flow drives the **O(window) `availability-with-allocation`** computation over the full scheduling period (#907) — ~28s cold for 1 month. The allocation calendar fires it **twice concurrently** (React StrictMode in dev) and the lock is held ~33s.
- These long-running queries occupy the (remote Supabase) connection pool, so the allocation's transaction can't start in time → 500 after ~115s.
- Even absent dev StrictMode duplication, the single cold computation (~28–35s) exceeds typical limits; on Netlify (~26s function timeout) this allocation would simply time out in production.

## Impact

- **Subscription allocation can fail outright**, leaving paid subscriptions unfulfilled and stuck in `PENDING_ALLOCATION`. Longer subscriptions (6/12 months, wider windows) are at greater risk.
- This is a money-path correctness problem: payment captured, service not scheduled, no automatic recovery surfaced to the consultant (the dialog closed without a clear error).

## Recommended fixes

- Fix the underlying availability perf (#907): per-view fetching, kill per-slot `formatInTimeZone`, index appointment lookups, request de-dup/AbortController.
- Decouple the heavy availability read from the allocation **write transaction**: compute/validate the chosen slots first (outside the transaction), then run a short, focused transaction that only writes the appointment/slot rows.
- Increase Prisma transaction `maxWait`/`timeout` only as a stopgap; the real fix is reducing work inside/around the transaction and the pool contention.
- Surface a clear error toast on allocation failure (the dialog currently closes, masking the 500), and keep the request in Pending so it can be retried.

## Notes

Observed under dev (local app → remote Supabase) with some concurrent test traffic, which worsens pool contention. The transaction-start timeout and 115s duration are nonetheless reproducible and point to a genuine production risk. Booking/cross-side request creation are correct (the request appears for the consultant as Pending with 8 required slots); the failure is specifically in the allocation submission. Related: #907, and the dashboard list-query perf issue. Branch `fix/testsprite-infra`.
