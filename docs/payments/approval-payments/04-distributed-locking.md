# Distributed Locking with Upstash Redis

## Overview

The distributed locking mechanism prevents race conditions when multiple users or API instances attempt to approve the same consultation/subscription simultaneously. We use **Upstash Redis** with the **Redlock algorithm** for reliable distributed locking.

## Why Upstash Redis?

### Advantages

✅ **Serverless**: No infrastructure management required
✅ **REST-based**: Works in serverless environments (Vercel, AWS Lambda)
✅ **Global replication**: Low latency worldwide
✅ **Auto-scaling**: Handles traffic spikes automatically
✅ **Pay-per-request**: Cost-effective for intermittent workloads

### Alternatives Considered

❌ **Local Redis**: Requires server management, not serverless-compatible
❌ **In-memory locks**: Don't work across multiple instances
❌ **Database locks**: Can cause deadlocks, slow performance

## Redlock Algorithm

### How Redlock Works

```
1. Get current time in milliseconds
2. Try to acquire lock with TTL (30 seconds)
3. If acquisition time < TTL, lock is acquired
4. Perform critical section (approval logic)
5. Release lock when done
6. Lock auto-expires if process crashes (safety)
```

### Implementation

```typescript
// utils/appointmentlock.ts
import Redlock from "redlock";
import redis from "@/lib/redis";

// Initialize Redlock with configuration
const redlock = new Redlock([redis], {
  driftFactor: 0.01, // Clock drift tolerance (1%)
  retryCount: 3, // Retry 3 times if lock is held
  retryDelay: 200, // Wait 200ms between retries
  retryJitter: 200, // Add random jitter to prevent thundering herd
  automaticExtensionThreshold: 500, // Extend lock if needed
});

/**
 * Acquire distributed lock for consultation approval
 * Prevents duplicate payment link generation
 */
export async function lockConsultationApproval(
  consultationId: string,
  ttl: number = 30000, // 30 seconds
) {
  try {
    const lock = await redlock.acquire(
      [`consultation-approval:${consultationId}`],
      ttl,
    );
    return lock;
  } catch (error) {
    console.error(
      `Failed to acquire lock for consultation ${consultationId}:`,
      error,
    );
    throw new Error(
      "Another approval is in progress for this consultation. Please try again.",
    );
  }
}

/**
 * Acquire distributed lock for subscription approval
 */
export async function lockSubscriptionApproval(
  subscriptionId: string,
  ttl: number = 30000,
) {
  try {
    const lock = await redlock.acquire(
      [`subscription-approval:${subscriptionId}`],
      ttl,
    );
    return lock;
  } catch (error) {
    console.error(
      `Failed to acquire lock for subscription ${subscriptionId}:`,
      error,
    );
    throw new Error(
      "Another approval is in progress for this subscription. Please try again.",
    );
  }
}

/**
 * Release distributed lock
 * Always call this in a finally block
 */
export async function unlockApproval(lock: any) {
  try {
    await lock.release();
  } catch (error) {
    console.error("Failed to release approval lock:", error);
    // Don't throw - lock will expire anyway based on TTL
  }
}
```

## Lock Key Naming Convention

```
Format: {resource-type}-approval:{resource-id}

Examples:
- consultation-approval:clx123abc
- subscription-approval:clx456def
```

### Why This Format?

- **Namespaced**: Prevents collisions with other locks
- **Descriptive**: Easy to debug in Redis console
- **Unique**: One lock per resource instance

## Lock TTL (Time-To-Live)

### Default: 30 Seconds

**Reasoning**:

- Approval endpoint typically completes in 1-3 seconds
- 30 seconds provides buffer for slow database queries
- Prevents indefinite lock if process crashes
- Long enough to prevent premature expiry
- Short enough to recover quickly from failures

### TTL Scenarios

#### Normal Operation (Lock Released)

```
T0    Acquire lock (TTL: 30s)
T1    Execute approval logic (2s)
T2    Release lock explicitly
      ✅ Lock released at 2s (not 30s)
```

#### Process Crash (Auto-Expiry)

```
T0    Acquire lock (TTL: 30s)
T1    Process crashes 💥
T30   Lock expires automatically
      ✅ System recovers, lock available
```

#### Retry Scenario (Lock Held)

