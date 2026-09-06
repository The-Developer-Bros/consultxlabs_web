# Scaling Roadmap

**Last Updated**: December 2025
**Status**: Active Planning Document

---

## Executive Summary

**TL;DR**: Supabase can handle 1M+ users with proper optimization. Focus on query optimization, indexes, and caching before considering infrastructure changes.

| Question              | Answer                                |
| --------------------- | ------------------------------------- |
| Need PlanetScale now? | No, Supabase scales to 1M+            |
| Need Neon now?        | No, but easy migration path if needed |
| Need Kafka now?       | No, Redis/BullMQ is enough            |
| When to reconsider?   | When you hit 500K+ active users       |

---

## Current Architecture Assessment

```mermaid
flowchart TD
    subgraph "Current Stack"
        CLIENT[Next.js Frontend] --> API[Next.js API Routes]
        API --> PRISMA[Prisma ORM]
        PRISMA --> SUPABASE[(Supabase PostgreSQL)]
        API --> REDIS[(Upstash Redis)]
        WEBHOOK[Payment Webhooks] --> API
    end

    subgraph "Capacity"
        SUPABASE --> |"✅ Good for 1M+ users"| CAP1[With optimization]
        REDIS --> |"✅ Already using"| CAP2[Locks + Caching]
        PRISMA --> |"⚠️ Watch for"| CAP3[N+1 queries]
        API --> |"⚠️ Serverless"| CAP4[Cold starts at scale]
    end

    style SUPABASE fill:#3ECF8E
    style REDIS fill:#DC382D
```

### Stack Health Check

| Component             | Status   | Capacity  | Notes                           |
| --------------------- | -------- | --------- | ------------------------------- |
| Supabase (PostgreSQL) | ✅ Good  | 1M+ users | With proper optimization        |
| Upstash Redis         | ✅ Good  | High      | Already using for locks/caching |
| Prisma ORM            | ⚠️ Watch | Variable  | N+1 queries can bottleneck      |
| Next.js API Routes    | ⚠️ Watch | Variable  | Serverless cold starts at scale |
| Payment Webhooks      | ✅ Good  | High      | Async, non-blocking             |

---

## Scaling Phases

```mermaid
flowchart LR
    subgraph "PHASE 1"
        P1[0 → 100K users]
        P1_COST["$0-50/month"]
    end

    subgraph "PHASE 2"
        P2[100K → 1M users]
        P2_COST["$100-500/month"]
    end

    subgraph "PHASE 3"
        P3[1M → 10M users]
        P3_COST["$500-2K/month"]
    end

    subgraph "PHASE 4"
        P4[10M+ users]
        P4_COST["$5K+/month"]
    end

    P1 --> P2 --> P3 --> P4

    style P1 fill:#90EE90
    style P2 fill:#87CEEB
    style P3 fill:#FFD700
    style P4 fill:#FF6B6B
```

---

## Phase 1: 0 → 100K Users (Current)

**Cost**: $0-50/month extra
**Focus**: Optimization before scaling

### 1.1 Optimize Prisma Queries

**Problem**: N+1 queries and over-fetching

```typescript
// ❌ BAD: Fetches everything, N+1 potential
const appointments = await prisma.appointment.findMany({
  include: {
    user: true,
    consultant: true,
    slots: {
      include: {
        payment: true,
      },
    },
  },
});

// ✅ GOOD: Selective fields, single query
const appointments = await prisma.appointment.findMany({
  select: {
    id: true,
    status: true,
    scheduledAt: true,
    user: {
      select: {
        id: true,
        name: true,
        email: true,
      },
    },
    consultant: {
      select: {
        id: true,
        displayName: true,
      },
    },
    _count: {
      select: { slots: true },
    },
  },
});
```

**Batch queries instead of loops:**

```typescript
// ❌ BAD: N+1 query pattern
const users = await prisma.user.findMany();
for (const user of users) {
  const appointments = await prisma.appointment.findMany({
    where: { userId: user.id },
  });
}

// ✅ GOOD: Single query with grouping
const usersWithAppointments = await prisma.user.findMany({
  include: {
    appointments: {
      take: 10,
      orderBy: { createdAt: "desc" },
    },
  },
});
```

### 1.2 Add Database Indexes

**Identify slow queries:**

```sql
-- Find slow queries in Supabase
SELECT
  query,
  calls,
  mean_time,
  total_time
FROM pg_stat_statements
ORDER BY mean_time DESC
LIMIT 20;
```

**Add composite indexes for common queries:**

