# Zero-Downtime Migration Guide

**Last Updated**: December 2025
**Status**: Reference Guide for Future Scaling

---

## Overview

This guide covers how to migrate between infrastructure providers **without disrupting customer experience**. All strategies assume you have live users and cannot afford extended downtime.

### When to Consider Migration

| Trigger           | Current Limit                 | Consider Migration      |
| ----------------- | ----------------------------- | ----------------------- |
| Connection errors | Supabase free tier (500 conn) | Upgrade to Pro first    |
| Slow reads        | Single region                 | Add read replicas first |
| Write bottleneck  | ~10K writes/sec               | Neon or PlanetScale     |
| Global latency    | Single region DB              | Multi-region (Neon)     |
| Event throughput  | 10K events/sec                | Kafka                   |

### Migration Decision Matrix

```
┌─────────────────────────────────────────────────────────────────┐
│                    SHOULD YOU MIGRATE?                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  OPTIMIZE FIRST (before any migration):                         │
│  ├── Add database indexes                                       │
│  ├── Enable connection pooling (Supavisor)                     │
│  ├── Implement Redis caching                                    │
│  ├── Optimize N+1 queries                                       │
│  └── Add read replicas                                          │
│                                                                  │
│  IF STILL HITTING LIMITS:                                       │
│  ├── Need better PostgreSQL scaling? → Neon                    │
│  ├── Need horizontal sharding? → PlanetScale                   │
│  ├── Need global low-latency? → Neon (multi-region)           │
│  └── Need event streaming at scale? → Kafka                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Database Migrations

### Supabase → Neon (Recommended Path)

**Why Neon?**

- Same PostgreSQL - **schema compatible, no code changes**
- Auto-scaling compute (scale to zero, scale up on demand)
- Database branching for development/staging
- Multi-region support for global apps

**Compatibility**: ✅ High (both PostgreSQL 15+)

#### Migration Strategy: Logical Replication

```mermaid
sequenceDiagram
    participant App as Application
    participant Supa as Supabase (Source)
    participant Neon as Neon (Target)

    Note over Supa,Neon: PHASE 1: Setup
    Supa->>Neon: pg_dump schema (no data)
    Note over Neon: Create tables, indexes, etc.

    Note over Supa,Neon: PHASE 2: Initial Sync
    Supa->>Neon: pg_dump data (large tables)
    Note over Neon: pg_restore data

    Note over Supa,Neon: PHASE 3: Catch-up
    Supa->>Neon: Logical replication (CDC)
    Note over Supa,Neon: Changes stream in real-time

    Note over App,Neon: PHASE 4: Cutover
    App->>App: Enable read from Neon
    App->>App: Verify data integrity
    App->>App: Switch writes to Neon
    App->>App: Disable Supabase
```

#### Step-by-Step Process

```bash
# PHASE 1: Export schema from Supabase
pg_dump --schema-only \
  "postgres://user:pass@db.xxx.supabase.co:5432/postgres" \
  > schema.sql

# Import to Neon
psql "postgres://user:pass@xxx.neon.tech/neondb" < schema.sql

# PHASE 2: Initial data sync (for large tables, do in batches)
pg_dump --data-only --table=users \
  "postgres://user:pass@db.xxx.supabase.co:5432/postgres" \
  | psql "postgres://user:pass@xxx.neon.tech/neondb"

# PHASE 3: Enable logical replication for catch-up
# (Requires Supabase Pro for wal_level=logical)
```

#### Application Code Changes

```typescript
// lib/prisma.ts - Feature flag approach
const DATABASE_URL =
  process.env.USE_NEON === "true"
    ? process.env.NEON_DATABASE_URL
    : process.env.SUPABASE_DATABASE_URL;

const prisma = new PrismaClient({
  datasources: {
    db: { url: DATABASE_URL },
  },
});
```

#### Rollback Plan

```typescript
// Instant rollback via environment variable
// In Vercel/deployment platform:
// 1. Set USE_NEON=false
// 2. Redeploy (or use edge config for instant)

