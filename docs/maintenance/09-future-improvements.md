# Future Improvements

Recommended code changes to improve maintenance mode protection.

> **Already implemented**: BetterStack incident management (auto-create on OFFLINE, auto-resolve on end) is complete. See [Architecture](./01-architecture.md#betterstack-integration) and [BetterStack Setup Guide](./00-betterstack-setup.md).
>
> **Sprint 1 completed (Feb 2026)**: Items 1, 2, 3, and new items A, B below are **fully implemented**. The Implementation Priority table at the bottom reflects the updated status.
>
> **Sprint 2 completed (Feb 2026)**: Items 4, 5, C are **fully implemented**. Only item 6 (Scheduled Maintenance) remains as a future improvement.

## 1. DEGRADED Write-Blocking

**Problem**: DEGRADED mode currently allows all write operations (POST, PATCH, DELETE). Users can complete checkouts, create events, and modify data during DEGRADED mode.

**Proposed Change**: Add write-blocking logic to the middleware for DEGRADED mode. Block transactional routes while allowing reads.

**Files to Modify**:

- `middleware.ts` -- Add DEGRADED write-blocking check
- `lib/maintenance-edge.ts` -- Add helper function

**Implementation**:

```typescript
// lib/maintenance-edge.ts
const WRITE_BLOCKED_IN_DEGRADED = [
  "/api/checkout",
  "/api/appointments/*/cancel",
  "/api/appointments/*/reschedule",
  "/api/appointments/*/documents",
  "/api/bookings/consultations", // POST/PATCH only
  "/api/bookings/subscriptions", // POST only
  "/api/bookings/webinars", // POST only
  "/api/bookings/classes", // POST only
  "/api/bookings/*/allocate",
  "/api/trials", // POST only
  "/api/plans/*/materials", // POST only
];

export function isWriteBlockedInDegraded(
  pathname: string,
  method: string,
): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return false;
  }
  return WRITE_BLOCKED_IN_DEGRADED.some((pattern) =>
    matchRoute(pathname, pattern),
  );
}
```

**Effort**: 2-4 hours
**Priority**: HIGH -- Prevents the most common business risk scenario

---

## 2. Cron Job Maintenance Guard ✅ IMPLEMENTED (completed 2026-09-02)

**Problem**: All 27 cron jobs bypass middleware entirely. They connect directly to PostgreSQL and have no awareness of maintenance mode.

**Update (wave-5 sweep, `fix/maintenance-and-cron-coverage`)**: This item was marked done below on the strength of the original `lib/maintenance-cron.ts` utility, but the guard had not actually reached the whole fleet: 13 scheduled jobs, including six that move money or rewrite org entitlement state (`dunning`, `advance-program-cycles`, `auto-renew-contracts`, `expire-contracts`, `timeout-member-overages`, `release-pending-trust-earnings`, plus `wallet-low-balance`), never called `abortIfMaintenance()`. The wave-5 sweep added the call to all 13, added the six financial ones to `FINANCIAL_JOB_NAMES` so they also exit on DEGRADED, and flipped `auto-renew-contracts` and `expire-contracts` from fail-open to fail-closed locks. Review of the pull request found one more omission of the same kind, `irp-uploader`, which registers IRNs with the government portal: it joined the registry and went fail-closed too. Every job under `jobs/**` now calls the guard; the three that remain unguarded (`cleanup-empty-folders`, `cron-heartbeat`, `stream-webhook-drift`) are read-only or storage-only scripts with no database connection to protect, and are enumerated in [the cron jobs reference](./04-cron-jobs-reference.md#jobs-that-ignore-maintenance-mode).

The same sweep closed a second hole the guard never covered: the HTTP twins under `app/api/cleanup/*` import these job cores directly, so an authenticated ops trigger could run a job straight through an OFFLINE window with no check at all. `abortIfMaintenance()` cannot be reused there because its `process.exit(0)` would take the whole Next.js instance down with the request, so those routes now call `assertNotInMaintenance()`, which throws a `MaintenanceActiveError` the route handler answers with a 503 instead of exiting.

Finally, the DEGRADED write-block matcher from item 1 above was widened at the same time: it now matches by path prefix instead of exact segment equality, and covers the gaps that prefix matching exposed — the `/api/organizations/*` money routes, request-for-approval, availability writes, and reschedule respond/withdraw. The `/api/slots/appointments` pattern that used to appear in that list was removed as a no-op, since no route matches it.

**Where it lives now**: the guard is `abortIfMaintenance(jobName)` in `lib/maintenance-cron.ts` for the `jobs/**` entrypoints, and `assertNotInMaintenance(jobName)` for the HTTP twins that cannot call `process.exit(0)`. Both read the phase once through the same helper and reach a verdict through the same function, so they cannot drift. The per-job table, including which jobs are on `FINANCIAL_JOB_NAMES` and therefore also skip DEGRADED, is [the cron jobs reference](./04-cron-jobs-reference.md).

The original proposal that stood here — a twenty-line sketch, a 27-job scope and a 4-6 hour estimate — has been removed rather than kept as history, because it described a guard that blocked OFFLINE only and merely logged during DEGRADED. Anyone reading it as a specification would have reimplemented the hole this item exists to record.

---

## 3. Webhook DB Health Check

**Problem**: Webhook handlers are exempt from maintenance mode (correct), but they attempt DB writes that may fail during migration.

**Proposed Change**: Add a DB health check at the start of each webhook handler. If the DB is unhealthy, return 503 to trigger the gateway's retry mechanism.

**Files to Modify**:

- `app/api/webhooks/stripe/route.ts`
- `app/api/webhooks/razorpay/route.ts`

**Implementation**:

```typescript
// Add to each webhook handler before processing:
async function checkDbHealth(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

// In the handler:
const dbHealthy = await checkDbHealth();
if (!dbHealthy) {
  console.warn("DB unhealthy during webhook processing, returning 503");
  return NextResponse.json(
    { error: "Service temporarily unavailable" },
    { status: 503 },
  );
}
```

**Effort**: 2-3 hours
**Priority**: HIGH -- Prevents webhook handlers from writing to a migrating DB, leveraging gateway retry behavior

---

## 4. UI Maintenance Guard Hook ✅ IMPLEMENTED

**Problem**: During DEGRADED mode, the UI shows a banner but doesn't disable interactive elements. Users can still click "Book Now" or "Pay" buttons.

**Implemented**: Created `hooks/useMaintenanceGuard.ts` hook. Wired into all 4 checkout pages (consultation, subscription, webinar, class) to block `handleCheckout` and disable payment buttons during DEGRADED/OFFLINE mode. Shows toast with maintenance message on blocked attempts.

**Files to Create**:

- `hooks/useMaintenanceGuard.ts`

**Files to Modify**:

- Checkout button component
- Booking/scheduling components
- Event creation forms

**Implementation**:

```typescript
// hooks/useMaintenanceGuard.ts
import { useMaintenanceContext } from "@/providers/MaintenanceProvider";

export function useMaintenanceGuard() {
  const { phase } = useMaintenanceContext();

  return {
    isBlocked: phase === "DEGRADED" || phase === "OFFLINE",
    isDegraded: phase === "DEGRADED",
    isOffline: phase === "OFFLINE",
    blockReason:
      phase === "DEGRADED"
        ? "Bookings are temporarily paused during maintenance."
        : phase === "OFFLINE"
          ? "The platform is currently under maintenance."
          : null,
  };
}

// Usage:
// const { isBlocked, blockReason } = useMaintenanceGuard();
// <Button disabled={isBlocked} title={blockReason}>Book Now</Button>
```

**Effort**: 3-5 hours (hook + updating key components)
**Priority**: MEDIUM -- Improves UX during DEGRADED mode, prevents confusing failed transactions

---

## 5. Admin Pre-Flight API ✅ IMPLEMENTED

**Problem**: Before activating maintenance, admins must manually check for active calls, pending payments, and upcoming appointments across multiple dashboards.

**Implemented**: Created `GET /api/admin/maintenance/preflight` endpoint that queries active calls, pending payments, upcoming appointments (4h), pending payouts, and open disputes. Returns SAFE/CAUTION/RISKY recommendation with warnings. Integrated into MaintenanceControls UI with a "Run Check" button and stats display.

**Files to Create**:

- `app/api/admin/maintenance/preflight/route.ts`

**Implementation**:

```typescript
// GET /api/admin/maintenance/preflight
// Returns:
{
  activeCalls: 2,              // From Stream.io API
  pendingPayments: 5,          // From Prisma
  upcomingAppointments: 12,    // Next 4 hours, from Prisma
  activeVideoSessions: 1,     // From Stream.io API
  pendingPayouts: 3,           // From Prisma
  isPayoutWindow: false,       // Is it Monday 8-10 PM UTC?
  recommendation: "SAFE" | "CAUTION" | "RISKY",
  warnings: [
    "3 appointments scheduled in the next 2 hours",
    "2 pending payment intents detected"
  ]
}
```

**UI Integration**: Show this data in the MaintenanceControls component before the activate button.

**Effort**: 4-6 hours (API + UI integration)
**Priority**: MEDIUM -- Quality-of-life improvement for admins, reduces risk of missed checks

---

## 6. Scheduled Maintenance

**Problem**: Maintenance can only be activated immediately. There's no way to schedule it in advance and notify users ahead of time.

**Proposed Change**: Support scheduling maintenance windows with future `scheduledAt` time. Send notifications ahead of time.

**Files to Modify**:

- `app/api/admin/maintenance/route.ts` -- Accept `scheduledAt` parameter
- `lib/maintenance.ts` -- Add scheduling logic
- `components/dashboard/MaintenanceControls.tsx` -- Add scheduling UI
- `providers/MaintenanceProvider.tsx` -- Show upcoming maintenance info

**Files to Create**:

- `jobs/maintenance/activate-scheduled-maintenance.ts` -- Cron job to activate when time comes

**Implementation Details**:

1. Admin schedules maintenance: creates `MaintenanceWindow` with `scheduledAt` in the future
2. 24 hours before: Send Novu notification to all users
3. 1 hour before: Show banner "Scheduled maintenance in X minutes"
4. At `scheduledAt`: Cron job activates the maintenance window (sets Redis keys)
5. At `estimatedEnd`: Auto-deactivate (optional, with safety check)

**Database**: The `MaintenanceWindow` model already has a `scheduledAt` field -- this feature just needs the logic to use it.

**Effort**: 8-12 hours
**Priority**: LOW -- Nice to have, but manual activation works fine for a small team

---

## New Gaps Discovered (Feb 2026 audit)

### A. Admin System-Jobs DEGRADED Blocking ✅ IMPLEMENTED

**Problem**: `/api/admin/system-jobs/run` allowed all system jobs during DEGRADED, including financial jobs that call external payment APIs.

**Implemented**: Financial job IDs are blocked in DEGRADED (503 response). All jobs blocked in OFFLINE.
File: `app/api/admin/system-jobs/run/route.ts`

---

### B. Stream.io Webhook DB Health Check ✅ IMPLEMENTED

**Problem**: `app/api/stream/webhooks/route.ts` wrote recording metadata and session events to the DB during migrations without a health check.

**Implemented**: Added `isDbHealthy()` check (reusing `app/api/webhooks/utils.ts`). Returns 503 on DB failure so Stream retries.

---

### C. `reconcile-document-storage` Safety Risk ✅ IMPLEMENTED

**Problem**: The daily document storage reconciliation job (`jobs/cleanup/reconcile-document-storage.ts`) deletes files it considers orphaned. If Supabase Storage is temporarily unreachable (e.g. during migration), it may falsely mark valid files as orphaned and delete them.

**Implemented**: Added a lightweight storage health probe at the start of `reconcileDocumentStorage()` that lists a single item from the `documents` bucket. If storage is unreachable, the job aborts with a warning instead of proceeding to the deletion loop.
File: `scripts/cleanup/reconcile-document-storage.ts`

---

## Implementation Priority Order

| #   | Improvement                                | Priority | Status  |
| --- | ------------------------------------------ | -------- | ------- |
| 2   | Cron job maintenance guard                 | CRITICAL | ✅ Done |
| 1   | DEGRADED write-blocking                    | HIGH     | ✅ Done |
| 3   | Webhook DB health check (Stripe/Razorpay)  | HIGH     | ✅ Done |
| A   | Admin system-jobs DEGRADED blocking        | MEDIUM   | ✅ Done |
| B   | Stream.io webhook DB health check          | MEDIUM   | ✅ Done |
| C   | `reconcile-document-storage` storage probe | MEDIUM   | ✅ Done |
| 4   | UI maintenance guard hook                  | MEDIUM   | ✅ Done |
| 5   | Admin pre-flight API                       | MEDIUM   | ✅ Done |
| 6   | Scheduled maintenance                      | LOW      | Pending |