```
T0    User A: Acquire lock ✓
T0.5  User B: Attempt lock (WAIT)
T0.7  User B: Retry 1 (200ms delay)
T0.9  User B: Retry 2 (200ms delay)
T1.1  User B: Retry 3 (200ms delay)
T1.3  User B: Give up, return 409 Conflict
T2    User A: Release lock
      ✅ Lock available for next attempt
```

## Error Handling

### Lock Acquisition Failure

```typescript
// Approval endpoint
let lock;
if (status === AppointmentStatus.APPROVED) {
  try {
    lock = await lockConsultationApproval(consultationId, 30000);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to acquire lock",
      },
      { status: 409 }, // HTTP 409 Conflict
    );
  }
}
```

### Lock Release Failure

```typescript
// Always release in finally block
try {
  // ... approval logic ...
} finally {
  if (lock) {
    await unlockApproval(lock); // Won't throw
  }
}
```

## Monitoring Lock Health

### Redis Console (Upstash)

```bash
# View active locks
KEYS *-approval:*

# Check lock TTL
TTL consultation-approval:clx123abc

# Manual unlock (emergency only)
DEL consultation-approval:clx123abc
```

### Application Logs

```typescript
console.log(`🔒 Acquired lock for consultation ${consultationId}`);
console.log(`🔓 Released lock for consultation ${consultationId}`);
console.error(`❌ Failed to acquire lock: ${error.message}`);
```

## Performance Characteristics

### Latency Breakdown

```
Lock Acquisition:
├─ Network RTT to Upstash: 20-50ms (depends on region)
├─ Redis SET operation: 1-5ms
├─ Retry logic (if needed): 200ms per retry
└─ Total: 50-100ms (typical), up to 800ms (worst case with retries)

Lock Release:
├─ Network RTT to Upstash: 20-50ms
├─ Redis DEL operation: 1-5ms
└─ Total: 30-60ms (typical)
```

### Throughput Limits

- **Upstash Free Tier**: 10,000 commands/day
- **Upstash Pro Tier**: Unlimited commands
- **Lock Duration**: 30 seconds max
- **Concurrent Locks**: Unlimited (one per resource)

## Testing Lock Behavior

### Unit Test: Lock Acquisition

```typescript
import {
  lockConsultationApproval,
  unlockApproval,
} from "@/utils/appointmentlock";

describe("Distributed Locking", () => {
  it("should acquire and release lock successfully", async () => {
    const consultationId = "test-consultation-123";

    const lock = await lockConsultationApproval(consultationId, 5000);
    expect(lock).toBeDefined();

    await unlockApproval(lock);
    // Lock should be released, next acquisition should succeed

    const lock2 = await lockConsultationApproval(consultationId, 5000);
    expect(lock2).toBeDefined();
    await unlockApproval(lock2);
  });

  it("should fail to acquire lock when already held", async () => {
    const consultationId = "test-consultation-456";

    const lock1 = await lockConsultationApproval(consultationId, 5000);

    // Second acquisition should fail
    await expect(lockConsultationApproval(consultationId, 100)).rejects.toThrow(
      "Another approval is in progress",
    );

    await unlockApproval(lock1);
  });

  it("should auto-expire after TTL", async () => {
    const consultationId = "test-consultation-789";

    await lockConsultationApproval(consultationId, 1000); // 1 second TTL
    // Don't release - let it expire

    await new Promise((resolve) => setTimeout(resolve, 1500)); // Wait 1.5s

    // Lock should be expired, acquisition should succeed
    const lock2 = await lockConsultationApproval(consultationId, 5000);
    expect(lock2).toBeDefined();
    await unlockApproval(lock2);
  });
});
```

### Integration Test: Concurrent Approvals

