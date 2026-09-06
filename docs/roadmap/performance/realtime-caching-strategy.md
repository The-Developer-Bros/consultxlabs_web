# Real-Time Dashboard Caching Strategy

**Last Updated**: December 2025
**Status**: Superseded — never implemented. The platform decided not to close the freshness gap described below with the Redis, SWR or SSE infrastructure this document proposes.

> **Superseded by [ADR 16 — Slot freshness without Supabase Realtime](../../enterprise/70-design-decisions/16-slot-freshness-without-realtime.md).**
> None of the Redis-caching, SWR, or SSE layers below were ever built — there
> is no `lib/cache/dashboard.ts`, no dashboard Redis cache, and no SSE
> endpoint in this repo today. For the booking surfaces this document was
> written for, ADR 16 concluded the freshness gap does not need closing with
> new infrastructure: correctness is already server-authoritative (locks +
> CAS transitions + a DB exclusion constraint), and staleness is bounded by a
> 60-second visibility-gated poll (`lib/scheduling/availabilityPolling.ts`,
> #1164) plus focus-triggered refetch and mutation-driven invalidation. Read
> this page as a rejected proposal, not a live implementation guide.

---

## Overview

This document outlines the recommended approach for keeping dashboard data fresh without traditional polling. We use a **3-layer architecture** that balances real-time updates with performance and reliability.

### Why Not Traditional Polling?

| Approach             | Problem                                 |
| -------------------- | --------------------------------------- |
| Short polling (1-5s) | Too many requests, hammers the database |
| Long polling (30s+)  | Data feels stale, poor UX               |
| Aggressive refresh   | Battery drain, bandwidth waste          |

### Why Not Supabase Realtime for Dashboards?

While Supabase Realtime works well for chat/collaboration, it has limitations for dashboards:

| Concern               | Details                                                          |
| --------------------- | ---------------------------------------------------------------- |
| **Reliability**       | WebSocket connections can silently fail without reconnection     |
| **RLS Complexity**    | Requires careful Row Level Security configuration for each table |
| **Overkill**          | Dashboards need "fresh enough" data, not sub-second updates      |
| **Connection Limits** | Each tab/window opens a new connection                           |
| **Debugging**         | Harder to debug than HTTP requests                               |

**Our Recommendation**: Use Supabase Realtime sparingly (chat, live notifications) and use the 3-layer approach for dashboards.

---

## Architecture

```mermaid
flowchart TD
    subgraph "Client Layer"
        UI[Dashboard UI] --> RQ[React Query]
        RQ --> |"staleTime: 30s<br/>refetchOnWindowFocus"| API[API Request]
    end

    subgraph "API Layer"
        API --> RL{Rate Limiter<br/>Upstash + Arcjet}
        RL --> |"Allowed"| CACHE{Redis Cache<br/>Check}
        RL --> |"Blocked"| ERROR[429 Error]

        CACHE --> |"HIT"| RETURN[Return Cached]
        CACHE --> |"MISS"| DB[(Supabase DB)]
        DB --> SET[Set Cache<br/>TTL: 15-60s]
        SET --> RETURN
    end

    subgraph "Real-Time Layer (Optional)"
        WEBHOOK[Webhook/Mutation] --> INVALIDATE[Invalidate Cache]
        WEBHOOK --> PUBLISH[Redis Pub/Sub]
        PUBLISH --> SSE[SSE Endpoint]
        SSE --> |"Push Update"| UI
    end

    style RQ fill:#61DAFB
    style CACHE fill:#DC382D
    style DB fill:#3ECF8E
    style SSE fill:#FFD700
```

---

## Complete Strategy: Prefetching + SWR + SSE

Prefetching and real-time updates are **complementary strategies**, not competing ones:

| Layer           | Purpose                      | Timing                  |
| --------------- | ---------------------------- | ----------------------- |
| **Prefetching** | Load data before user clicks | Mount, hover            |
| **SWR Cache**   | Keep viewed data fresh       | staleTime, window focus |
| **Redis Cache** | Reduce database load         | Server-side TTL         |
| **SSE**         | Push critical updates        | Webhooks, mutations     |

### Combined Flow Diagram

```mermaid
sequenceDiagram
    participant U as User
    participant RQ as React Query
    participant API as API Route
    participant Redis as Upstash Redis
    participant DB as Supabase
    participant SSE as SSE Channel

    Note over U,DB: PREFETCH PHASE (on mount)
    U->>RQ: Enter dashboard
    RQ->>API: Prefetch home, appointments, requests
    API->>Redis: Check cache
    Redis-->>API: MISS
    API->>DB: Query data
    DB-->>API: Results
    API->>Redis: Cache (TTL: 30-60s)
    API-->>RQ: Data
    RQ->>RQ: Store in query cache

    Note over U,DB: NAVIGATION (instant)
    U->>RQ: Hover "Requests" tab
    RQ->>RQ: Check cache (fresh)
    U->>RQ: Click "Requests"
    RQ-->>U: Instant render from cache

    Note over U,DB: SWR REVALIDATION (background)
    RQ->>RQ: staleTime expired (30s)
    RQ->>API: Background refetch
    API->>Redis: Check cache (HIT)
    Redis-->>API: Cached data
    API-->>RQ: Fresh data
    RQ-->>U: Update if changed

    Note over U,DB: REAL-TIME UPDATE (push)
    SSE->>RQ: New booking notification
    RQ->>RQ: Invalidate queries
    RQ->>API: Refetch
    API->>DB: Fresh query
    DB-->>API: New data
    API-->>RQ: Updated results
    RQ-->>U: Show new booking
```

### When Each Layer Activates

| Event                           | Layer Used                  |
| ------------------------------- | --------------------------- |
| User enters dashboard           | Prefetch (mount)            |
| User hovers over tab            | Prefetch (hover)            |
| User clicks tab                 | Instant from cache          |
| 30s passes while viewing        | SWR background revalidation |
| User switches browser windows   | SWR refetchOnWindowFocus    |
| New booking arrives via webhook | SSE → invalidate → refetch  |
| Same API called twice in 60s    | Redis cache HIT             |

### User Timeline Example

```
0s    User enters consultant dashboard
      → Prefetch: Home, Appointments, Requests data loaded

2s    User viewing Home tab
      → SWR: Data marked "fresh" (staleTime: 30s)

5s    User hovers over "Requests" tab
      → Prefetch: Requests data refreshed (if stale)

6s    User clicks "Requests"
      → INSTANT: Data already in cache

35s   User still on Requests tab
      → SWR: Data now stale, background refetch

40s   New booking arrives (webhook)
      → SSE: Push notification to client
      → React Query: Invalidate dashboard queries
      → User sees: "New request" toast + fresh data
```

> **See also**: [Dashboard Prefetching](../../performance/02-dashboard-prefetching.md) for detailed prefetch implementation patterns.

---

## Layer 1: Redis Caching (Upstash)

### Cache Key Strategy

```typescript
// Pattern: {scope}:{userId}:{resource}:{filters?}
const cacheKeys = {
  // Consultant Dashboard
  consultantHome: (userId: string) => `dashboard:consultant:${userId}:home`,
  consultantAppointments: (userId: string, tab: string) =>
    `dashboard:consultant:${userId}:appointments:${tab}`,
  consultantRequests: (userId: string) =>
    `dashboard:consultant:${userId}:requests`,

  // User Dashboard
  userHome: (userId: string) => `dashboard:user:${userId}:home`,
  userBookings: (userId: string) => `dashboard:user:${userId}:bookings`,

  // Admin Dashboard
  adminPayments: (page: number) => `dashboard:admin:payments:${page}`,
  adminRefunds: (page: number) => `dashboard:admin:refunds:${page}`,
};
```

### TTL Configuration

| Data Type            | TTL  | Rationale                  |
| -------------------- | ---- | -------------------------- |
| Dashboard home stats | 60s  | Aggregates change slowly   |
| Appointment list     | 30s  | Needs reasonable freshness |
| Request queue        | 15s  | More time-sensitive        |
| Payment history      | 120s | Rarely changes             |
| User profile         | 300s | Very stable                |

### Implementation

```typescript
// lib/cache/dashboard.ts
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

interface CacheOptions {
  ttl?: number; // seconds
  tags?: string[];
}

export async function getCachedOrFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: CacheOptions = {},
): Promise<T> {
  const { ttl = 30 } = options;

  // Try cache first
  const cached = await redis.get<T>(key);
  if (cached !== null) {
    return cached;
  }

  // Fetch from DB
  const data = await fetcher();

  // Cache with TTL
  await redis.setex(key, ttl, data);

  return data;
}

// Invalidation helper
export async function invalidateCache(pattern: string): Promise<void> {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

// Usage example
export async function getConsultantDashboard(userId: string) {
  return getCachedOrFetch(
    `dashboard:consultant:${userId}:home`,
    async () => {
      // Your Prisma query here
      return prisma.appointment.findMany({
        where: { consultantId: userId },
        // ...
      });
    },
    { ttl: 60 },
  );
}
```

### Cache Invalidation Triggers

```typescript
// After mutations (webhooks, API updates)
async function handlePaymentSuccess(paymentId: string) {
  // ... payment logic ...

  // Invalidate relevant caches
  await Promise.all([
    invalidateCache(`dashboard:consultant:${consultantId}:*`),
    invalidateCache(`dashboard:user:${userId}:*`),
  ]);
}
```

---

## Layer 2: React Query (SWR Pattern)

### Configuration

```typescript
// lib/react-query/config.ts
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Data stays fresh for 30 seconds
      staleTime: 30 * 1000,

      // Cache persists for 5 minutes
      gcTime: 5 * 60 * 1000,

      // Refetch when window regains focus
      refetchOnWindowFocus: true,

      // Don't refetch on mount if data is fresh
      refetchOnMount: false,

      // Retry failed requests twice
      retry: 2,

      // Don't refetch in background by default
      refetchInterval: false,
    },
  },
});
```

### Query Key Patterns

```typescript
// hooks/useDashboard.ts
export const dashboardKeys = {
  all: ["dashboard"] as const,

  // Consultant
  consultant: (userId: string) =>
    [...dashboardKeys.all, "consultant", userId] as const,
  consultantHome: (userId: string) =>
    [...dashboardKeys.consultant(userId), "home"] as const,
  consultantAppointments: (userId: string, tab: string) =>
    [...dashboardKeys.consultant(userId), "appointments", tab] as const,

  // User
  user: (userId: string) => [...dashboardKeys.all, "user", userId] as const,
  userBookings: (userId: string) =>
    [...dashboardKeys.user(userId), "bookings"] as const,
};
```

### Dashboard Hook Example

```typescript
// hooks/useConsultantDashboard.ts
import { useQuery, useQueryClient } from "@tanstack/react-query";

export function useConsultantDashboard(userId: string) {
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: dashboardKeys.consultantHome(userId),
    queryFn: () =>
      fetch(`/api/dashboard/consultant/${userId}`).then((r) => r.json()),
    staleTime: 30 * 1000,
    refetchOnWindowFocus: true,
  });

  // Manual refresh function
  const refresh = () => {
    queryClient.invalidateQueries({
      queryKey: dashboardKeys.consultant(userId),
    });
  };

  return { data, isLoading, error, refresh };
}
```

### Optimistic Updates

```typescript
// For mutations that should reflect immediately
const mutation = useMutation({
  mutationFn: updateAppointmentStatus,
  onMutate: async (newStatus) => {
    // Cancel outgoing refetches
    await queryClient.cancelQueries({
      queryKey: dashboardKeys.consultantHome(userId),
    });

    // Snapshot previous value
    const previous = queryClient.getQueryData(
      dashboardKeys.consultantHome(userId),
    );

    // Optimistically update
    queryClient.setQueryData(dashboardKeys.consultantHome(userId), (old) => ({
      ...old,
      status: newStatus,
    }));

    return { previous };
  },
  onError: (err, newStatus, context) => {
    // Rollback on error
    queryClient.setQueryData(
      dashboardKeys.consultantHome(userId),
      context?.previous,
    );
  },
  onSettled: () => {
    // Refetch to ensure consistency
    queryClient.invalidateQueries({
      queryKey: dashboardKeys.consultantHome(userId),
    });
  },
});
```

---

## Layer 3: Server-Sent Events (Optional)

Use SSE for **critical real-time updates** only. Not recommended for all dashboard data.

### When to Use SSE

| Use SSE                   | Don't Use SSE               |
| ------------------------- | --------------------------- |
| New booking notifications | Historical appointment list |
| Payment confirmations     | Dashboard statistics        |
| Live consultation alerts  | User profile data           |
| Urgent admin alerts       | Pagination results          |

### SSE Endpoint Implementation

```typescript
// app/api/sse/dashboard/route.ts
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

export async function GET(req: Request) {
  const userId = await getUserIdFromSession(req);
  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Subscribe to Redis channel
      const channel = `dashboard:${userId}:updates`;

      // Send keepalive every 30s
      const keepalive = setInterval(() => {
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, 30000);

      // Poll Redis for messages (Upstash doesn't support persistent subscriptions)
      const pollInterval = setInterval(async () => {
        const messages = await redis.lpop<string[]>(channel, 10);
        for (const msg of messages || []) {
          controller.enqueue(encoder.encode(`data: ${msg}\n\n`));
        }
      }, 1000);

      // Cleanup on close
      req.signal.addEventListener("abort", () => {
        clearInterval(keepalive);
        clearInterval(pollInterval);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
```

### Client-Side SSE Hook

```typescript
// hooks/useDashboardSSE.ts
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function useDashboardSSE(userId: string) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const eventSource = new EventSource(`/api/sse/dashboard?userId=${userId}`);

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      // Invalidate relevant queries based on event type
      switch (data.type) {
        case "NEW_BOOKING":
          queryClient.invalidateQueries({
            queryKey: dashboardKeys.consultantHome(userId),
          });
          break;
        case "PAYMENT_RECEIVED":
          queryClient.invalidateQueries({
            queryKey: dashboardKeys.consultantRequests(userId),
          });
          break;
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      // Reconnect after 5s
      setTimeout(() => {
        // Reconnection logic
      }, 5000);
    };

    return () => eventSource.close();
  }, [userId, queryClient]);
}
```

### Publishing Updates (From Webhooks/Mutations)

```typescript
// lib/realtime/publish.ts
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

export async function publishDashboardUpdate(
  userId: string,
  event: { type: string; data: unknown },
) {
  const channel = `dashboard:${userId}:updates`;
  await redis.rpush(channel, JSON.stringify(event));

  // Auto-expire messages after 5 minutes
  await redis.expire(channel, 300);
}

// Usage in webhook handler
async function handleWebhook(payment: Payment) {
  // ... process payment ...

  // Notify consultant dashboard
  await publishDashboardUpdate(payment.consultantId, {
    type: "PAYMENT_RECEIVED",
    data: { paymentId: payment.id, amount: payment.amount },
  });
}
```

---

## Rate Limiting Strategy

### Upstash Ratelimit Configuration

```typescript
// lib/ratelimit/config.ts
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

// Different limits for different endpoint types
export const rateLimits = {
  // Dashboard endpoints - generous limits
  dashboard: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(100, "1 m"), // 100 req/min
    analytics: true,
    prefix: "ratelimit:dashboard",
  }),

  // Checkout endpoints - stricter limits
  checkout: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(10, "1 m"), // 10 req/min
    analytics: true,
    prefix: "ratelimit:checkout",
  }),

  // SSE connections - very limited
  sse: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(5, "1 m"), // 5 connections/min
    analytics: true,
    prefix: "ratelimit:sse",
  }),

  // API mutations - moderate limits
  mutations: new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(30, "1 m"), // 30 req/min
    analytics: true,
    prefix: "ratelimit:mutations",
  }),
};
```

### Arcjet Integration

```typescript
// lib/security/arcjet.ts
import arcjet, { shield, detectBot, rateLimit } from "@arcjet/next";

export const aj = arcjet({
  key: process.env.ARCJET_KEY!,
  rules: [
    // Shield against common attacks
    shield({ mode: "LIVE" }),

    // Bot detection
    detectBot({
      mode: "LIVE",
      allow: ["CATEGORY:SEARCH_ENGINE"], // Allow search bots
    }),

    // Global rate limit (backup to Upstash)
    rateLimit({
      mode: "LIVE",
      match: "/api/dashboard/*",
      characteristics: ["userId", "ip.src"],
      window: "1m",
      max: 120,
    }),
  ],
});
```

### Middleware Implementation

```typescript
// middleware.ts (rate limiting portion)
import { rateLimits } from "@/lib/ratelimit/config";

export async function ratelimitMiddleware(req: NextRequest) {
  const ip = req.ip ?? "127.0.0.1";
  const path = req.nextUrl.pathname;

  // Select appropriate limiter
  let limiter = rateLimits.dashboard;
  if (path.includes("/checkout")) {
    limiter = rateLimits.checkout;
  } else if (path.includes("/sse")) {
    limiter = rateLimits.sse;
  }

  const { success, limit, remaining, reset } = await limiter.limit(ip);

  if (!success) {
    return new Response("Too Many Requests", {
      status: 429,
      headers: {
        "X-RateLimit-Limit": limit.toString(),
        "X-RateLimit-Remaining": remaining.toString(),
        "X-RateLimit-Reset": reset.toString(),
        "Retry-After": Math.ceil((reset - Date.now()) / 1000).toString(),
      },
    });
  }

  return null; // Continue to next middleware
}
```

---

## Scaling Considerations

### Current Stack Capabilities

| Component           | Capacity                     | Notes                        |
| ------------------- | ---------------------------- | ---------------------------- |
| **Supabase (Free)** | 500 concurrent connections   | Sufficient for most startups |
| **Supabase (Pro)**  | Unlimited pooled connections | Uses Supavisor automatically |
| **Upstash Redis**   | 10K commands/day (free)      | Scale with pay-as-you-go     |
| **Vercel**          | Serverless, auto-scales      | No connection pooling needed |

### Supavisor (Built-in Connection Pooling)

As of January 2024, **Supavisor** is the default connection pooler for all Supabase projects. No additional setup required.

```typescript
// Connection string already uses Supavisor
// postgresql://user:pass@db.xxx.supabase.co:6543/postgres?pgbouncer=true
//                                                ^^^^
//                                                Port 6543 = Supavisor
```

**You do NOT need:**

- External PgBouncer setup
- Third-party connection poolers
- Special Prisma configuration

### When to Consider Alternatives

| Trigger                     | Current Solution | Consider                  |
| --------------------------- | ---------------- | ------------------------- |
| >10K concurrent users       | Supabase Pro     | Keep current setup        |
| >100K concurrent users      | Supabase Pro     | Neon or PlanetScale       |
| Global low-latency required | Single region    | Multi-region with Neon    |
| Complex event streaming     | SSE              | Kafka + dedicated service |
| >1M messages/day            | Redis pub/sub    | Kafka or AWS EventBridge  |

### Migration Path (If Needed)

```
Current (handles 1M+ users):
Supabase + Upstash Redis + Vercel

Future (if scaling issues):
├── Database: Neon (better branching, global) or PlanetScale (MySQL)
├── Cache: Upstash Redis (no change)
├── Events: Kafka or AWS EventBridge
└── Hosting: Vercel or Fly.io (for persistent connections)
```

---

## Implementation Checklist

### Phase 1: Redis Caching

- [ ] Set up Upstash Redis project
- [ ] Implement `getCachedOrFetch` helper
- [ ] Add cache keys for dashboard endpoints
- [ ] Configure TTLs per data type
- [ ] Add cache invalidation to webhooks

### Phase 2: React Query Optimization

- [ ] Configure QueryClient with SWR settings
- [ ] Create dashboard query key factory
- [ ] Implement `useConsultantDashboard` hook
- [ ] Add optimistic updates for mutations
- [ ] Test refetchOnWindowFocus behavior

### Phase 3: Rate Limiting

- [ ] Set up Upstash Ratelimit
- [ ] Configure limits per endpoint type
- [ ] Add rate limit headers to responses
- [ ] Set up Arcjet for bot protection
- [ ] Monitor rate limit analytics

### Phase 4: SSE (Optional)

- [ ] Identify critical real-time events
- [ ] Implement SSE endpoint
- [ ] Create Redis pub/sub channels
- [ ] Add client-side SSE hook
- [ ] Test reconnection logic

---

## Quick Reference

### Cache TTLs

```
Dashboard home:     60s
Appointments:       30s
Requests:           15s
Payments:          120s
Profiles:          300s
```

### Rate Limits

```
Dashboard API:     100 req/min
Checkout API:       10 req/min
SSE connections:     5/min
Mutations:          30 req/min
```

### Query staleTime

```
Dashboard data:     30s
User profile:       60s
Static content:    300s
```

---

## Related Documentation

- [Dashboard Prefetching](../../performance/02-dashboard-prefetching.md) - Route-based prefetching strategies
- [Payment Status Flows](../../payments/checkout-flow/06-status-flows.md) - Payment lifecycle documentation