```sql
-- Dashboard queries (consultant)
CREATE INDEX CONCURRENTLY idx_appointments_consultant_status
ON "Appointment" ("consultantId", "status", "scheduledAt" DESC);

-- User booking history
CREATE INDEX CONCURRENTLY idx_appointments_user_created
ON "Appointment" ("userId", "createdAt" DESC);

-- Payment lookups
CREATE INDEX CONCURRENTLY idx_payments_status_created
ON "Payment" ("status", "createdAt" DESC);

-- Slot availability
CREATE INDEX CONCURRENTLY idx_slots_consultant_date
ON "SlotOfAppointment" ("consultantId", "date", "isTentative");
```

### 1.3 Enable Connection Pooling

Supabase uses **Supavisor** (replaced PgBouncer in 2024) automatically on port 6543.

```typescript
// .env - Use pooled connection
DATABASE_URL =
  "postgresql://user:pass@db.xxx.supabase.co:6543/postgres?pgbouncer=true";

// For migrations, use direct connection (port 5432)
DIRECT_URL = "postgresql://user:pass@db.xxx.supabase.co:5432/postgres";
```

```typescript
// prisma/schema.prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}
```

### Phase 1 Checklist

```markdown
- [ ] Audit top 10 slowest API endpoints
- [ ] Replace `include` with `select` where possible
- [ ] Add indexes for dashboard queries
- [ ] Verify connection pooling is enabled
- [ ] Set up query monitoring in Supabase dashboard
- [ ] Implement Redis caching for frequently-read data
```

---

## Phase 2: 100K → 1M Users

**Cost**: $100-500/month
**Focus**: Horizontal read scaling, caching layer

### 2.1 Upgrade to Supabase Pro

| Feature                | Free   | Pro                |
| ---------------------- | ------ | ------------------ |
| Database size          | 500MB  | 8GB+               |
| Connections            | 60     | Unlimited (pooled) |
| Read replicas          | ❌     | ✅ Up to 2         |
| Point-in-time recovery | ❌     | ✅                 |
| Daily backups          | 7 days | 30 days            |

### 2.2 Add Read Replicas

```mermaid
flowchart TD
    APP[Application] --> ROUTER{Query Router}
    ROUTER --> |"Writes"| PRIMARY[(Primary DB)]
    ROUTER --> |"Reads"| REPLICA1[(Read Replica 1)]
    ROUTER --> |"Reads"| REPLICA2[(Read Replica 2)]

    PRIMARY --> |"Replication"| REPLICA1
    PRIMARY --> |"Replication"| REPLICA2
```

**Implementation with Prisma:**

```typescript
// lib/prisma.ts
import { PrismaClient } from "@prisma/client";

// Primary for writes
const primaryPrisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DATABASE_URL },
  },
});

// Replica for reads
const replicaPrisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DATABASE_REPLICA_URL },
  },
});

// Query router
export const db = {
  // Use replica for read-heavy operations
  read: replicaPrisma,

  // Use primary for writes and transactions
  write: primaryPrisma,

  // Convenience method
  query: <T>(
    operation: "read" | "write",
    fn: (prisma: PrismaClient) => Promise<T>,
  ) => {
    const client = operation === "read" ? replicaPrisma : primaryPrisma;
    return fn(client);
  },
};

// Usage
const dashboardData = await db.read.appointment.findMany({
  where: { consultantId },
});

const newBooking = await db.write.appointment.create({
  data: bookingData,
});
```

### 2.3 Implement Redis Caching Layer

```typescript
// lib/cache/dashboard.ts
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

interface CacheConfig {
  ttl: number; // seconds
  prefix: string;
}

const CACHE_CONFIG: Record<string, CacheConfig> = {
  dashboardHome: { ttl: 60, prefix: "dash:home" },
  appointments: { ttl: 30, prefix: "dash:appts" },
  requests: { ttl: 15, prefix: "dash:reqs" },
  userProfile: { ttl: 300, prefix: "user:profile" },
};

export async function getCached<T>(
  key: string,
  fetcher: () => Promise<T>,
  config: keyof typeof CACHE_CONFIG,
): Promise<T> {
  const { ttl, prefix } = CACHE_CONFIG[config];
  const cacheKey = `${prefix}:${key}`;

  // Try cache first
  const cached = await redis.get<T>(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Fetch from DB
  const data = await fetcher();

  // Cache with TTL
  await redis.setex(cacheKey, ttl, data);

  return data;
}

// Invalidation helper
export async function invalidatePattern(pattern: string): Promise<void> {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

// Usage in API route
export async function GET(req: Request) {
  const { consultantId } = getParams(req);

  const data = await getCached(
    consultantId,
    () => fetchDashboardData(consultantId),
    "dashboardHome",
  );

  return Response.json(data);
}
```

