# Maintenance Mode Architecture

## Overview

The maintenance mode system uses a **two-tier state management** approach:

- **Redis (Upstash)**: Edge-fast reads for middleware. Queried on every request via REST API.
- **Prisma (PostgreSQL)**: Audit trail and historical data. Stores `MaintenanceWindow` records.

Three maintenance phases: **OFF** -> **DEGRADED** -> **OFFLINE**

### Fail-Open Design

If Redis is unreachable, the system defaults to `OFF` (site stays up). This prevents a Redis outage from accidentally triggering maintenance mode or blocking all traffic.

## Data Flow

```
Admin toggles maintenance mode (UI)
    |
    v
POST /api/admin/maintenance
    |
    +---> Redis: SET maintenance:phase = "OFFLINE"
    |     Redis: SET maintenance:config = { reason, eta, bypassSecret, betterstackIncidentId }
    |
    +---> Prisma: CREATE MaintenanceWindow { phase, reason, startedAt, startedBy, ... }
    |
    +---> BetterStack: CREATE incident (if OFFLINE)
    |
    v
Middleware reads Redis on every request
    |
    +---> getMaintenanceState() via direct Upstash REST fetch
    |
    +---> Phase = OFF? -> Continue normally
    |     Phase = DEGRADED? -> Add headers, continue
    |     Phase = OFFLINE? -> Rewrite to /maintenance page
    |
    v
Client-side MaintenanceProvider polls /api/health every 60s
    |
    +---> Banner shows (DEGRADED) or maintenance page auto-refreshes (OFFLINE)
    |
    v
Admin ends maintenance
    |
    +---> Redis: SET maintenance:phase = "OFF"
    +---> Prisma: UPDATE MaintenanceWindow { endedAt, endedBy }
    +---> BetterStack: RESOLVE incident
    +---> Novu: Send "we're back" notification
```

## Key Files

| File                                                            | Runtime | Purpose                                                                                                                                  |
| --------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `middleware.ts`                                                 | Edge    | Request interception, maintenance checks, route protection                                                                               |
| `lib/maintenance-edge.ts`                                       | Edge    | Edge-safe Redis reads via `fetch()`. No SDK imports.                                                                                     |
| `lib/maintenance.ts`                                            | Node.js | Server-side state management. Redis SDK + Prisma writes.                                                                                 |
| `lib/betterstack.ts`                                            | Node.js | BetterStack incident creation/resolution                                                                                                 |
| `app/api/admin/maintenance/route.ts`                            | Node.js | Admin CRUD API (GET/POST/PATCH/DELETE)                                                                                                   |
| `app/api/health/route.ts`                                       | Node.js | Public health check — returns maintenance state + calls BetterStack `/api/v2/monitors` to report `{ configured, reachable, monitors[] }` |
| `providers/MaintenanceProvider.tsx`                             | Client  | React context, polls `/api/health` every 60s                                                                                             |
| `components/banners/MaintenanceBanner.tsx`                      | Client  | Dismissible warning banner for DEGRADED mode                                                                                             |
| `app/maintenance/page.tsx`                                      | Client  | Full-screen offline page, auto-refreshes every 30s                                                                                       |
| `components/dashboard/MaintenanceControls.tsx`                  | Client  | Admin/staff UI for controlling maintenance                                                                                               |
| `app/dashboard/admin/maintenance/page.tsx`                      | Client  | Admin maintenance control page                                                                                                           |
| `app/dashboard/staff/[staffId]/(features)/maintenance/page.tsx` | Client  | Staff maintenance control page                                                                                                           |

## Database Model

```prisma
enum MaintenancePhase {
  OFF
  DEGRADED
  OFFLINE
}

model MaintenanceWindow {
  id           String           @id @default(cuid())
  phase        MaintenancePhase @default(OFF)
  reason       String?
  scheduledAt  DateTime?        // For future scheduled maintenance
  startedAt    DateTime?        // When entered this phase
  endedAt      DateTime?        // When left this phase
  estimatedEnd DateTime?        // ETA displayed to users
  startedBy    String?          // User ID who triggered
  endedBy      String?          // User ID who ended
  bypassSecret String?          // UUID for bypass access
  metadata     Json?            // Reserved for future use
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}
```

## Redis Keys

| Key                  | Type        | Value                                                           |
| -------------------- | ----------- | --------------------------------------------------------------- |
| `maintenance:phase`  | String      | `"OFF"`, `"DEGRADED"`, or `"OFFLINE"`                           |
| `maintenance:config` | JSON String | `{ reason, estimatedEnd, bypassSecret, betterstackIncidentId }` |

`betterstackIncidentId` is set when entering OFFLINE mode (incident creation succeeds) and read when ending maintenance (to auto-resolve the incident). It is `null` if DEGRADED was used or if incident creation failed.

## Edge Read Strategy

The middleware reads the maintenance state on every non-static request, so the read must never become a per-request Upstash round-trip. `lib/maintenance-edge.ts` keeps a 30-second in-memory cache (edge isolates share module scope within an instance lifetime) and exposes two readers:

