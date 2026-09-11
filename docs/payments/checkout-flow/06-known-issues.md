# Payment System: Known Issues and Fixes

> **Document Type:** Technical Issue Tracker & Fix Guide
> **Last Updated:** November 2025
> **Branch:** `fix/payment-algorithm-2b`
> **Status:** Issues identified, fixes implemented

---

> **Superseded (2026-09-03):** every issue below was fixed on the `fix/payment-algorithm-2b` branch that shipped in November 2025, and the locking/validation code it fixed has since been replaced outright — by the interval-atom `slot-booking:` locks in `utils/appointmentlock.ts`, the CAS transitions in `lib/booking/transitions.ts`, and the bounded request-path retry budgets (`REQUEST_PATH_RETRY_CONFIG`, `CHECKOUT_WAIT_RETRY_CONFIG`). None of the fixes described here describe current code. For the current mechanisms, read [`docs/booking/00-architecture-decisions.md`](../../booking/00-architecture-decisions.md) and [`docs/booking/15-checklist.md`](../../booking/15-checklist.md). Kept for historical context only.

---

## Table of Contents

1. [Overview](#overview)
2. [Critical Issues](#critical-issues)
   - [Issue #1: Validation Before Lock](#issue-1-validation-before-lock-race-window)
   - [Issue #2: Lock TTL Too Short](#issue-2-lock-ttl-too-short)
   - [Issue #3: Non-Atomic Lock Release](#issue-3-non-atomic-lock-release)
   - [Issue #4: Subscription Bypass](#issue-4-subscription-tentative-appointment-bypass)
   - [Issue #5: Event Lock Granularity](#issue-5-event-lock-granularity-too-coarse)
3. [High Priority Issues](#high-priority-issues)
   - [Issue #6: Payment Expiration Mismatch](#issue-6-payment-intent-expiration-mismatch)
   - [Issue #7: Missing Retry Limit](#issue-7-missing-retry-limit-on-validation)
   - [Issue #8: Silent Metadata Failures](#issue-8-webhook-metadata-validation-silent-failures)
   - [Issue #9: Default Isolation Level](#issue-9-slotvalidationservice-default-isolation)
   - [Issue #10: Cleanup Job Race](#issue-10-cleanup-job-race-with-payment-completion)
4. [Medium Priority Issues](#medium-priority-issues)
   - [Issue #11: Hardcoded Slot Duration](#issue-11-hardcoded-slot-duration)
   - [Issue #12: No Redis Circuit Breaker](#issue-12-no-redis-circuit-breaker)
5. [Implementation Status](#implementation-status)

---

## Overview

This document details all identified issues in the payment and checkout system's race condition handling, along with comprehensive fixes. Each issue includes:

- **Problem Description:** What's wrong and why it matters
- **Impact Analysis:** Who is affected and how severe
- **Root Cause:** Technical explanation of the bug
- **Fix Implementation:** Code changes to resolve the issue
- **Testing Strategy:** How to verify the fix works

---

## Critical Issues

### Issue #1: Validation Before Lock (Race Window)

**Severity:** Critical
**Location:** `lib/payments/operations/checkout.ts`

#### Problem Description

Validation happens BEFORE the lock is acquired, creating a time window where race conditions can occur.

```typescript
// Current problematic flow:
const { amount, currency } = await calculateAmountAndValidate(data, userId); // ← Validates HERE
// ... time passes (could be seconds) ...
lock = await acquireCheckoutLock(data, planData); // ← Lock acquired HERE
```

#### Impact Analysis

- **Who:** All users attempting concurrent bookings
- **Severity:** Medium-High (mitigated by re-validation inside lock)
- **Frequency:** Rare, but possible under load

#### Root Cause

The code structure was optimized for performance (validate early, fail fast) but created a TOCTOU window. While `revalidateInsideLock()` catches this, resources are wasted:

1. Payment intent may already be created
2. Database queries were executed unnecessarily
3. User waits longer for the error

#### Fix Implementation

The current implementation is acceptable because `revalidateInsideLock()` provides safety. However, for cleaner error messages, we recommend logging when revalidation catches a race:

```typescript
// In revalidateInsideLock(), add logging:
console.log(
  JSON.stringify({
    event: "checkout_revalidation_caught_race",
    appointmentType: data.appointmentType,
    userId,
    message:
      "Early validation passed but revalidation failed - race condition prevented",
    timestamp: new Date().toISOString(),
  }),
);
```

**Status:** Acceptable as-is (defense-in-depth working correctly)

---

### Issue #2: Lock TTL Too Short

**Severity:** Critical
**Location:** `lib/payments/operations/checkout.ts` and `utils/appointmentlock.ts`

#### Problem Description

The default lock TTL of 30 seconds may expire during slow database operations, especially under high load or network latency.

```typescript
// Current implementation
return await lockSlotBooking(consultantUserId, data.startsAt, 30000); // 30 seconds (renamed from `slotStartTimeInUTC`)
```

#### Impact Analysis

- **Who:** Users during high-traffic periods
- **Severity:** Critical - can cause double bookings
- **Frequency:** Increases with scale and database load

#### Root Cause

30 seconds seemed sufficient for normal operations, but doesn't account for:

- Database connection pool exhaustion
- Network latency spikes
- Complex transaction serialization
- Webhook delays

#### Scenario

```
T=0s     User A acquires lock (TTL=30s)
T=25s    User A still processing (slow DB)
T=30s    Lock expires automatically!
T=31s    User B acquires lock (same slot)
T=32s    User B creates tentative appointment
T=35s    User A's transaction commits → DOUBLE BOOKING
```

#### Fix Implementation

**Change 1:** Increase default TTL to 60 seconds:

```typescript
// utils/appointmentlock.ts - Updated lock functions

export async function lockSlotBooking(
  consultantProfileId: string,
  startsAt: string, // renamed from `slotStartTimeInUTC`
  ttl: number = 60000, // ← Increased from 15000 to 60000
): Promise<ApprovalLock> {
  const key = `slot-booking:${consultantProfileId}:${startsAt}`;
  try {
    return await acquireLockWithRetry(key, ttl);
  } catch (error) {
    throw new SlotLockError(consultantProfileId, startsAt, 60); // ← Updated message
  }
}

export async function lockEventCheckout(
  appointmentType: string,
  eventOrPlanId: string,
  ttl: number = 60000, // ← Increased from 30000 to 60000
): Promise<ApprovalLock> {
  // ... implementation
}
```

**Change 2:** Add lock extension support for long operations:

```typescript
// utils/appointmentlock.ts - New function

/**
 * Extend lock TTL (heartbeat pattern)
 * Call periodically during long operations to prevent expiration
 */
export async function extendLock(
  lock: ApprovalLock,
  additionalTtl: number = 30000,
): Promise<boolean> {
  try {
    const client = lock.client;
    const currentValue = await client.get(lock.key);

    // Only extend if we still own the lock
    if (currentValue === lock.value) {
      await client.pexpire(lock.key, additionalTtl);
      console.log(
        JSON.stringify({
          event: "lock_extended",
          key: lock.key,
          additional_ttl_ms: additionalTtl,
          timestamp: new Date().toISOString(),
        }),
      );
      return true;
    }

    console.warn(
      JSON.stringify({
        event: "lock_extension_failed",
        key: lock.key,
        reason: "lock_ownership_lost",
        timestamp: new Date().toISOString(),
      }),
    );
    return false;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "lock_extension_error",
        key: lock.key,
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
      }),
    );
    return false;
  }
}
```

**Status:** FIXED - TTL increased to 60s, extension function added

---

### Issue #3: Non-Atomic Lock Release

**Severity:** Critical
**Location:** `utils/appointmentlock.ts`

#### Problem Description

The lock release operation uses separate GET and DEL commands, which is not atomic:

```typescript
// CURRENT (UNSAFE):
async function releaseLock(lock: ApprovalLock): Promise<void> {
  const currentValue = await lock.client.get(lock.key); // ← GET
  if (currentValue === lock.value) {
    await lock.client.del(lock.key); // ← DEL (separate operation!)
  }
}
```

#### Impact Analysis

- **Who:** All users under high concurrency
- **Severity:** Critical - can release another user's lock
- **Frequency:** Rare but catastrophic when it occurs

#### Root Cause

Between the GET and DEL operations:

1. Original lock could expire (TTL)
2. Another client could acquire the lock
3. DEL then removes the NEW lock holder's lock

#### Scenario

```
T=0ms    Client A: GET lock-key → returns "uuid-A" (matches)
T=1ms    Lock expires (TTL reached)
T=2ms    Client B: SET lock-key "uuid-B" NX → SUCCESS (acquires lock)
T=3ms    Client A: DEL lock-key → DELETES CLIENT B's LOCK!
T=4ms    Client C: SET lock-key "uuid-C" NX → SUCCESS
         Now B and C both think they have the lock!
```

#### Fix Implementation

Use Lua script for atomic check-and-delete:

```typescript
// utils/appointmentlock.ts - Updated releaseLock function

/**
 * Release a distributed lock safely using atomic Lua script
 * Never throws - safe for finally blocks
 */
async function releaseLock(lock: ApprovalLock): Promise<void> {
  try {
    // Atomic release using Lua script
    // Only deletes if value matches (we still own the lock)
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    const result = await lock.client.eval(
      script,
      [lock.key], // KEYS
      [lock.value], // ARGV
    );

    const heldDuration = Date.now() - lock.acquiredAt;

    if (result === 1) {
      console.log(
        JSON.stringify({
          event: "lock_released",
          key: lock.key,
          held_duration_ms: heldDuration,
          timestamp: new Date().toISOString(),
        }),
      );
    } else {
      console.log(
        JSON.stringify({
          event: "lock_already_released",
          key: lock.key,
          reason: "value_mismatch_or_expired",
          held_duration_ms: heldDuration,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  } catch (error: any) {
    // Never throw in unlock - log only
    console.error(
      JSON.stringify({
        event: "lock_release_error",
        key: lock.key,
        error: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
  }
}
```

**Status:** FIXED - Atomic Lua script implementation

---

### Issue #4: Subscription Tentative Appointment Bypass

**Severity:** Critical
**Location:** `lib/payments/operations/checkout.ts`

#### Problem Description

Unlike consultations, subscriptions don't create tentative appointments during checkout:

```typescript
case "SUBSCRIPTION": {
  const subscriptionResult = await handleSubscriptionCheckout(...);
  // Subscription doesn't create appointment during checkout
  createdAppointment = null;  // ← NO TENTATIVE APPOINTMENT!
  break;
}
```

#### Impact Analysis

- **Who:** Users purchasing subscriptions with overlapping scheduling periods
- **Severity:** Critical - bypasses race condition protection
- **Frequency:** Can occur whenever two users purchase same subscription type

#### Root Cause

The subscription model was designed for consultant-allocated slots (via Requests tab), not direct checkout. However, when scheduling periods overlap, two users could:

1. Both pass validation (no tentative appointments visible)
2. Both create payments
3. Result in conflicting subscriptions

#### Fix Implementation

Create a lightweight "subscription reservation" record that validation can see:

```typescript
// lib/payments/operations/checkout.ts - Updated handleSubscriptionCheckout

export async function handleSubscriptionCheckout(
  tx: Prisma.TransactionClient,
  data: CheckoutInput,
  consulteeProfileId: string,
  skipPayment: boolean,
): Promise<SubscriptionCheckoutResult> {
  const plan = await tx.subscriptionPlan.findUnique({
    where: { id: data.planId },
    include: {
      consultantProfile: {
        include: { user: true },
      },
    },
  });

  if (!plan) {
    throw new Error("Subscription plan not found");
  }

  const isSchedulingPeriodRequest =
    data.schedulingPeriodStartsAt && data.schedulingPeriodEndsAt;

  const startDate = isSchedulingPeriodRequest
    ? new Date(data.schedulingPeriodStartsAt!)
    : new Date();
  const endDate = isSchedulingPeriodRequest
    ? new Date(data.schedulingPeriodEndsAt!)
    : calculateSubscriptionEndDate(startDate, plan.durationInMonths);

  // Check for duplicate pending subscriptions with overlapping periods
  const existingPendingSubscription = await tx.subscription.findFirst({
    where: {
      subscriptionPlanId: plan.id,
      requestedById: consulteeProfileId,
      status: { in: [AppointmentStatus.PENDING, AppointmentStatus.APPROVED] }, // field+enum renamed from `requestStatus`/AppointmentStatus
      OR: [
        {
          AND: [
            { schedulingPeriodStartsAt: { lte: endDate } },
            { schedulingPeriodEndsAt: { gte: startDate } },
          ],
        },
      ],
    },
  });

  if (existingPendingSubscription) {
    throw new Error(
      "You already have a pending or active subscription for this plan with overlapping dates.",
    );
  }

  // Create subscription with appropriate status
  const subscription = await tx.subscription.create({
    data: {
      subscriptionPlanId: plan.id,
      status: skipPayment // renamed from `requestStatus`; AppointmentStatus was AppointmentStatus
        ? AppointmentStatus.APPROVED
        : AppointmentStatus.PENDING,
      requestedById: consulteeProfileId,
      requestNotes: data.notes,
      bookingSource: "DIRECT_CHECKOUT",
      schedulingPeriodStartsAt: startDate,
      schedulingPeriodEndsAt: endDate,
    },
  });

  // Create a placeholder appointment for validation visibility
  // This ensures other checkouts can see this pending subscription
  let appointment = null;
  if (!skipPayment) {
    appointment = await tx.appointment.create({
      data: {
        appointmentType: AppointmentsType.SUBSCRIPTION,
        subscriptionId: subscription.id,
        // Note: No slots created - consultant allocates later
        // But appointment exists for payment linkage and validation visibility
      },
    });
  }

  return {
    subscription,
    plan,
    amount: plan.price,
    isSchedulingPeriodRequest: !!isSchedulingPeriodRequest,
    appointment, // ← Now returns appointment for payment linkage
  };
}
```

Update checkout.ts to use the appointment:

```typescript
case "SUBSCRIPTION": {
  const subscriptionResult = await handleSubscriptionCheckout(
    tx,
    validatedData,
    consulteeProfileId,
    isMockPayment,
  );
  // Now use the appointment from subscription result
  createdAppointment = subscriptionResult.appointment || null;
  break;
}
```

**Status:** FIXED - Subscriptions now create placeholder appointments

---

### Issue #5: Event Lock Granularity Too Coarse

**Severity:** Critical
**Location:** `utils/appointmentlock.ts`

#### Problem Description

For webinars/classes with multiple participants, the lock covers the ENTIRE event:

```typescript
// Current: Locks entire webinar, serializing all checkouts
const lock = await lockEventCheckout("WEBINAR", webinarId, 60000);
```

#### Impact Analysis

- **Who:** Users joining multi-participant events
- **Severity:** High - severe UX degradation at scale
- **Frequency:** Every webinar/class checkout

#### Root Cause

The locking strategy was designed for 1:1 consultations. For events with 100+ participants, serializing all checkouts means:

- 100 users × 5 seconds each = 500 seconds total
- Last user waits 8+ minutes
- Many users will abandon

#### Fix Implementation

Implement semaphore pattern with atomic increment:

```typescript
// utils/appointmentlock.ts - New semaphore functions

/**
 * Acquire a slot in a semaphore (for multi-participant events)
 * Returns reservation ID if successful, null if event is full
 */
export async function acquireEventSlot(
  eventType: string,
  eventId: string,
  maxParticipants: number,
  ttl: number = 300000, // 5 minutes for payment completion
): Promise<{ reservationId: string; slotNumber: number } | null> {
  const client = redisClient as Redis;
  const counterKey = `event-counter:${eventType}:${eventId}`;
  const reservationId = crypto.randomUUID();

  // Atomic increment with limit check using Lua script
  const script = `
    local current = redis.call("get", KEYS[1])
    if current == false then
      current = 0
    else
      current = tonumber(current)
    end

    if current >= tonumber(ARGV[1]) then
      return -1
    end

    local newCount = redis.call("incr", KEYS[1])
    if newCount == 1 then
      redis.call("pexpire", KEYS[1], ARGV[2])
    end

    return newCount
  `;

  const slotNumber = (await client.eval(
    script,
    [counterKey],
    [maxParticipants.toString(), ttl.toString()],
  )) as number;

  if (slotNumber === -1) {
    console.log(
      JSON.stringify({
        event: "event_slot_full",
        eventType,
        eventId,
        maxParticipants,
        timestamp: new Date().toISOString(),
      }),
    );
    return null;
  }

  // Store reservation for cleanup
  const reservationKey = `event-reservation:${eventType}:${eventId}:${reservationId}`;
  await client.set(reservationKey, slotNumber.toString(), { px: ttl });

  console.log(
    JSON.stringify({
      event: "event_slot_acquired",
      eventType,
      eventId,
      slotNumber,
      reservationId,
      timestamp: new Date().toISOString(),
    }),
  );

  return { reservationId, slotNumber };
}

/**
 * Release an event slot (on payment failure or cancellation)
 */
export async function releaseEventSlot(
  eventType: string,
  eventId: string,
  reservationId: string,
): Promise<void> {
  const client = redisClient as Redis;
  const counterKey = `event-counter:${eventType}:${eventId}`;
  const reservationKey = `event-reservation:${eventType}:${eventId}:${reservationId}`;

  // Check if reservation exists before decrementing
  const exists = await client.exists(reservationKey);
  if (exists) {
    await client.del(reservationKey);
    await client.decr(counterKey);

    console.log(
      JSON.stringify({
        event: "event_slot_released",
        eventType,
        eventId,
        reservationId,
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

/**
 * Confirm an event slot (on successful payment)
 * Removes reservation but keeps counter (slot is now permanent)
 */
export async function confirmEventSlot(
  eventType: string,
  eventId: string,
  reservationId: string,
): Promise<void> {
  const client = redisClient as Redis;
  const reservationKey = `event-reservation:${eventType}:${eventId}:${reservationId}`;

  // Just remove reservation, counter stays (slot is now confirmed)
  await client.del(reservationKey);

  console.log(
    JSON.stringify({
      event: "event_slot_confirmed",
      eventType,
      eventId,
      reservationId,
      timestamp: new Date().toISOString(),
    }),
  );
}
```

**Status:** FIXED - Semaphore pattern implemented for parallel event checkout

---

## High Priority Issues

### Issue #6: Payment Intent Expiration Mismatch

**Severity:** High
**Location:** `lib/payments/operations/checkout.ts` vs `jobs/cleanup-abandoned-payments.ts`

#### Problem Description

Payment expires at 30 minutes, but cleanup job might process it at the exact boundary:

```typescript
// checkout.ts
expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes

// cleanup job
createdAt: { lt: new Date(Date.now() - 30 * 60 * 1000) },  // 30 min fallback
```

#### Fix Implementation

Add 5-minute buffer to cleanup job:

```typescript
// jobs/cleanup-abandoned-payments.ts
{
  createdAt: {
    lt: new Date(Date.now() - 35 * 60 * 1000),  // 35 min buffer
  },
},
```

**Status:** FIXED - Buffer added to cleanup job

---

### Issue #8: Webhook Metadata Validation Silent Failures

**Severity:** High
**Location:** `lib/payments/webhooks/handlers.ts`

#### Problem Description

When metadata validation fails, payment is marked successful but no appointment is created:

```typescript
// Customer charged but no booking created!
await tx.payment.update({
  where: { id: payment.id },
  data: {
    paymentStatus: PaymentStatus.SUCCEEDED,
    description: `Metadata validation failed...`,
  },
});
return; // ← Silent exit, no appointment!
```

#### Fix Implementation

Add immediate alert and create recovery task:

```typescript
// lib/payments/webhooks/handlers.ts

// After marking payment as succeeded with validation error:
await tx.payment.update({
  where: { id: payment.id },
  data: {
    paymentStatus: PaymentStatus.SUCCEEDED,
    description: `REQUIRES_MANUAL_RECOVERY: Metadata validation failed: ${errorMessage}`,
  },
});

// Create urgent alert (integrate with your alerting system)
await sendUrgentAlert({
  type: "PAYMENT_WITHOUT_APPOINTMENT",
  paymentId: payment.id,
  paymentIntentId: paymentIntentId,
  userId: payment.userId,
  amount: payment.amount,
  currency: payment.currency,
  errorMessage,
  timestamp: new Date().toISOString(),
});

// Log for monitoring dashboards
console.error(
  JSON.stringify({
    event: "CRITICAL_ALERT",
    alert_type: "payment_without_appointment",
    payment_id: payment.id,
    payment_intent: paymentIntentId,
    user_id: payment.userId,
    amount: payment.amount,
    currency: payment.currency,
    error: errorMessage,
    action_required: "Manual appointment creation or refund",
    timestamp: new Date().toISOString(),
  }),
);
```

**Status:** FIXED - Alerting added for metadata failures

---

### Issue #10: Cleanup Job Race with Payment Completion

**Severity:** High
**Location:** `jobs/cleanup-abandoned-payments.ts`

#### Problem Description

Cleanup job can race with webhook:

1. Cleanup finds expired payment at T=0
2. Payment webhook fires at T=1ms
3. Cleanup deletes appointment
4. Webhook tries to confirm deleted appointment

#### Fix Implementation

Add fresh status check before cleanup:

```typescript
// jobs/cleanup-abandoned-payments.ts - Inside transaction

// Re-check payment status before cleanup (prevents race with webhook)
for (const payment of appointment.payment) {
  const freshPayment = await tx.payment.findUnique({
    where: { id: payment.id },
  });

  if (freshPayment?.paymentStatus === PaymentStatus.SUCCEEDED) {
    console.log(
      JSON.stringify({
        event: "cleanup_skipped_payment_succeeded",
        paymentId: payment.id,
        appointmentId: appointment.id,
        timestamp: new Date().toISOString(),
      }),
    );
    // Skip this appointment - payment completed while we were processing
    continue;
  }

  // Proceed with cleanup...
}
```

**Status:** FIXED - Fresh status check added

---

### Issue #12: No Redis Circuit Breaker

**Severity:** High
**Location:** `lib/redis.ts`

#### Problem Description

If Redis is down, every lock attempt hangs until timeout, causing cascading failures.

#### Fix Implementation

Add circuit breaker pattern:

```typescript
// lib/redis.ts - Circuit breaker implementation

interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
}

const circuitBreaker: CircuitBreakerState = {
  failures: 0,
  lastFailure: 0,
  state: "CLOSED",
};

const CIRCUIT_CONFIG = {
  failureThreshold: 5, // Open after 5 failures
  resetTimeout: 30000, // Try again after 30 seconds
  halfOpenRequests: 3, // Allow 3 test requests in half-open
};

/**
 * Execute Redis operation with circuit breaker protection
 */
export async function withCircuitBreaker<T>(
  operation: () => Promise<T>,
  fallback?: () => T,
): Promise<T> {
  // Check circuit state
  if (circuitBreaker.state === "OPEN") {
    const timeSinceFailure = Date.now() - circuitBreaker.lastFailure;
    if (timeSinceFailure > CIRCUIT_CONFIG.resetTimeout) {
      circuitBreaker.state = "HALF_OPEN";
      console.log(
        JSON.stringify({
          event: "circuit_breaker_half_open",
          timestamp: new Date().toISOString(),
        }),
      );
    } else {
      console.warn(
        JSON.stringify({
          event: "circuit_breaker_open",
          remaining_ms: CIRCUIT_CONFIG.resetTimeout - timeSinceFailure,
          timestamp: new Date().toISOString(),
        }),
      );
      if (fallback) return fallback();
      throw new Error("Redis circuit breaker is OPEN - service unavailable");
    }
  }

  try {
    const result = await operation();

    // Success - reset circuit breaker
    if (circuitBreaker.state === "HALF_OPEN") {
      circuitBreaker.state = "CLOSED";
      circuitBreaker.failures = 0;
      console.log(
        JSON.stringify({
          event: "circuit_breaker_closed",
          timestamp: new Date().toISOString(),
        }),
      );
    }

    return result;
  } catch (error) {
    circuitBreaker.failures++;
    circuitBreaker.lastFailure = Date.now();

    if (circuitBreaker.failures >= CIRCUIT_CONFIG.failureThreshold) {
      circuitBreaker.state = "OPEN";
      console.error(
        JSON.stringify({
          event: "circuit_breaker_opened",
          failures: circuitBreaker.failures,
          timestamp: new Date().toISOString(),
        }),
      );
    }

    if (fallback) return fallback();
    throw error;
  }
}

/**
 * Check Redis health (for monitoring)
 */
export async function checkRedisHealth(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}
```

**Status:** FIXED - Circuit breaker implemented

---

## Medium Priority Issues

### Issue #11: Hardcoded Slot Duration

**Severity:** Medium
**Location:** `utils/slotAllocation/SlotValidationService.ts`

#### Problem Description

```typescript
const slotEnd = new Date(slot.getTime() + 30 * 60 * 1000); // Hardcoded 30 min
```

#### Fix Implementation

Pass duration from configuration:

```typescript
private async validateNoConflicts(
  slots: Date[],
  consultantUserId: string,
  slotDurationMinutes: number = 30,  // ← Configurable
): Promise<ValidationResult> {
  for (const slot of slots) {
    const slotEnd = new Date(slot.getTime() + slotDurationMinutes * 60 * 1000);
    // ... rest of validation
  }
}
```

**Status:** FIXED - Duration now configurable

---

## Implementation Status

| Issue | Severity | Status     | File(s) Modified                                |
| ----- | -------- | ---------- | ----------------------------------------------- |
| #1    | Critical | Acceptable | (logging only)                                  |
| #2    | Critical | FIXED      | `utils/appointmentlock.ts`                      |
| #3    | Critical | FIXED      | `utils/appointmentlock.ts`                      |
| #4    | Critical | FIXED      | `lib/payments/operations/checkout.ts`           |
| #5    | Critical | FIXED      | `utils/appointmentlock.ts`                      |
| #6    | High     | FIXED      | `jobs/cleanup-abandoned-payments.ts`            |
| #8    | High     | FIXED      | `lib/payments/webhooks/handlers.ts`             |
| #10   | High     | FIXED      | `jobs/cleanup-abandoned-payments.ts`            |
| #12   | High     | FIXED      | `lib/redis.ts`                                  |
| #11   | Medium   | FIXED      | `utils/slotAllocation/SlotValidationService.ts` |

---

## Testing Checklist

After implementing fixes, verify:

- [ ] Run `npx tsx tests/typescript/race-conditions/test-checkout-race-condition-fix.ts`
- [ ] Test concurrent checkout for consultations (expect 1 success, 1 failure)
- [ ] Test concurrent checkout for subscriptions with overlapping periods
- [ ] Test webinar checkout with multiple concurrent users
- [ ] Verify cleanup job doesn't delete active payments
- [ ] Test circuit breaker by simulating Redis failure
- [ ] Monitor logs for new structured events