// If data diverged during Neon usage:
// 1. Export Neon changes: pg_dump --data-only
// 2. Apply to Supabase
// 3. Switch back
```

---

### Supabase → PlanetScale (Complex Path)

**Why PlanetScale?**

- Horizontal sharding built-in (Vitess)
- Handles 10M+ concurrent users
- Zero-downtime schema changes

**Compatibility**: ⚠️ Low (PostgreSQL → MySQL)

| PostgreSQL                 | PlanetScale/MySQL                    |
| -------------------------- | ------------------------------------ |
| `SERIAL`                   | `AUTO_INCREMENT`                     |
| `JSONB`                    | `JSON`                               |
| `UUID`                     | `CHAR(36)` or `BINARY(16)`           |
| `TIMESTAMP WITH TIME ZONE` | `DATETIME`                           |
| Foreign keys               | ❌ Not supported (application-level) |
| Arrays                     | ❌ Not supported (use JSON)          |

#### Migration Strategy: Dual-Write Pattern

Since schema differs significantly, use dual-write to ensure data consistency:

```mermaid
flowchart TD
    subgraph "Phase 1: Shadow Writes"
        APP[Application] --> SUPA[(Supabase)]
        APP --> |"Async Shadow"| PS[(PlanetScale)]
        SUPA --> |"Primary"| READ[Read Results]
    end

    subgraph "Phase 2: Validation"
        COMPARE[Compare Data] --> |"Match?"| READY[Ready for Cutover]
        COMPARE --> |"Mismatch"| FIX[Fix & Retry]
    end

    subgraph "Phase 3: Cutover"
        APP2[Application] --> PS2[(PlanetScale)]
        PS2 --> |"Primary"| READ2[Read Results]
        APP2 -.-> |"Shadow (reverse)"| SUPA2[(Supabase)]
    end
```

#### Dual-Write Implementation

```typescript
// lib/db/dual-write.ts
import { PrismaClient as SupabasePrisma } from "@prisma/supabase";
import { PrismaClient as PlanetScalePrisma } from "@prisma/planetscale";

const supabase = new SupabasePrisma();
const planetscale = new PlanetScalePrisma();

const MIGRATION_PHASE = process.env.MIGRATION_PHASE || "supabase-primary";

export async function createUser(data: UserCreateInput) {
  switch (MIGRATION_PHASE) {
    case "supabase-primary":
      // Supabase is source of truth, shadow to PlanetScale
      const user = await supabase.user.create({ data });

      // Async shadow write (don't await, don't fail on error)
      planetscale.user
        .create({ data: transformForMySQL(data) })
        .catch((err) => console.error("Shadow write failed:", err));

      return user;

    case "planetscale-primary":
      // PlanetScale is source of truth
      return planetscale.user.create({ data: transformForMySQL(data) });

    case "dual-verify":
      // Write to both, verify consistency
      const [supaResult, psResult] = await Promise.all([
        supabase.user.create({ data }),
        planetscale.user.create({ data: transformForMySQL(data) }),
      ]);

      // Log any discrepancies
      verifyConsistency(supaResult, psResult);

      return supaResult;
  }
}

function transformForMySQL(data: any) {
  return {
    ...data,
    // Convert PostgreSQL types to MySQL
    id: data.id, // UUID stays as string
    metadata: JSON.stringify(data.metadata), // JSONB → JSON string
    tags: JSON.stringify(data.tags), // Array → JSON
  };
}
```

#### Foreign Key Enforcement (Application-Level)

```typescript
// Since PlanetScale doesn't support FK constraints
// Enforce at application level

export async function createAppointment(data: AppointmentInput) {
  // Verify foreign keys exist before insert
  const [user, consultant] = await Promise.all([
    planetscale.user.findUnique({ where: { id: data.userId } }),
    planetscale.consultant.findUnique({ where: { id: data.consultantId } }),
  ]);

  if (!user) throw new Error("User not found");
  if (!consultant) throw new Error("Consultant not found");

  return planetscale.appointment.create({ data });
}