### 2.4 Consider Edge Functions

For latency-sensitive endpoints:

```typescript
// app/api/dashboard/route.ts
export const runtime = "edge"; // Run at edge locations

export async function GET(req: Request) {
  // Edge-optimized response
  const data = await getCachedDashboard(userId);

  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, max-age=30",
    },
  });
}
```

### Phase 2 Checklist

```markdown
- [ ] Upgrade to Supabase Pro plan
- [ ] Enable 2 read replicas
- [ ] Implement read/write splitting in Prisma
- [ ] Deploy Redis caching for dashboard endpoints
- [ ] Set up cache invalidation on mutations
- [ ] Monitor cache hit rates
- [ ] Consider edge runtime for critical APIs
```

---

## Phase 3: 1M → 10M Users

**Cost**: $500-2000/month
**Focus**: Event streaming, potential migration planning

### 3.1 Decision Point: Stay or Migrate?

```mermaid
flowchart TD
    START{Hitting Limits?} --> |"Slow Reads"| READ[Add More Replicas]
    START --> |"Connection Errors"| CONN[Increase Pool Size]
    START --> |"Write Bottleneck"| WRITE{Write Volume?}

    WRITE --> |"< 10K/sec"| OPTIMIZE[Optimize Queries + Caching]
    WRITE --> |"> 10K/sec"| MIGRATE{Migration Options}

    MIGRATE --> NEON[Neon<br/>Same PostgreSQL<br/>Auto-scaling]
    MIGRATE --> PS[PlanetScale<br/>Horizontal Sharding<br/>Schema Changes Required]

    READ --> ENOUGH{Sufficient?}
    CONN --> ENOUGH
    OPTIMIZE --> ENOUGH

    ENOUGH --> |"Yes"| STAY[Stay on Supabase]
    ENOUGH --> |"No"| MIGRATE

    style STAY fill:#90EE90
    style NEON fill:#87CEEB
    style PS fill:#FFD700
```

### 3.2 Add Redis Streams for Event Processing

Replace synchronous operations with event-driven patterns:

```typescript
// lib/events/publisher.ts
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

interface Event {
  type: string;
  payload: unknown;
  timestamp: number;
}

export async function publishEvent(stream: string, event: Event) {
  await redis.xadd(stream, "*", event);
}

// Usage: Instead of synchronous operations
async function handlePaymentSuccess(payment: Payment) {
  // Publish event instead of doing everything synchronously
  await publishEvent("payments", {
    type: "PAYMENT_SUCCESS",
    payload: {
      paymentId: payment.id,
      userId: payment.userId,
      consultantId: payment.consultantId,
      amount: payment.amount,
    },
    timestamp: Date.now(),
  });
}

// Consumer (separate worker)
async function consumePaymentEvents() {
  let lastId = "0";

  while (true) {
    const events = await redis.xread({
      streams: { payments: lastId },
      block: 5000,
    });

    for (const [stream, messages] of events || []) {
      for (const [id, event] of messages) {
        await processPaymentEvent(event);
        lastId = id;
      }
    }
  }
}
```

### 3.3 Microservices Split (If Needed)

When to split:

| Signal                        | Action                               |
| ----------------------------- | ------------------------------------ |
| Single service >50 API routes | Consider splitting by domain         |
| Different scaling needs       | Payments scale differently than chat |
| Team growth >10 engineers     | Domain ownership boundaries          |

**Recommended split:**

```
monolith/
├── api/                    # Keep together initially
│   ├── auth/
│   ├── dashboard/
│   ├── payments/           # Candidate for extraction
│   └── chat/               # Candidate for extraction

# Later split to:
services/
├── main-app/              # Dashboard, user management
├── payments-service/      # Payment processing, webhooks
└── realtime-service/      # Chat, notifications (WebSocket)
```

### Phase 3 Checklist

```markdown
- [ ] Monitor write throughput (target: stay under 10K/sec)
- [ ] Implement event streaming for heavy operations
- [ ] Evaluate Neon vs staying on Supabase
- [ ] Plan service boundaries (if splitting)
- [ ] Set up distributed tracing
- [ ] Implement circuit breakers for external services
```

---

## Phase 4: 10M+ Users

**Cost**: $5000+/month
**Focus**: Horizontal scaling, global distribution

> **Note**: You probably don't need this. Only proceed if Phase 3 optimizations are exhausted.

### 4.1 Database Options