| Reader                            | Used by                        | Behaviour                                                                                                |
| --------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `getMaintenanceState()`           | Full document loads + `/api/*` | Returns the cached value if fresh, otherwise does the live Upstash read (200 ms budget; fails open OFF). |
| `getMaintenanceStateCachedOnly()` | RSC / prefetch sub-navigations | Never blocks on Upstash. Returns the last-known state and triggers a background refresh when stale.      |

A soft (RSC) navigation must not block on a Redis round-trip, or it sits blank before its `loading.tsx` can stream. So sub-navigations take the cached-only path. Two edge-runtime details make that path correct rather than a maintenance-bypass hole (#927, #929):

- **`event.waitUntil`** — an unawaited promise is not guaranteed to run after the middleware response is sent, so `middleware()` passes `event.waitUntil` into `getMaintenanceStateCachedOnly()` to keep the background refresh alive. Without it the cache would never repopulate and a session that only soft-navigates would serve stale state indefinitely.
- **`isRefreshing` guard** — a single module-level flag collapses concurrent stale sub-navigations into one Upstash read instead of a thundering herd.

When the cache is stale the cached-only reader returns the **last-known** state (not OFF), so an active window is still enforced while the refresh is in flight. A full document load always does the live read, so any window is enforced within one document navigation or the 30-second cache window.

## Bypass Mechanism

Each maintenance window generates a UUID bypass secret (`crypto.randomUUID()`).

**Usage**:

- HTTP Header: `x-maintenance-bypass: <secret>`
- Cookie: `maintenance_bypass=<secret>`

**Fallback**: If the database-stored secret is unavailable, falls back to `MAINTENANCE_BYPASS_SECRET` env var.

**Scope**: Bypass allows full access during both DEGRADED and OFFLINE modes. Intended for admin/staff testing during maintenance.

## BetterStack Integration

BetterStack monitors the platform for uptime and auto-creates incidents during OFFLINE maintenance.

### Monitors

Two monitors are configured at [https://uptime.betterstack.com/team/t332379](https://uptime.betterstack.com/team/t332379):

| Public Name | URL                                     | Frequency   | Alert |
| ----------- | --------------------------------------- | ----------- | ----- |
| Website     | `https://familiarisenow.com`            | Every 3 min | Email |
| API Health  | `https://familiarisenow.com/api/health` | Every 3 min | Email |

### Status Page

Public status page: [https://familiarise.betteruptime.com](https://familiarise.betteruptime.com)
Shows both monitors and reflects active incidents.

### Incident Lifecycle

**When entering OFFLINE mode** (`POST /api/admin/maintenance`):

1. `createIncident()` is called in `lib/betterstack.ts`
2. BetterStack creates an incident at `/api/v2/incidents`
3. The returned incident ID is stored in Redis under `maintenance:config.betterstackIncidentId`
4. The POST response includes `betterstackIncidentId` so admins can verify

**When ending maintenance** (`DELETE /api/admin/maintenance`):

1. `getMaintenanceState()` reads `betterstackIncidentId` from Redis
2. If an incident ID exists, `resolveIncident(id)` is called
3. BetterStack marks the incident as resolved
4. Status page updates to "All systems operational"

**DEGRADED mode** does NOT create an incident — only OFFLINE does.

**Fail-safe**: If BetterStack API is unreachable or the API key is missing, maintenance mode still activates. Only the status page sync is affected.

### Setup

See [00-betterstack-setup.md](./00-betterstack-setup.md) for the full account and monitor setup guide.

**Required env var**: `BETTERSTACK_API_KEY` (now required — `lib/betterstack.ts` logs a warning and skips if missing)

## Admin API

| Method | Endpoint                 | Purpose                                   |
| ------ | ------------------------ | ----------------------------------------- |
| GET    | `/api/admin/maintenance` | Fetch current state + last 20 windows     |
| POST   | `/api/admin/maintenance` | Start maintenance (returns bypass secret) |
| PATCH  | `/api/admin/maintenance` | Update active window (phase, reason, ETA) |
| DELETE | `/api/admin/maintenance` | End maintenance (set phase=OFF)           |

**Authorization**: Requires `ADMIN` or `STAFF` role.

## Exempt Routes

These routes are never blocked by maintenance mode:

```
/api/webhooks/*        -- Payment + Stream webhook handlers
/api/health            -- Health check endpoint
/api/auth/*            -- Authentication flows
/api/admin/maintenance -- Maintenance control API
/maintenance           -- Maintenance page itself
/_next/*               -- Next.js internal assets
/favicon*              -- Favicon files
*.* (static files)     -- Any file with an extension
```

## Environment Variables

| Variable                    | Required | Purpose                                                                        |
| --------------------------- | -------- | ------------------------------------------------------------------------------ |
| `UPSTASH_REDIS_REST_URL`    | Yes      | Redis endpoint for maintenance state                                           |
| `UPSTASH_REDIS_REST_TOKEN`  | Yes      | Redis auth token                                                               |
| `MAINTENANCE_BYPASS_SECRET` | No       | Fallback bypass secret                                                         |
| `BETTERSTACK_API_KEY`       | **Yes**  | BetterStack incident management. Token from BetterStack Settings → API tokens. |