// For deletes, handle cascades manually
export async function deleteUser(userId: string) {
  // Delete in correct order (children first)
  await planetscale.$transaction([
    planetscale.appointment.deleteMany({ where: { userId } }),
    planetscale.payment.deleteMany({ where: { userId } }),
    planetscale.user.delete({ where: { id: userId } }),
  ]);
}
```

---

## Zero-Downtime Migration Patterns

### Pattern 1: Blue-Green Deployment

Best for: **Database upgrades, same-provider migrations**

```mermaid
flowchart LR
    subgraph "Before Cutover"
        LB[Load Balancer] --> BLUE[Blue Environment<br/>Current Production]
        GREEN[Green Environment<br/>New Version] --> |"Sync"| BLUE
    end

    subgraph "During Cutover"
        LB2[Load Balancer] --> |"Switch"| GREEN2[Green Environment<br/>New Production]
        BLUE2[Blue Environment<br/>Standby] --> |"Ready for rollback"| LB2
    end
```

**Implementation with Vercel:**

```typescript
// vercel.json
{
  "env": {
    "DATABASE_URL": "@database-url-blue"
  }
}

// To switch:
// 1. Update environment variable to green
// 2. Redeploy
// 3. Instant cutover (previous deployment available for rollback)
```

### Pattern 2: Shadow Writes (Dual-Write)

Best for: **Cross-provider migrations, schema changes**

```typescript
// middleware/dual-write.ts
export function createDualWriteMiddleware(config: {
  primary: PrismaClient;
  secondary: PrismaClient;
  transform?: (data: any) => any;
}) {
  return {
    async create(model: string, data: any) {
      // Primary write (must succeed)
      const result = await config.primary[model].create({ data });

      // Secondary write (async, fire-and-forget)
      const transformedData = config.transform?.(data) ?? data;
      config.secondary[model].create({ data: transformedData }).catch((err) => {
        // Log to monitoring, don't fail the request
        logger.error("Secondary write failed", { model, err });
        metrics.increment("dual_write.secondary_failure");
      });

      return result;
    },
  };
}
```

### Pattern 3: Change Data Capture (CDC)

Best for: **Large-scale migrations, minimal application changes**

```mermaid
flowchart LR
    SOURCE[(Source DB)] --> CDC[CDC Tool<br/>Debezium/DMS]
    CDC --> KAFKA[Kafka/Kinesis]
    KAFKA --> CONSUMER[Consumer]
    CONSUMER --> TARGET[(Target DB)]

    APP[Application] --> SOURCE
    APP -.-> |"After cutover"| TARGET
```

**Tools:**

- AWS DMS (Database Migration Service)
- Debezium (open source)
- Airbyte
- Fivetran

---

## Event Streaming Migrations

### Redis/BullMQ → Upstash Kafka

**When to migrate:**

- Current: BullMQ handles ~10K jobs/minute
- Trigger: Need 100K+ events/second, multiple consumers, event replay

```typescript
// Phase 1: Dual-publish to both systems
import { Queue } from "bullmq";
import { Kafka } from "@upstash/kafka";

const bullQueue = new Queue("payments");
const kafka = new Kafka({
  url: process.env.UPSTASH_KAFKA_REST_URL,
  username: process.env.UPSTASH_KAFKA_REST_USERNAME,
  password: process.env.UPSTASH_KAFKA_REST_PASSWORD,
});

export async function publishPaymentEvent(event: PaymentEvent) {
  const phase = process.env.KAFKA_MIGRATION_PHASE;

  if (phase === "bullmq-primary" || phase === "dual") {
    await bullQueue.add("payment", event);
  }

  if (phase === "kafka-primary" || phase === "dual") {
    await kafka.producer().produce("payments", JSON.stringify(event));
  }
}

// Phase 2: Migrate consumers one by one
// Phase 3: Switch to Kafka-only, decommission BullMQ
```

---

## Migration Checklist

### Pre-Migration

```markdown
- [ ] **Backup verification**
  - [ ] Full database backup exists
  - [ ] Backup restore tested in staging
  - [ ] Point-in-time recovery window confirmed

- [ ] **Schema compatibility**
  - [ ] Target schema created and verified
  - [ ] Data type mappings documented
  - [ ] Indexes recreated on target

- [ ] **Application preparation**
  - [ ] Feature flags implemented
  - [ ] Dual-write code deployed (if applicable)
  - [ ] Connection strings parameterized

- [ ] **Monitoring setup**
  - [ ] Error rate alerts configured
  - [ ] Latency monitoring enabled
  - [ ] Data integrity checks automated