| Option          | Use Case                                   | Considerations                  |
| --------------- | ------------------------------------------ | ------------------------------- |
| **Neon**        | PostgreSQL compatibility, auto-scaling     | Easiest migration from Supabase |
| **PlanetScale** | Horizontal sharding, MySQL                 | Schema changes required, no FKs |
| **CockroachDB** | Global distribution, PostgreSQL-compatible | More complex operations         |

### 4.2 Event Streaming at Scale

```mermaid
flowchart LR
    subgraph "Producers"
        API[API Servers]
        WEBHOOK[Webhooks]
        JOBS[Background Jobs]
    end

    subgraph "Kafka"
        TOPIC1[payments]
        TOPIC2[bookings]
        TOPIC3[notifications]
    end

    subgraph "Consumers"
        ANALYTICS[Analytics Service]
        NOTIFY[Notification Service]
        AUDIT[Audit Log]
    end

    API --> TOPIC1
    API --> TOPIC2
    WEBHOOK --> TOPIC1
    JOBS --> TOPIC3

    TOPIC1 --> ANALYTICS
    TOPIC1 --> AUDIT
    TOPIC2 --> ANALYTICS
    TOPIC2 --> NOTIFY
    TOPIC3 --> NOTIFY
```

### 4.3 Multi-Region Setup

```typescript
// lib/db/regional.ts
const REGIONS = {
  "us-east": process.env.DB_URL_US_EAST,
  "eu-west": process.env.DB_URL_EU_WEST,
  "ap-south": process.env.DB_URL_AP_SOUTH,
};

export function getRegionalDb(userRegion: string) {
  const dbUrl = REGIONS[userRegion] || REGIONS["us-east"];
  return new PrismaClient({
    datasources: { db: { url: dbUrl } },
  });
}
```

---

## Bottleneck Quick Reference

| Symptom              | Likely Cause           | Solution                                |
| -------------------- | ---------------------- | --------------------------------------- |
| Slow dashboard loads | N+1 queries            | Use `select`, add indexes               |
| Connection timeouts  | Pool exhaustion        | Enable Supavisor, increase pool         |
| High DB CPU          | Missing indexes        | Add composite indexes                   |
| Slow reads at scale  | Single read node       | Add read replicas                       |
| Write latency spikes | Transaction contention | Optimize transactions, async processing |
| API cold starts      | Serverless overhead    | Edge functions, keep-warm               |
| Memory pressure      | Large result sets      | Pagination, streaming                   |

---

## Monitoring Checklist

### Supabase Dashboard Metrics

```markdown
Watch these metrics:

- [ ] Active connections (should be <80% of limit)
- [ ] Query execution time (p95 <100ms for simple queries)
- [ ] Database size growth rate
- [ ] Replication lag (if using replicas)
```

### Application Metrics

```typescript
// Instrument key operations
import { metrics } from "@/lib/monitoring";

export async function getDashboard(userId: string) {
  const start = performance.now();

  try {
    const data = await fetchDashboardData(userId);

    metrics.timing("dashboard.load", performance.now() - start);
    metrics.increment("dashboard.success");

    return data;
  } catch (error) {
    metrics.increment("dashboard.error");
    throw error;
  }
}
```

---

## Cost Estimation

| Phase | Users   | Infrastructure                        | Monthly Cost |
| ----- | ------- | ------------------------------------- | ------------ |
| 1     | 0-100K  | Supabase Free/Pro                     | $0-50        |
| 2     | 100K-1M | Pro + Replicas + Redis                | $100-500     |
| 3     | 1M-10M  | Pro + Heavy Caching + Events          | $500-2000    |
| 4     | 10M+    | Distributed DB + Kafka + Multi-region | $5000+       |

---

## Decision Framework

```
Before any scaling decision, ask:

1. Have we optimized queries? (Phase 1)
   └── If no → Optimize first

2. Are we using caching effectively? (Phase 1-2)
   └── If no → Implement Redis caching

3. Do we have read replicas? (Phase 2)
   └── If no → Add replicas before migrating

4. Is the bottleneck reads or writes?
   ├── Reads → More replicas + caching
   └── Writes → Consider migration to Neon/PlanetScale

5. Do we need event replay/audit?
   ├── No → Redis Streams is enough
   └── Yes → Consider Kafka

Focus on: Query optimization, indexes, and caching first.
These give 10-100x improvement before needing infrastructure changes.
```

---

## Related Documentation

- [Real-Time Caching Strategy](./realtime-caching-strategy.md) - Caching architecture details
- [Migration Guide](./migration-guide.md) - Zero-downtime migration patterns
- [Dashboard Prefetching](../../performance/02-dashboard-prefetching.md) - Client-side optimization
