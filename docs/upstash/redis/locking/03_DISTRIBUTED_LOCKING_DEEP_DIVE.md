# Distributed Locking & Race Condition Prevention: A Complete Guide

> **Audience:** New developers joining the team
> **Last Updated:** November 2025
> **Prerequisites:** Basic understanding of databases, HTTP requests, and async programming

---

## Table of Contents

1. [Introduction: Why We Need Locking](#1-introduction-why-we-need-locking)
2. [Race Conditions Explained](#2-race-conditions-explained)
3. [The TOCTOU Problem](#3-the-toctou-problem-time-of-check-to-time-of-use)
4. [Distributed Locking Fundamentals](#4-distributed-locking-fundamentals)
5. [Redis-Based Locking](#5-redis-based-locking)
6. [Lock TTL (Time-To-Live)](#6-lock-ttl-time-to-live)
7. [Our Implementation Architecture](#7-our-implementation-architecture)
8. [The Tentative Appointment Pattern](#8-the-tentative-appointment-pattern)
9. [Handling Lock Failures](#9-handling-lock-failures)
10. [Testing Race Conditions](#10-testing-race-conditions)
11. [Common Pitfalls](#11-common-pitfalls)
12. [Glossary](#12-glossary)

---

## 1. Introduction: Why We Need Locking

### The Problem: Double-Booking

Imagine this scenario:

```
Timeline:
=========
T=0ms    User A clicks "Book 10:00 AM slot"
T=5ms    User B clicks "Book 10:00 AM slot"
T=10ms   Server A checks: "Is 10:00 AM available?" → YES ✓
T=15ms   Server B checks: "Is 10:00 AM available?" → YES ✓
T=20ms   Server A creates booking for User A
T=25ms   Server B creates booking for User B
T=30ms   Result: TWO bookings for the SAME slot! 💥
```

This is called a **race condition** - two processes "racing" to complete an operation, with unpredictable results.

### Real-World Impact

For our platform with millions of users worldwide:

- **Consultants** get double-booked, damaging trust
- **Users** pay for slots that get cancelled
- **Support** gets overwhelmed with complaints
- **Revenue** lost to refunds and chargebacks

### The Solution: Distributed Locking

We use **distributed locks** to ensure only ONE user can book a specific slot at a time:

```
Timeline WITH Locking:
======================
T=0ms    User A clicks "Book 10:00 AM slot"
T=5ms    User B clicks "Book 10:00 AM slot"
T=10ms   Server A acquires lock for "10:00 AM" → SUCCESS 🔒
T=15ms   Server B tries to acquire lock → WAITING... ⏳
T=20ms   Server A checks availability → YES ✓
T=25ms   Server A creates booking
T=30ms   Server A releases lock 🔓
T=35ms   Server B acquires lock → SUCCESS 🔒
T=40ms   Server B checks availability → NO (User A booked it)
T=45ms   Server B releases lock, returns error to User B
T=50ms   Result: Only ONE booking exists ✓
```

---

## 2. Race Conditions Explained

### Definition

A **race condition** occurs when:

1. Two or more processes access shared data concurrently
2. At least one process modifies the data
3. The final outcome depends on the timing/order of execution

### Types of Race Conditions

#### 2.1 Read-Modify-Write Race

```typescript
// DANGEROUS: Both users might read count=0
let count = await db.getParticipantCount(webinarId); // Read
if (count < maxParticipants) {
  await db.addParticipant(userId); // Write
  await db.setParticipantCount(count + 1); // Modify
}
```

**What goes wrong:**

```
User A reads count=99, checks 99 < 100 ✓
User B reads count=99, checks 99 < 100 ✓
User A writes count=100
User B writes count=100 (should be 101!)
Result: 101 participants but count shows 100
```

#### 2.2 Check-Then-Act Race (TOCTOU)

```typescript
// DANGEROUS: Slot might be taken between check and act
const isAvailable = await checkSlotAvailability(slotId); // Check
if (isAvailable) {
  await createBooking(slotId, userId); // Act
}
```

**What goes wrong:**

```
User A checks slot → available
User B checks slot → available
User A creates booking → success
User B creates booking → success (DUPLICATE!)
```

#### 2.3 Lost Update Race

```typescript
// DANGEROUS: User B's read happens before A's write commits
const appointment = await db.getAppointment(id);
appointment.notes = "Updated by User A";
await db.saveAppointment(appointment);
```

**What goes wrong:**

```
User A reads appointment (notes="original")
User B reads appointment (notes="original")
User A saves (notes="Updated by A")
User B saves (notes="Updated by B")
Result: User A's update is lost!
```

---

## 3. The TOCTOU Problem (Time-Of-Check to Time-Of-Use)

### What is TOCTOU?

TOCTOU is a specific type of race condition where:

1. A condition is **checked** (Time of Check)
2. The result is **used** to make a decision (Time of Use)
3. The condition **changes** between these two moments

### Visual Representation

```
                    ┌─────────────────────────────────────┐
                    │         THE TOCTOU WINDOW           │
                    │   (Danger zone for race conditions) │
                    └─────────────────────────────────────┘
                                    ↓
Timeline:   ────[CHECK]───────────────────────────[USE]────
                  │                                   │
                  │    ← Condition can change here →  │
                  │                                   │
              Slot is                            Create
              available?                         booking
```

### TOCTOU in Our System

```typescript
// ❌ VULNERABLE TO TOCTOU
async function checkoutSlot(slotId: string, userId: string) {
  // TIME OF CHECK
  const slot = await db.slot.findUnique({ where: { id: slotId } });
  if (slot.isBooked) {
    throw new Error("Slot already booked");
  }

  // ← TOCTOU WINDOW: Another user could book here!

  // TIME OF USE
  await db.slot.update({
    where: { id: slotId },
    data: { isBooked: true, userId },
  });
}
```

### How We Prevent TOCTOU

We use **distributed locks** to eliminate the TOCTOU window:

```typescript
// ✅ TOCTOU-SAFE
async function checkoutSlot(slotId: string, userId: string) {
  // ACQUIRE LOCK - Creates exclusive access
  const lock = await acquireLock(`slot:${slotId}`);

  try {
    // TIME OF CHECK (inside lock - no one else can check)
    const slot = await db.slot.findUnique({ where: { id: slotId } });
    if (slot.isBooked) {
      throw new Error("Slot already booked");
    }

    // No TOCTOU window - we hold the lock!

    // TIME OF USE (still inside lock)
    await db.slot.update({
      where: { id: slotId },
      data: { isBooked: true, userId },
    });
  } finally {
    // ALWAYS release the lock
    await releaseLock(lock);
  }
}
```

---

## 4. Distributed Locking Fundamentals

### What is a Distributed Lock?

A **distributed lock** is a synchronization mechanism that:

- Works across multiple servers/processes
- Ensures mutual exclusion (only one holder at a time)
- Has a defined lifetime (TTL) to prevent deadlocks
- Can be safely released by the owner

### Why "Distributed"?

In a single-server application, you could use in-memory locks:

```typescript
// Single server - in-memory lock
const locks = new Map<string, boolean>();

function acquireLock(key: string): boolean {
  if (locks.has(key)) return false;
  locks.set(key, true);
  return true;
}
```

But we run **multiple servers** for scalability:

```
                   Load Balancer
                        │
          ┌─────────────┼─────────────┐
          │             │             │
      Server 1      Server 2      Server 3
      (locks: {})   (locks: {})   (locks: {})
          │             │             │
          └─────────────┼─────────────┘
                        │
                   Shared Redis
                   (source of truth)
```

Each server has its own memory - they can't see each other's locks.
We need a **central lock store** (Redis) that all servers can access.

### Lock Properties

A good distributed lock must have:

| Property             | Description                           | Our Implementation |
| -------------------- | ------------------------------------- | ------------------ |
| **Mutual Exclusion** | Only one client can hold the lock     | Redis `SET NX`     |
| **Deadlock Freedom** | Locks must eventually be released     | TTL expiration     |
| **Fault Tolerance**  | System works even if a client crashes | TTL auto-release   |
| **Safe Release**     | Only the owner can release their lock | UUID verification  |

---

## 5. Redis-Based Locking

### Why Redis?

Redis is ideal for distributed locking because:

1. **Atomic operations** - `SET NX` is guaranteed atomic
2. **Fast** - In-memory, sub-millisecond operations
3. **TTL support** - Built-in key expiration
4. **Widely available** - Cloud providers offer managed Redis

### The SET NX Pattern

```
SET key value NX PX milliseconds
```

- `SET key value` - Set the key to value
- `NX` - Only set if key does **N**ot e**X**ist
- `PX milliseconds` - Set expiration in milliseconds

### How It Works

```typescript
// Attempt to acquire lock
const result = await redis.set(
  "slot-lock:consultant123:2025-01-15T10:00", // key
  "uuid-abc-123", // value (unique ID)
  { nx: true, px: 30000 }, // options
);

if (result === "OK") {
  console.log("Lock acquired!");
} else {
  console.log("Lock already held by someone else");
}
```

### Safe Lock Release

**Wrong way** (unsafe):

```typescript
// ❌ UNSAFE - What if lock expired and someone else has it?
await redis.del(lockKey);
```

**Right way** (safe):

```typescript
// ✅ SAFE - Only delete if we still own the lock
const currentValue = await redis.get(lockKey);
if (currentValue === ourLockValue) {
  await redis.del(lockKey);
}
```

**Even better** (atomic - our implementation):

```typescript
// ✅ ATOMIC - Using Lua script (see Issue Fix #3)
const script = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;
await redis.eval(script, [lockKey], [ourLockValue]);
```

---

## 6. Lock TTL (Time-To-Live)

### What is TTL?

TTL is how long a lock remains valid before Redis automatically deletes it.

```typescript
await redis.set(key, value, { px: 30000 }); // 30 second TTL
```

### Why TTL is Critical

Without TTL, locks could become **permanent** if:

- Server crashes while holding lock
- Network partition prevents release
- Bug causes early function return without release

```
Scenario WITHOUT TTL:
=====================
T=0s     Server A acquires lock
T=1s     Server A crashes 💥
T=∞      Lock is held forever - DEADLOCK!
         No one can ever book this slot again!

Scenario WITH TTL (30s):
========================
T=0s     Server A acquires lock (TTL=30s)
T=1s     Server A crashes 💥
T=30s    TTL expires, Redis auto-deletes lock
T=31s    Server B can acquire lock ✓
```

### Choosing TTL Duration

**Too short:**

```
TTL = 5 seconds
Operation takes 7 seconds

T=0s     Acquire lock, start operation
T=5s     TTL expires, lock released automatically!
T=6s     Another user acquires OUR lock
T=7s     We finish and release... but it's not our lock anymore!
         We just released someone else's lock! 💥
```

**Too long:**

```
TTL = 5 minutes
Server crashes at T=1s

T=1s     Server crashes
T=5min   Finally unlocked
         Users waited 5 minutes for nothing
```

**Just right:**
For our checkout operations:

- Average operation: 2-5 seconds
- Worst case (slow DB): 15-20 seconds
- **Recommended TTL: 60 seconds** (3x worst case)

### TTL Extension (Heartbeat)

For long-running operations, we can extend the TTL:

```typescript
async function withLockExtension(operation: () => Promise<void>) {
  const lock = await acquireLock(key, 30000); // 30s initial

  // Extend every 10 seconds while operation runs
  const extensionInterval = setInterval(async () => {
    await extendLock(lock, 30000); // Reset to 30s
  }, 10000);

  try {
    await operation();
  } finally {
    clearInterval(extensionInterval);
    await releaseLock(lock);
  }
}
```

---

## 7. Our Implementation Architecture

### Three Layers of Protection

```
┌─────────────────────────────────────────────────────────────┐
│                    LAYER 1: Client-Side                      │
│  • Double-click prevention (isCheckoutProcessing state)      │
│  • Button disabled during processing                         │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    LAYER 2: Distributed Lock                 │
│  • Redis-based exclusive access                              │
│  • Prevents concurrent server-side processing                │
│  • Retry with exponential backoff                            │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    LAYER 3: Database Validation              │
│  • Tentative appointment creation                            │
│  • Re-validation inside lock (TOCTOU prevention)             │
│  • Transaction isolation                                     │
└─────────────────────────────────────────────────────────────┘
```

### Lock Types in Our System

| Lock Type      | Key Pattern                              | Use Case              | TTL |
| -------------- | ---------------------------------------- | --------------------- | --- |
| Slot Booking   | `slot-booking:{consultantId}:{slotTime}` | 1:1 consultations     | 60s |
| Event Checkout | `event-checkout:{type}:{eventId}`        | Webinars, Classes     | Per-type via `CHECKOUT_LOCK_TTL_MS` (#832): CONSULTATION 60s / SUBSCRIPTION 120s / WEBINAR 120s / CLASS 300s |
| Auto-Allocate  | `auto-allocate:{consultantProfileId}`    | Auto-allocation (consultant-level; NOT narrowed per slot — #860) | 150s |
| Approval       | `consultation-approval:{consultationId}` | Request approval      | 60s |
| Subscription   | `subscription-approval:{subscriptionId}` | Subscription approval | 60s |
| Payout Batch   | `lock:payout_batch_creation`             | Consultant payout batch cron | 2min |
| Payout Process | `lock:payout_processing`                 | Consultant payout disbursement | 5min |
| Org Payout Batch | `org:{orgId}:payout-batch`             | Per-org payout batch creation | 60s |

### Code Flow

```typescript
// Simplified checkout flow
async function handleCheckout(data, userId) {
  // 1. Early validation (outside lock - optimization)
  const { amount, currency } = await calculateAmountAndValidate(data, userId);

  // 2. Acquire distributed lock
  const lock = await acquireCheckoutLock(data);

  try {
    // 3. Re-validate INSIDE lock (prevents TOCTOU)
    await revalidateInsideLock(data, userId);

    // 4. Create payment intent
    const paymentIntent = await createPaymentIntent({ amount, currency });

    // 5. Create tentative appointment (visible to other validations)
    const appointment = await createTentativeAppointment(data);

    // 6. Link payment to appointment
    await createPaymentRecord(paymentIntent, appointment);

    return { success: true, paymentIntent };
  } finally {
    // 7. ALWAYS release lock
    await releaseLock(lock);
  }
}
```

---

## 8. The Tentative Appointment Pattern

### The Problem with Payment-First Approach

**Old approach (vulnerable):**

```
User A checkout → Create payment → (webhook later creates appointment)
User B checkout → Create payment → (webhook later creates appointment)

Problem: Both payments created because validation doesn't see pending payments!
```

**Why it fails:**

- Validation checks `SlotOfAppointment` table
- Payments are in `Payment` table
- No connection until webhook fires
- Race window between payment creation and appointment creation

### The Tentative Appointment Solution

**New approach (safe):**

```
User A checkout:
1. Acquire lock
2. Validate (no appointments exist)
3. Create TENTATIVE appointment (isTentative=true)
4. Create payment linked to appointment
5. Release lock

User B checkout:
1. Acquire lock
2. Validate → SEES tentative appointment!
3. Returns error: "Slot already booked"
4. Release lock
```

### How Tentative Works

```typescript
// Creating tentative appointment
const appointment = await tx.appointment.create({
  data: {
    appointmentType: "CONSULTATION",
    consultationId: consultation.id,
    slotsOfAppointment: {
      create: {
        startsAt: slotStart,
        endsAt: slotEnd,
        isTentative: true, // ← TENTATIVE FLAG
      },
    },
  },
});

// Validation sees tentative appointments
const existingBooking = await tx.slotOfAppointment.findFirst({
  where: {
    startsAt: { lte: slotStart },
    endsAt: { gt: slotStart },
    // Note: We check ALL appointments, including tentative
  },
});
```

### Lifecycle of Tentative Appointments

```
┌──────────────────┐     Payment      ┌──────────────────┐
│    TENTATIVE     │    Succeeds      │    CONFIRMED     │
│  (isTentative:   │ ───────────────► │  (isTentative:   │
│      true)       │                  │      false)      │
└──────────────────┘                  └──────────────────┘
         │
         │ Payment Fails
         │ or Expires
         ▼
┌──────────────────┐
│     DELETED      │
│  (cleanup job    │
│   removes it)    │
└──────────────────┘
```

---

## 9. Handling Lock Failures

### Retry with Exponential Backoff

When a lock is already held, we don't give up immediately:

```typescript
const DEFAULT_RETRY_CONFIG = {
  retryCount: 10, // Try up to 10 times
  retryDelay: 200, // Start with 200ms delay
  retryJitter: 200, // Add random 0-200ms
  exponentialBackoff: true, // Double delay each time
};

// Retry pattern:
// Attempt 1: wait 0ms
// Attempt 2: wait ~400ms (200 * 2^1 + jitter)
// Attempt 3: wait ~800ms (200 * 2^2 + jitter)
// Attempt 4: wait ~1600ms (200 * 2^3 + jitter)
// ... up to 10 attempts
```

### Why Exponential Backoff?

**Without backoff (all retry immediately):**

```
T=0ms    1000 users try to acquire lock
T=1ms    999 users immediately retry
T=2ms    999 users immediately retry again
T=3ms    Redis overwhelmed with requests 💥
```

**With exponential backoff:**

```
T=0ms    1000 users try to acquire lock, 1 succeeds
T=200ms  ~500 users retry (others still waiting)
T=400ms  ~250 users retry
T=800ms  ~125 users retry
         Much more manageable load ✓
```

### Jitter

Adding randomness prevents **thundering herd**:

```
WITHOUT jitter:
T=200ms  All 999 users retry at EXACTLY the same time 💥

WITH jitter (random 0-200ms):
T=200ms  Some users retry
T=250ms  More users retry
T=300ms  More users retry
         Requests spread out ✓
```

### Lock Failure Handling

```typescript
try {
  const lock = await lockSlotBooking(consultantId, slotTime, 60000);
  // ... checkout logic ...
} catch (error) {
  if (error instanceof SlotLockError) {
    // Another user is currently booking
    return {
      error:
        "Another user is currently booking this slot. Please try again in a few seconds.",
      retryAfter: error.retryAfterSeconds,
    };
  }
  throw error;
}
```

---

## 10. Testing Race Conditions

### Unit Testing Locks

```typescript
describe("Distributed Lock", () => {
  it("should prevent concurrent access", async () => {
    const key = "test-lock";

    // First lock should succeed
    const lock1 = await acquireLock(key, 5000);
    expect(lock1).toBeDefined();

    // Second lock should fail (same key)
    await expect(acquireLock(key, 5000)).rejects.toThrow();

    // After release, should succeed again
    await releaseLock(lock1);
    const lock2 = await acquireLock(key, 5000);
    expect(lock2).toBeDefined();
  });
});
```

### Integration Testing Race Conditions

```typescript
describe("Concurrent Checkout", () => {
  it("should allow only one booking for same slot", async () => {
    const slotTime = "2025-01-15T10:00:00Z";

    // Simulate two users checking out simultaneously
    const [resultA, resultB] = await Promise.allSettled([
      handleCheckout({ slot: slotTime, userId: "userA" }),
      handleCheckout({ slot: slotTime, userId: "userB" }),
    ]);

    // Exactly one should succeed
    const successes = [resultA, resultB].filter(
      (r) => r.status === "fulfilled",
    );
    const failures = [resultA, resultB].filter((r) => r.status === "rejected");

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    // Database should have exactly one booking
    const bookings = await db.slotOfAppointment.findMany({
      where: { startsAt: new Date(slotTime) },
    });
    expect(bookings).toHaveLength(1);
  });
});
```

### Load Testing

For production readiness, test with tools like k6:

```javascript
import http from "k6/http";

export const options = {
  vus: 100, // 100 virtual users
  duration: "30s", // for 30 seconds
};

export default function () {
  const payload = JSON.stringify({
    appointmentType: "CONSULTATION",
    startsAt: "2025-01-15T10:00:00Z",
    // ... other fields
  });

  http.post("https://api.example.com/checkout", payload, {
    headers: { "Content-Type": "application/json" },
  });
}
```

---

## 11. Common Pitfalls

### Pitfall 1: Forgetting to Release Locks

```typescript
// ❌ WRONG - Lock never released if error occurs
async function checkout() {
  const lock = await acquireLock(key);
  await riskyOperation(); // If this throws...
  await releaseLock(lock); // ...this never runs!
}

// ✅ CORRECT - Always use try/finally
async function checkout() {
  const lock = await acquireLock(key);
  try {
    await riskyOperation();
  } finally {
    await releaseLock(lock); // Always runs!
  }
}
```

### Pitfall 2: Lock Key Collisions

```typescript
// ❌ WRONG - Same key for different slots
const lock = await acquireLock("slot-lock");

// ✅ CORRECT - Include slot-specific information
const lock = await acquireLock(`slot-lock:${consultantId}:${slotTime}`);
```

### Pitfall 3: Releasing Wrong Lock

```typescript
// ❌ WRONG - Deletes any lock with matching key
await redis.del(lockKey);

// ✅ CORRECT - Only delete if value matches
if ((await redis.get(lockKey)) === ourLockValue) {
  await redis.del(lockKey);
}
```

### Pitfall 4: Validation Outside Lock

```typescript
// ❌ WRONG - TOCTOU vulnerability
const isAvailable = await checkAvailability(slot); // Outside lock
const lock = await acquireLock(key);
if (isAvailable) {
  await createBooking(slot); // Slot might be taken now!
}

// ✅ CORRECT - Validate inside lock
const lock = await acquireLock(key);
try {
  const isAvailable = await checkAvailability(slot); // Inside lock
  if (isAvailable) {
    await createBooking(slot);
  }
} finally {
  await releaseLock(lock);
}
```

### Pitfall 5: Ignoring Lock Acquisition Failures

```typescript
// ❌ WRONG - Continues even if lock fails
const lock = await acquireLock(key).catch(() => null);
await createBooking(slot); // Not protected!

// ✅ CORRECT - Handle lock failure explicitly
try {
  const lock = await acquireLock(key);
  // ... protected operations ...
} catch (error) {
  if (error.message.includes("lock")) {
    return { error: "Please try again in a few seconds" };
  }
  throw error;
}
```

---

## 12. Glossary

| Term                    | Definition                                                                   |
| ----------------------- | ---------------------------------------------------------------------------- |
| **Atomic Operation**    | An operation that completes entirely or not at all - cannot be interrupted   |
| **Circuit Breaker**     | Pattern that stops calling a failing service to prevent cascade failures     |
| **Clock Drift**         | Time differences between servers due to unsynchronized clocks                |
| **Deadlock**            | Situation where two processes wait for each other indefinitely               |
| **Distributed Lock**    | A lock that works across multiple servers using a shared store               |
| **Exponential Backoff** | Retry strategy where wait time doubles after each failure                    |
| **Idempotent**          | Operation that produces same result regardless of how many times it's called |
| **Jitter**              | Random delay added to prevent synchronized retries                           |
| **Mutual Exclusion**    | Guarantee that only one process can access a resource at a time              |
| **Race Condition**      | Bug where outcome depends on timing of concurrent operations                 |
| **Redis**               | In-memory data store used for caching and distributed locking                |
| **Tentative**           | Temporary state indicating a pending/unconfirmed booking                     |
| **TOCTOU**              | Time-Of-Check to Time-Of-Use - race condition between validation and action  |
| **TTL**                 | Time-To-Live - how long before a lock automatically expires                  |

---

## Further Reading

- [Redis Documentation - Distributed Locks](https://redis.io/topics/distlock)
- [Martin Kleppmann - How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)
- [Designing Data-Intensive Applications - Chapter 8](https://dataintensive.net/)
- Our internal docs: `docs/upstash/redis/locking/00_README.md`