```

### During Migration

```markdown
- [ ] **Communication**
  - [ ] Team notified of migration window
  - [ ] Status page updated (if applicable)
  - [ ] On-call engineer assigned

- [ ] **Execution**
  - [ ] Initial data sync completed
  - [ ] Replication lag acceptable (<1 minute)
  - [ ] Shadow writes verified
  - [ ] Read traffic shifted (canary)
  - [ ] Write traffic shifted

- [ ] **Verification**
  - [ ] Data counts match
  - [ ] Sample records verified
  - [ ] Critical paths tested
```

### Post-Migration

```markdown
- [ ] **Cleanup**
  - [ ] Old connections removed
  - [ ] Feature flags cleaned up
  - [ ] Dual-write code removed
  - [ ] Old infrastructure decommissioned

- [ ] **Documentation**
  - [ ] Runbook updated
  - [ ] Connection strings documented
  - [ ] Incident report (if any issues)
```

---

## Rollback Strategies

### Instant Rollback (Feature Flags)

```typescript
// Using Vercel Edge Config for instant rollback
import { get } from "@vercel/edge-config";

export async function getDatabaseUrl() {
  const useNewDb = await get("use_new_database");

  return useNewDb ? process.env.NEW_DATABASE_URL : process.env.OLD_DATABASE_URL;
}

// Rollback: Update edge config, instant effect
// No redeploy needed
```

### Data Sync During Rollback

If data was written to new DB during migration:

```bash
# 1. Stop writes to new DB (feature flag)

# 2. Export delta from new DB
pg_dump --data-only \
  --table=users \
  --where="updated_at > '2025-01-15 00:00:00'" \
  new_db > delta.sql

# 3. Apply to old DB
psql old_db < delta.sql

# 4. Switch back to old DB
```

### Rollback Decision Matrix

| Scenario               | Action                                         |
| ---------------------- | ---------------------------------------------- |
| Error rate >1%         | Immediate rollback                             |
| Latency >2x baseline   | Investigate, rollback if not resolved in 15min |
| Data mismatch detected | Pause migration, investigate                   |
| Single user affected   | Fix forward if possible                        |

---

## Post-Migration Verification

### Data Integrity Checks

```typescript
// scripts/verify-migration.ts
async function verifyMigration() {
  const checks = [
    // Row counts
    {
      name: "User count",
      source: () => sourceDb.user.count(),
      target: () => targetDb.user.count(),
    },
    // Sample records
    {
      name: "Random user data",
      source: () => sourceDb.user.findFirst({ orderBy: { id: "desc" } }),
      target: () => targetDb.user.findFirst({ orderBy: { id: "desc" } }),
      compare: (a, b) => a.email === b.email && a.name === b.name,
    },
    // Aggregate checks
    {
      name: "Payment totals",
      source: () => sourceDb.payment.aggregate({ _sum: { amount: true } }),
      target: () => targetDb.payment.aggregate({ _sum: { amount: true } }),
    },
  ];

  for (const check of checks) {
    const [sourceResult, targetResult] = await Promise.all([
      check.source(),
      check.target(),
    ]);

    const match = check.compare
      ? check.compare(sourceResult, targetResult)
      : JSON.stringify(sourceResult) === JSON.stringify(targetResult);

    console.log(`${check.name}: ${match ? "✅" : "❌"}`);
    if (!match) {
      console.log("  Source:", sourceResult);
      console.log("  Target:", targetResult);
    }
  }
}
```

### Performance Comparison

```typescript
// Compare query performance before/after
const queries = [
  { name: "Dashboard load", fn: () => getDashboardData(userId) },
  { name: "Appointments list", fn: () => getAppointments(consultantId) },
  { name: "Payment history", fn: () => getPayments(userId, 100) },
];

for (const query of queries) {
  const start = performance.now();
  await query.fn();
  const duration = performance.now() - start;

  console.log(`${query.name}: ${duration.toFixed(2)}ms`);
}
```

---

## Related Documentation

- [Real-Time Caching Strategy](./realtime-caching-strategy.md) - Current caching architecture
- [Dashboard Prefetching](../../performance/02-dashboard-prefetching.md) - Client-side optimization
- [Scaling Assessment](../../tasks/scale.txt) - When to consider scaling