```typescript
describe("Concurrent Approval Protection", () => {
  it("should prevent duplicate payment links", async () => {
    const consultationId = "test-consultation-concurrent";

    // Simulate two users clicking approve simultaneously
    const approvalPromises = [
      fetch(`/api/bookings/consultations/${consultationId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "APPROVED" }),
      }),
      fetch(`/api/bookings/consultations/${consultationId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "APPROVED" }),
      }),
    ];

    const [response1, response2] = await Promise.all(approvalPromises);

    // One should succeed, one should return 409 Conflict or duplicate=true
    const results = await Promise.all([response1.json(), response2.json()]);

    const successCount = results.filter((r) => !r.duplicate && !r.error).length;
    expect(successCount).toBe(1); // Only one success
  });
});
```

## Troubleshooting

### Problem: Lock acquisition always fails

**Symptoms**: All approval requests return 409 Conflict

**Possible Causes**:

1. Upstash Redis credentials incorrect
2. Network connectivity issues
3. Redis instance down
4. Previous lock not released (rare with auto-expiry)

**Solution**:

```bash
# Check Redis connection
curl -X POST https://your-redis.upstash.io/get/test-key \
  -H "Authorization: Bearer YOUR_TOKEN"

# Check active locks
curl -X POST https://your-redis.upstash.io/keys/*-approval:* \
  -H "Authorization: Bearer YOUR_TOKEN"

# Clear stuck locks (emergency)
curl -X POST https://your-redis.upstash.io/flushall \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Problem: Slow approval requests

**Symptoms**: Approval takes >5 seconds

**Possible Causes**:

1. Lock acquisition retries (contention)
2. High network latency to Upstash
3. Database transaction timeout
4. Email sending delay

**Solution**:

```typescript
// Add timing logs
const startTime = Date.now();
const lock = await lockConsultationApproval(consultationId);
console.log(`Lock acquired in ${Date.now() - startTime}ms`);

const txStart = Date.now();
await prisma.$transaction(...);
console.log(`Transaction completed in ${Date.now() - txStart}ms`);
```

### Problem: Lock never released

**Symptoms**: Subsequent approvals fail even after waiting

**Possible Causes**:

1. Exception thrown before finally block
2. Process crash without finally execution
3. Network timeout during release

**Solution**:

- Locks auto-expire after 30 seconds
- Wait 30 seconds and retry
- Check Upstash console for stuck locks
- Verify finally block is always executed

## Best Practices

### ✅ DO

1. **Always use try-finally** to release locks

```typescript
let lock;
try {
  lock = await lockConsultationApproval(id);
  // ... critical section ...
} finally {
  if (lock) await unlockApproval(lock);
}
```

2. **Set appropriate TTL** based on expected duration

```typescript
// Fast operation: 5 seconds
lock = await lockConsultationApproval(id, 5000);

// Complex operation: 30 seconds
lock = await lockConsultationApproval(id, 30000);
```

3. **Return meaningful errors** to users

```typescript
catch (error) {
  return NextResponse.json(
    { error: "Another approval in progress. Please wait." },
    { status: 409 }
  );
}
```

### ❌ DON'T

1. **Don't use locks for non-critical sections**

```typescript
// ❌ Bad: Locking read-only operations
lock = await lockConsultationApproval(id);
const consultation = await prisma.consultation.findUnique(...);

// ✅ Good: Only lock approval mutations
if (status === AppointmentStatus.APPROVED) {
  lock = await lockConsultationApproval(id);
}
```

2. **Don't forget error handling**

```typescript
// ❌ Bad: Throws error to user
const lock = await lockConsultationApproval(id);

// ✅ Good: Catch and return 409
try {
  lock = await lockConsultationApproval(id);
} catch (error) {
  return NextResponse.json({ error }, { status: 409 });
}
```

3. **Don't set infinite TTL**

```typescript
// ❌ Bad: Lock never expires
lock = await lockConsultationApproval(id, Infinity);

// ✅ Good: Set reasonable TTL
lock = await lockConsultationApproval(id, 30000);
```

## Configuration Reference

### Environment Variables

```bash
# Required for distributed locking
UPSTASH_REDIS_REST_URL=https://your-redis.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_token_here
```

### Redlock Configuration

```typescript
const redlock = new Redlock([redis], {
  driftFactor: 0.01, // Max clock drift (1%)
  retryCount: 3, // Retry attempts
  retryDelay: 200, // Base retry delay (ms)
  retryJitter: 200, // Random jitter (ms)
  automaticExtensionThreshold: 500, // Auto-extend threshold
});
```

### Lock Settings

| Setting      | Value   | Reason                            |
| ------------ | ------- | --------------------------------- |
| TTL          | 30000ms | Buffer for slow operations        |
| Retry Count  | 3       | Balance between UX and throughput |
| Retry Delay  | 200ms   | Prevent thundering herd           |
| Retry Jitter | 200ms   | Distribute retry timing           |
