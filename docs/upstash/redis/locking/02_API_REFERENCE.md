# API Reference

> Complete API documentation for Upstash Redis distributed locking system

---

## Table of Contents

1. [API Overview](#api-overview)
2. [Approval Lock API](#approval-lock-api)
   - [lockConsultationApproval](#lockconsultationapproval)
   - [lockSubscriptionApproval](#locksubscriptionapproval)
   - [unlockApproval](#unlockapproval)
3. [Slot Booking Lock API](#slot-booking-lock-api)
   - [lockSlotBooking](#lockslotbooking)
   - [unlockSlotBooking](#unlockslotbooking)
4. [Event Checkout Lock API](#event-checkout-lock-api)
   - [lockEventCheckout](#lockeventcheckout)
   - [unlockEventCheckout](#unlockeventcheckout)
5. [Event Slot Semaphore API](#event-slot-semaphore-api)
   - [acquireEventSlot](#acquireeventslot)
   - [releaseEventSlot](#releaseeventslot)
   - [confirmEventSlot](#confirmeventslot)
   - [getEventSlotCount](#geteventslotcount)
6. [Lock Extension API](#lock-extension-api)
   - [extendLock](#extendlock)
7. [Legacy Lock API](#legacy-lock-api)
   - [lockAppointment](#lockappointment)
   - [unlockAppointment](#unlockappointment)
   - [isAppointmentLocked](#isappointmentlocked)
8. [Types & Interfaces](#types--interfaces)
   - [ApprovalLock](#approvallock-interface)
   - [LockRetryConfig](#lockretryconfig-interface)
   - [EventSlotReservation](#eventslotreservation-interface)
9. [Configuration Reference](#configuration-reference)
10. [Best Practices](#best-practices)

---

## API Overview

### Import Paths

```typescript
// Approval locks (primary API)
import {
  lockConsultationApproval,
  lockSubscriptionApproval,
  unlockApproval,
  ApprovalLock,
  LockRetryConfig,
} from "@/utils/appointmentlock";

// Slot booking locks
import { lockSlotBooking, unlockSlotBooking } from "@/utils/appointmentlock";

// Event checkout locks
import {
  lockEventCheckout,
  unlockEventCheckout,
} from "@/utils/appointmentlock";

// Event slot semaphore (multi-participant events)
import {
  acquireEventSlot,
  releaseEventSlot,
  confirmEventSlot,
  getEventSlotCount,
  EventSlotReservation,
} from "@/utils/appointmentlock";

// Lock extension (heartbeat pattern)
import { extendLock } from "@/utils/appointmentlock";

// Legacy locks (appointment booking)
import {
  lockAppointment,
  unlockAppointment,
  isAppointmentLocked,
} from "@/utils/appointmentlock";

// Circuit breaker (for Redis operations)
import { withCircuitBreaker, checkRedisHealth } from "@/lib/redis";
```

> **Note**: API rate limiting is handled by **Arcjet** at the route level, not by this module.

### Quick Reference

| Function                   | Purpose                       | Default TTL | Returns                        |
| -------------------------- | ----------------------------- | ----------- | ------------------------------ |
| `lockConsultationApproval` | Lock consultation approval    | 60s         | `ApprovalLock`                 |
| `lockSubscriptionApproval` | Lock subscription approval    | 60s         | `ApprovalLock`                 |
| `unlockApproval`           | Release any approval lock     | N/A         | `void`                         |
| `lockSlotBooking`          | Lock time slot for booking    | 60s         | `ApprovalLock`                 |
| `unlockSlotBooking`        | Release slot booking lock     | N/A         | `void`                         |
| `lockEventCheckout`        | Lock event for checkout       | Per-type via `CHECKOUT_LOCK_TTL_MS` (#832): CONSULTATION 60s / SUBSCRIPTION 120s / WEBINAR 120s / CLASS 300s | `ApprovalLock`                 |
| `lockAutoAllocate`         | Lock auto-allocation (consultant-level) | 150s | `ApprovalLock`          |
| `unlockAutoAllocate`       | Release auto-allocate lock    | N/A         | `void`                         |
| `unlockEventCheckout`      | Release event checkout lock   | N/A         | `void`                         |
| `acquireEventSlot`         | Reserve slot (semaphore)      | 5min        | `EventSlotReservation \| null` |
| `releaseEventSlot`         | Release semaphore slot        | N/A         | `void`                         |
| `confirmEventSlot`         | Confirm slot after payment    | N/A         | `void`                         |
| `getEventSlotCount`        | Get current reservation count | N/A         | `number`                       |
| `extendLock`               | Extend lock TTL (heartbeat)   | +30s        | `boolean`                      |
| `lockAppointment`          | Lock appointment (legacy)     | 5min        | `ApprovalLock`                 |
| `unlockAppointment`        | Release appointment lock      | N/A         | `void`                         |
| `isAppointmentLocked`      | Check appointment lock status | N/A         | `boolean`                      |

---

## Approval Lock API

### lockConsultationApproval()

Acquires a distributed lock for preventing concurrent consultation approval attempts.

#### Signature

```typescript
async function lockConsultationApproval(
  consultationId: string,
  ttl: number = 60000,
): Promise<ApprovalLock>;
```

#### Parameters

| Parameter        | Type     | Required | Default | Description                                          |
| ---------------- | -------- | -------- | ------- | ---------------------------------------------------- |
| `consultationId` | `string` | Yes      | -       | Unique consultation identifier (e.g., `"clx123abc"`) |
| `ttl`            | `number` | No       | `60000` | Time-to-live in milliseconds (60 seconds default)    |

#### Returns

`Promise<ApprovalLock>` - Lock object containing:

- `key`: Redis key (`"consultation-approval:clx123"`)
- `value`: UUID for ownership verification
- `ttl`: Effective TTL with drift protection (59400ms)
- `acquiredAt`: Timestamp when lock was acquired
- `client`: Upstash Redis client reference

#### Throws

- `Error`: "Another approval is in progress for this consultation. Please try again."
  - Thrown after 10 retry attempts (~3-4 seconds)
  - Indicates another process holds the lock

#### Usage Examples

##### Example 1: Basic Consultation Approval

```typescript
import {
  lockConsultationApproval,
  unlockApproval,
} from "@/utils/appointmentlock";
import { NextResponse } from "next/server";

export async function PATCH(
  request: Request,
  { params }: { params: { consultationId: string } },
) {
  const { consultationId } = params;
  const { status } = await request.json();

  if (status !== "APPROVED") {
    // No lock needed for other statuses
    return NextResponse.json({ success: true });
  }

  let lock;
  try {
    // ✅ Acquire lock with 60-second default TTL
    lock = await lockConsultationApproval(consultationId);

    // Protected critical section
    const payment = await createApprovalPaymentIntent(consultationId);
    await sendPaymentLinkEmail(payment);
    await updateConsultationStatus(consultationId, "APPROVED");

    return NextResponse.json({ success: true, payment });
  } catch (error) {
    // Lock acquisition failed
    return NextResponse.json(
      { error: "Another approval is in progress. Please try again." },
      { status: 409 }, // Conflict status code
    );
  } finally {
    // ✅ Always release lock (never throws)
    if (lock) {
      await unlockApproval(lock);
    }
  }
}
```

**Expected Log Output**:

```json
{"event":"lock_acquired","key":"consultation-approval:clx123","attempts":1,"duration_ms":78,"ttl":29700,"timestamp":"2025-11-29T12:34:56.789Z"}
{"event":"lock_released","key":"consultation-approval:clx123","held_duration_ms":5058,"timestamp":"2025-11-29T12:35:01.847Z"}
```

##### Example 2: Custom TTL for Long Operations

```typescript
// For operations taking 15-20 seconds, use 25-second TTL
lock = await lockConsultationApproval(consultationId, 25000);

// For operations taking 45-50 seconds, use 60-second TTL
lock = await lockConsultationApproval(consultationId, 60000);
```

**TTL Selection Rules**:

- TTL ≥ max expected operation duration
- Include 15-20% buffer for retries
- Shorter TTL = less contention, but riskier
- Longer TTL = safer, but blocks concurrent requests longer

##### Example 3: Error Handling with Retry

```typescript
async function approveWithRetry(consultationId: string, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let lock;
    try {
      lock = await lockConsultationApproval(consultationId);
      await performApproval(consultationId);
      return { success: true };
    } catch (error) {
      if (attempt === maxAttempts) {
        // Final attempt failed
        return {
          error: "Approval failed after multiple attempts",
          retryAfter: 5,
        };
      }
      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } finally {
      if (lock) await unlockApproval(lock);
    }
  }
}
```

---

### lockSubscriptionApproval()

Acquires a distributed lock for preventing concurrent subscription approval attempts. Identical to `lockConsultationApproval()` but for subscriptions.

#### Signature

```typescript
async function lockSubscriptionApproval(
  subscriptionId: string,
  ttl: number = 60000,
): Promise<ApprovalLock>;
```

#### Parameters

| Parameter        | Type     | Required | Default | Description                                       |
| ---------------- | -------- | -------- | ------- | ------------------------------------------------- |
| `subscriptionId` | `string` | Yes      | -       | Unique subscription identifier                    |
| `ttl`            | `number` | No       | `60000` | Time-to-live in milliseconds (60 seconds default) |

#### Usage Example

```typescript
import {
  lockSubscriptionApproval,
  unlockApproval,
} from "@/utils/appointmentlock";

export async function approveSubscription(subscriptionId: string) {
  let lock;
  try {
    lock = await lockSubscriptionApproval(subscriptionId, 30000);

    // Protected: create subscription payment
    const payment = await createSubscriptionPaymentIntent(subscriptionId);
    await sendSubscriptionEmail(payment);

    return { success: true, payment };
  } catch (error) {
    return { error: "Another approval in progress", status: 409 };
  } finally {
    if (lock) await unlockApproval(lock);
  }
}
```

---

### unlockApproval()

Safely releases an approval lock with ownership verification. **Never throws** - safe for `finally` blocks.

#### Signature

```typescript
async function unlockApproval(lock: ApprovalLock): Promise<void>;
```

#### Parameters

| Parameter | Type           | Required | Description                                                                        |
| --------- | -------------- | -------- | ---------------------------------------------------------------------------------- |
| `lock`    | `ApprovalLock` | Yes      | Lock object returned from `lockConsultationApproval` or `lockSubscriptionApproval` |

#### Behavior

1. Checks if current lock value matches UUID (ownership verification)
2. If match: deletes lock and logs `lock_released`
3. If no match: logs `lock_already_released` (lock expired or released by another process)
4. If error: logs `lock_release_error` but **does not throw**

#### Usage Examples

##### ✅ Correct Usage

```typescript
let lock;
try {
  lock = await lockConsultationApproval(consultationId);
  // Critical section
} finally {
  // ✅ Always in finally block
  if (lock) {
    await unlockApproval(lock);
  }
}
```

##### ❌ Incorrect Usage

```typescript
// ❌ DON'T: Release outside finally block
let lock = await lockConsultationApproval(consultationId);
try {
  // Critical section
  await unlockApproval(lock); // ❌ Exception prevents this
} catch (error) {
  // Lock never released!
}

// ❌ DON'T: Forget to check if lock exists
try {
  lock = await lockConsultationApproval(consultationId);
} finally {
  await unlockApproval(lock); // ❌ TypeError if lock is undefined
}
```

##### Multiple Releases are Safe

```typescript
// Multiple releases are idempotent (no error)
await unlockApproval(lock);
await unlockApproval(lock); // ✅ Safe, logs "lock_already_released"
```

---

## Slot Booking Lock API

### lockSlotBooking()

Acquires a distributed lock for preventing double-booking of time slots during consultation creation.

#### Signature

```typescript
async function lockSlotBooking(
  consultantProfileId: string,
  startsAt: string,
  ttl: number = 60000,
): Promise<ApprovalLock>;
```

#### Parameters

| Parameter             | Type     | Required | Default | Description                                                        |
| --------------------- | -------- | -------- | ------- | ------------------------------------------------------------------ |
| `consultantProfileId` | `string` | Yes      | -       | The consultant's profile ID                                        |
| `startsAt`  | `string` | Yes      | -       | Slot start time in ISO format (e.g., `"2025-01-15T10:00:00.000Z"`) |
| `ttl`                 | `number` | No       | `60000` | Time-to-live in milliseconds (60 seconds default)                  |

#### Throws

- `SlotLockError`: Thrown when another user is currently booking this slot

#### Usage Example

```typescript
import { lockSlotBooking, unlockSlotBooking } from "@/utils/appointmentlock";

async function createConsultationBooking(
  consultantProfileId: string,
  slotTime: string,
) {
  let lock;
  try {
    lock = await lockSlotBooking(consultantProfileId, slotTime);

    // Protected: verify slot and create booking
    await verifySlotAvailability(consultantProfileId, slotTime);
    await createBooking(consultantProfileId, slotTime);

    return { success: true };
  } catch (error) {
    if (error.name === "SlotLockError") {
      return {
        error: "This slot is being booked by another user",
        status: 409,
      };
    }
    throw error;
  } finally {
    if (lock) await unlockSlotBooking(lock);
  }
}
```

---

### unlockSlotBooking()

Releases a slot booking lock. Identical to `unlockApproval()`.

#### Signature

```typescript
async function unlockSlotBooking(lock: ApprovalLock): Promise<void>;
```

---

## Event Checkout Lock API

### lockEventCheckout()

Acquires a distributed lock for preventing concurrent event checkout attempts. Used for webinars, classes, and subscription scheduling.

#### Signature

```typescript
async function lockEventCheckout(
  appointmentType: string,
  eventOrPlanId: string,
  ttl: number = 60000,
): Promise<ApprovalLock>;
```

#### Parameters

| Parameter         | Type     | Required | Default | Description                                                    |
| ----------------- | -------- | -------- | ------- | -------------------------------------------------------------- |
| `appointmentType` | `string` | Yes      | -       | Type of appointment (`"WEBINAR"`, `"CLASS"`, `"SUBSCRIPTION"`) |
| `eventOrPlanId`   | `string` | Yes      | -       | Event ID or subscription plan ID                               |
| `ttl`             | `number` | No       | `60000` | Time-to-live in milliseconds (60 seconds default)              |

#### Usage Example

```typescript
import {
  lockEventCheckout,
  unlockEventCheckout,
} from "@/utils/appointmentlock";

async function checkoutWebinar(webinarId: string) {
  let lock;
  try {
    lock = await lockEventCheckout("WEBINAR", webinarId);

    // Protected: process checkout
    await processPayment(webinarId);
    await enrollUser(webinarId);

    return { success: true };
  } catch (error) {
    return { error: "Another checkout in progress", status: 409 };
  } finally {
    if (lock) await unlockEventCheckout(lock);
  }
}
```

---

### unlockEventCheckout()

Releases an event checkout lock. Identical to `unlockApproval()`.

#### Signature

```typescript
async function unlockEventCheckout(lock: ApprovalLock): Promise<void>;
```

---

## Event Slot Semaphore API

The semaphore API allows multiple concurrent checkouts for multi-participant events (webinars, classes) up to a configurable limit. Unlike mutex locks, semaphores allow parallel operations.

### acquireEventSlot()

Reserves a slot in the event semaphore. Returns reservation info if successful, `null` if the event is full.

#### Signature

```typescript
async function acquireEventSlot(
  eventType: string,
  eventId: string,
  maxParticipants: number,
  ttl: number = 300000,
): Promise<EventSlotReservation | null>;
```

#### Parameters

| Parameter         | Type     | Required | Default  | Description                                              |
| ----------------- | -------- | -------- | -------- | -------------------------------------------------------- |
| `eventType`       | `string` | Yes      | -        | Type of event (`"WEBINAR"`, `"CLASS"`)                   |
| `eventId`         | `string` | Yes      | -        | Unique event identifier                                  |
| `maxParticipants` | `number` | Yes      | -        | Maximum concurrent reservations allowed                  |
| `ttl`             | `number` | No       | `300000` | Reservation TTL in ms (5 minutes for payment completion) |

#### Returns

- `EventSlotReservation`: Reservation object if slot acquired
- `null`: If event has reached maximum participants

#### Usage Example

```typescript
import {
  acquireEventSlot,
  releaseEventSlot,
  confirmEventSlot,
} from "@/utils/appointmentlock";

async function checkoutWebinar(webinarId: string, maxSeats: number) {
  // Reserve a slot (allows parallel checkouts up to maxSeats)
  const reservation = await acquireEventSlot("WEBINAR", webinarId, maxSeats);

  if (!reservation) {
    return { error: "Webinar is full", status: 409 };
  }

  try {
    // Process payment (5 minute window)
    const paymentResult = await processPayment(webinarId);

    if (paymentResult.success) {
      // Confirm slot (removes reservation tracking, keeps counter)
      await confirmEventSlot(reservation);
      return { success: true };
    } else {
      // Release slot (decrements counter, allows another user)
      await releaseEventSlot(reservation);
      return { error: "Payment failed", status: 402 };
    }
  } catch (error) {
    // Release on any error
    await releaseEventSlot(reservation);
    throw error;
  }
}
```

---

### releaseEventSlot()

Releases an event slot reservation. Decrements the counter to allow another user to book.

#### Signature

```typescript
async function releaseEventSlot(
  reservation: EventSlotReservation,
): Promise<void>;
```

---

### confirmEventSlot()

Confirms an event slot after successful payment. Removes reservation tracking but keeps the counter (slot is now permanent in the database).

#### Signature

```typescript
async function confirmEventSlot(
  reservation: EventSlotReservation,
): Promise<void>;
```

---

### getEventSlotCount()

Returns the current number of reservations for an event.

#### Signature

```typescript
async function getEventSlotCount(
  eventType: string,
  eventId: string,
): Promise<number>;
```

#### Usage Example

```typescript
import { getEventSlotCount } from "@/utils/appointmentlock";

async function checkAvailability(webinarId: string, maxSeats: number) {
  const currentCount = await getEventSlotCount("WEBINAR", webinarId);
  const available = maxSeats - currentCount;

  return {
    total: maxSeats,
    reserved: currentCount,
    available,
    isFull: available <= 0,
  };
}
```

---

## Lock Extension API

### extendLock()

Extends a lock's TTL using the heartbeat pattern. Call periodically during long operations to prevent lock expiration.

#### Signature

```typescript
async function extendLock(
  lock: ApprovalLock,
  additionalTtl: number = 30000,
): Promise<boolean>;
```

#### Parameters

| Parameter       | Type           | Required | Default | Description                                |
| --------------- | -------------- | -------- | ------- | ------------------------------------------ |
| `lock`          | `ApprovalLock` | Yes      | -       | The lock to extend                         |
| `additionalTtl` | `number`       | No       | `30000` | Additional TTL to add (30 seconds default) |

#### Returns

- `true`: Lock extended successfully
- `false`: Lock extension failed (ownership lost)

#### Usage Example

```typescript
import {
  lockConsultationApproval,
  unlockApproval,
  extendLock,
} from "@/utils/appointmentlock";

async function processLongOperation(consultationId: string) {
  const lock = await lockConsultationApproval(consultationId, 60000);

  // Set up heartbeat to extend lock every 20 seconds
  const heartbeat = setInterval(async () => {
    const extended = await extendLock(lock, 30000);
    if (!extended) {
      console.warn("Lock extension failed - lost ownership");
      clearInterval(heartbeat);
    }
  }, 20000);

  try {
    // Long-running operation (may take > 60s)
    await step1(); // 25s
    await step2(); // 25s
    await step3(); // 25s
  } finally {
    clearInterval(heartbeat);
    await unlockApproval(lock);
  }
}
```

**Best Practice**: Set heartbeat interval to approximately 2/3 of the additional TTL (e.g., 20s heartbeat for 30s extension).

---

## Legacy Lock API

### lockAppointment()

Acquires a distributed lock for appointment booking. **Legacy API** - use approval locks for new code.

#### Signature

```typescript
async function lockAppointment(
  appointmentId: string,
  ttl: number = 300000,
): Promise<ApprovalLock>;
```

#### Parameters

| Parameter       | Type     | Required | Default  | Description                                      |
| --------------- | -------- | -------- | -------- | ------------------------------------------------ |
| `appointmentId` | `string` | Yes      | -        | Unique appointment identifier                    |
| `ttl`           | `number` | No       | `300000` | Time-to-live in milliseconds (5 minutes default) |

#### Usage Example

```typescript
import { lockAppointment, unlockAppointment } from "@/utils/appointmentlock";

async function bookAppointmentSlot(appointmentId: string, slotId: string) {
  let lock;
  try {
    // 5-minute TTL for complex time slot allocation
    lock = await lockAppointment(appointmentId, 300000);

    // Complex allocation logic
    await checkSlotAvailability(slotId);
    await allocateTimeSlot(appointmentId, slotId);
    await sendConfirmationEmail(appointmentId);

    return { success: true };
  } catch (error) {
    throw new Error("Failed to lock appointment");
  } finally {
    if (lock) await unlockAppointment(lock);
  }
}
```

**Why 5 minutes?** Appointment booking involves complex time slot calculations, conflict resolution, and multi-step database updates.

---

### unlockAppointment()

Releases an appointment lock. Identical to `unlockApproval()` - kept for API consistency.

#### Signature

```typescript
async function unlockAppointment(lock: ApprovalLock): Promise<void>;
```

---

### isAppointmentLocked()

Checks if an appointment is currently locked without acquiring the lock.

#### Signature

```typescript
async function isAppointmentLocked(appointmentId: string): Promise<boolean>;
```

#### Parameters

| Parameter       | Type     | Required | Description                   |
| --------------- | -------- | -------- | ----------------------------- |
| `appointmentId` | `string` | Yes      | Unique appointment identifier |

#### Returns

- `true`: Appointment is currently locked
- `false`: Appointment is not locked (available)

#### Usage Examples

##### Example 1: Pre-flight Check

```typescript
import { isAppointmentLocked, lockAppointment } from "@/utils/appointmentlock";

async function canBookAppointment(appointmentId: string): Promise<boolean> {
  // Quick check before attempting acquisition
  const isLocked = await isAppointmentLocked(appointmentId);
  if (isLocked) {
    console.log("Appointment is busy, skipping lock attempt");
    return false;
  }

  // Proceed with lock acquisition
  let lock;
  try {
    lock = await lockAppointment(appointmentId);
    // Perform booking...
    return true;
  } catch (error) {
    return false;
  } finally {
    if (lock) await unlockAppointment(lock);
  }
}
```

##### Example 2: Polling for Availability

```typescript
async function waitForAppointmentAvailability(
  appointmentId: string,
  timeoutMs: number = 30000,
): Promise<boolean> {
  const startTime = Date.now();
  const pollInterval = 1000; // Check every second

  while (Date.now() - startTime < timeoutMs) {
    const isLocked = await isAppointmentLocked(appointmentId);
    if (!isLocked) {
      return true; // Available now
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return false; // Timeout - still locked
}
```

##### Example 3: UI Status Display

```typescript
// Display lock status in UI
async function getAppointmentStatus(appointmentId: string) {
  const isLocked = await isAppointmentLocked(appointmentId);
  return {
    appointmentId,
    status: isLocked ? "in_progress" : "available",
    canBook: !isLocked,
  };
}
```

---

## Types & Interfaces

### ApprovalLock Interface

```typescript
export interface ApprovalLock {
  key: string; // Redis key for the lock
  value: string; // UUID for ownership verification
  ttl: number; // Effective TTL in milliseconds
  acquiredAt: number; // Unix timestamp when acquired
  client: Redis; // Upstash Redis client reference
}
```

#### Properties

| Property     | Type     | Description                                    | Example                                  |
| ------------ | -------- | ---------------------------------------------- | ---------------------------------------- |
| `key`        | `string` | Redis key following naming convention          | `"consultation-approval:clx123"`         |
| `value`      | `string` | Cryptographically random UUID for safe release | `"a3f2b8c1-4d5e-6f7g-8h9i-0j1k2l3m4n5o"` |
| `ttl`        | `number` | Effective TTL with clock drift protection (ms) | `59400` (60000ms - 1% drift)             |
| `acquiredAt` | `number` | Unix timestamp in milliseconds                 | `1701259896789`                          |
| `client`     | `Redis`  | Upstash Redis client for release operations    | `Redis { ... }`                          |

#### Usage

```typescript
// Lock object returned from acquisition functions
const lock: ApprovalLock = await lockConsultationApproval("clx123");

console.log(lock.key); // "consultation-approval:clx123"
console.log(lock.value); // "a3f2b8c1-..."
console.log(lock.ttl); // 59400
console.log(lock.acquiredAt); // 1701259896789

// Used for safe release
await unlockApproval(lock);
```

---

### LockRetryConfig Interface

```typescript
export interface LockRetryConfig {
  retryCount: number; // Number of retry attempts
  retryDelay: number; // Base delay in milliseconds
  retryJitter: number; // Random jitter in milliseconds
  exponentialBackoff: boolean; // Use exponential backoff
  driftFactor: number; // Clock drift factor
}
```

#### Properties

| Property             | Type      | Default | Description                                                |
| -------------------- | --------- | ------- | ---------------------------------------------------------- |
| `retryCount`         | `number`  | `10`    | Number of retry attempts (total attempts = retryCount + 1) |
| `retryDelay`         | `number`  | `200`   | Base delay in milliseconds between retries                 |
| `retryJitter`        | `number`  | `200`   | Random jitter (0-200ms) added to each retry                |
| `exponentialBackoff` | `boolean` | `true`  | Use exponential backoff (2^attempt)                        |
| `driftFactor`        | `number`  | `0.01`  | TTL reduction factor (1% safety margin)                    |

#### Retry Delay Calculation

```typescript
// Formula for retry delay
const delay = exponentialBackoff
  ? retryDelay * Math.pow(2, attempt) + Math.random() * retryJitter
  : retryDelay + Math.random() * retryJitter;
```

#### Retry Delay Examples

| Attempt | Base Delay (exponential) | Jitter (0-200ms) | Total Range |
| ------- | ------------------------ | ---------------- | ----------- |
| 0       | 200ms × 2^0 = 200ms      | 0-200ms          | 200-400ms   |
| 1       | 200ms × 2^1 = 400ms      | 0-200ms          | 400-600ms   |
| 2       | 200ms × 2^2 = 800ms      | 0-200ms          | 800-1000ms  |
| 3       | 200ms × 2^3 = 1600ms     | 0-200ms          | 1600-1800ms |
| 4       | 200ms × 2^4 = 3200ms     | 0-200ms          | 3200-3400ms |
| 5       | 200ms × 2^5 = 6400ms     | 0-200ms          | 6400-6600ms |

**Total Time (10 retries)**: ~30-35 seconds

---

### EventSlotReservation Interface

```typescript
export interface EventSlotReservation {
  reservationId: string; // Unique reservation UUID
  slotNumber: number; // Slot number (1 to maxParticipants)
  eventType: string; // Event type (WEBINAR, CLASS)
  eventId: string; // Event identifier
}
```

#### Properties

| Property        | Type     | Description                             | Example               |
| --------------- | -------- | --------------------------------------- | --------------------- |
| `reservationId` | `string` | Unique UUID for this reservation        | `"a3f2b8c1-4d5e-..."` |
| `slotNumber`    | `number` | Slot number in the semaphore (1 to max) | `5`                   |
| `eventType`     | `string` | Type of event being reserved            | `"WEBINAR"`           |
| `eventId`       | `string` | Unique event identifier                 | `"clx123abc"`         |

#### Usage

```typescript
// Reservation returned from acquireEventSlot
const reservation = await acquireEventSlot("WEBINAR", "web123", 50);

if (reservation) {
  console.log(reservation.reservationId); // "a3f2b8c1-..."
  console.log(reservation.slotNumber); // 5
  console.log(reservation.eventType); // "WEBINAR"
  console.log(reservation.eventId); // "web123"

  // On success: confirm the slot
  await confirmEventSlot(reservation);

  // On failure: release the slot
  await releaseEventSlot(reservation);
}
```

---

## Configuration Reference

### Environment Variables

```bash
# .env.local
UPSTASH_REDIS_REST_URL="https://[region]-[name]-[id].upstash.io"
UPSTASH_REDIS_REST_TOKEN="AXmxASQgY..."
```

#### Setup Instructions

1. **Create Upstash Account**: Visit [upstash.com](https://upstash.com)
2. **Create Redis Database**: Dashboard → Create Database → Select region
3. **Copy Credentials**:
   - Click on your database
   - Go to "REST API" tab
   - Copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
4. **Add to Project**: Paste into `.env.local` file

#### Validation

The application validates environment variables at startup:

```typescript
// lib/redis.ts
if (
  !process.env.UPSTASH_REDIS_REST_URL ||
  !process.env.UPSTASH_REDIS_REST_TOKEN
) {
  throw new Error(
    "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set",
  );
}
```

---

### Lock Key Naming Convention

```
Format: {resource-type}-{operation}:{resource-id}
```

#### Examples

```
consultation-approval:clx123abc     # Consultation approval lock
subscription-approval:clx456def     # Subscription approval lock
appointment-lock:clx789ghi          # Appointment booking lock
```

#### Key Namespace Tree

```
Redis Namespace
├── consultation-approval:*             # lockConsultationApproval
│   ├── consultation-approval:clx123
│   └── consultation-approval:clx456
├── subscription-approval:*             # lockSubscriptionApproval
│   ├── subscription-approval:sub123
│   └── subscription-approval:sub456
├── slot-booking:*                      # lockSlotBooking
│   └── slot-booking:{consultantProfileId}:{slotStartISO}
├── event-checkout:*                    # lockEventCheckout
│   └── event-checkout:{TYPE}:{eventOrPlanId}
├── auto-allocate:*                     # lockAutoAllocate (consultant-level)
│   └── auto-allocate:{consultantProfileId}
├── lock:payout_batch_creation          # payout-service.ts — createPayoutBatch cron
├── lock:payout_processing              # payout-service.ts — processPayouts cron
├── org:*:payout-batch                  # org-payout-service.ts — createOrgPayoutBatch (60s)
└── appointment-lock:*                  # lockAppointment (legacy)
    ├── appointment-lock:apt123
    └── appointment-lock:apt456
```

---

### TTL Defaults

| Lock Type                 | Default TTL                                                                        | Effective TTL (after 1% drift) | Use Case                         |
| ------------------------- | ---------------------------------------------------------------------------------- | ------------------------------ | -------------------------------- |
| Consultation Approval     | 60 seconds                                                                         | 59.4 seconds                   | Payment link generation          |
| Subscription Approval     | 60 seconds                                                                         | 59.4 seconds                   | Subscription processing          |
| Slot Booking              | 60 seconds                                                                         | 59.4 seconds                   | Time slot allocation             |
| Event Checkout            | Per-type via `CHECKOUT_LOCK_TTL_MS` (#832): CONSULTATION 60s / SUBSCRIPTION 120s / WEBINAR 120s / CLASS 300s | varies                         | Webinar/class/subscription checkout |
| Auto-Allocate             | 150 seconds (consultant-level; NOT narrowed per slot — #860 tracks that)           | ~148.5 seconds                 | Auto-allocation serialization    |
| Event Slot (Semaphore)    | 5 minutes                                                                          | 4.95 minutes                   | Multi-participant payment window |
| Appointment Lock (Legacy) | 5 minutes                                                                          | 4.95 minutes                   | Complex time slot allocation     |
| Payout Batch Creation     | 2 minutes (`lock:payout_batch_creation`)                                           | ~1.98 minutes                  | Consultant payout batch cron     |
| Payout Processing         | 5 minutes (`lock:payout_processing`)                                               | 4.95 minutes                   | Consultant payout disbursement   |
| Org Payout Batch          | 60 seconds (`org:{orgId}:payout-batch`)                                            | 59.4 seconds                   | Per-org payout batch creation    |

#### TTL Selection Guidelines

1. **Measure your operation duration** (average + P99)
2. **Add 15-20% buffer** for retries and network variability
3. **Round up** to nearest 5 or 10 seconds
4. **Consider clock drift** (1% reduction applied automatically)

**Examples**:

- Operation takes 8-12s → Use 15s TTL
- Operation takes 30-40s → Use 60s TTL (default)
- Operation takes 60-90s → Use 120s TTL + lock extension

---

### Clock Drift Protection

```typescript
// Automatic TTL adjustment
const requestedTTL = 60000; // 60 seconds
const driftFactor = 0.01; // 1% safety margin
const effectiveTTL = Math.floor(requestedTTL * (1 - driftFactor));
// effectiveTTL = 59400ms (59.4 seconds)
```

**Why?** Prevents lock expiration race conditions in distributed systems with unsynchronized clocks.

---

## Best Practices

### ✅ DO

#### 1. Always Use try-finally Pattern

```typescript
let lock;
try {
  lock = await lockConsultationApproval(consultationId);
  // Critical section
} finally {
  if (lock) await unlockApproval(lock);
}
```

#### 2. Set TTL ≥ Operation Duration

```typescript
// Measure your operation
const startTime = Date.now();
await performApproval();
const duration = Date.now() - startTime;
console.log(`Operation took ${duration}ms`);

// Add 20% buffer
const safeTTL = Math.ceil(duration * 1.2);
lock = await lockConsultationApproval(consultationId, safeTTL);
```

#### 3. Log Lock Operations

```typescript
// Structured logs are automatic
lock = await lockConsultationApproval(consultationId);
// Logs: {"event":"lock_acquired","duration_ms":78,...}
```

#### 4. Handle 409 Conflict Gracefully

```typescript
try {
  lock = await lockConsultationApproval(consultationId);
} catch (error) {
  return Response.json(
    {
      error: "Another approval in progress",
      message: "Please try again in a few seconds",
      retryAfter: 3,
    },
    { status: 409 },
  );
}
```

#### 5. Use Lock Extension for Long Operations

```typescript
// ✅ Good: Extend lock for long operations
const lock = await lockConsultationApproval(consultationId, 60000);
const heartbeat = setInterval(() => extendLock(lock, 30000), 20000);
try {
  await longRunningOperation(); // May take > 60s
} finally {
  clearInterval(heartbeat);
  await unlockApproval(lock);
}

// ❌ Bad: Hope operation completes before TTL
const lock = await lockConsultationApproval(consultationId, 30000);
await veryLongOperation(); // May fail if > 30s
```

---

### ❌ DON'T

#### 1. Don't Acquire Locks Without finally

```typescript
// ❌ BAD: Exception prevents unlock
lock = await lockConsultationApproval(consultationId);
await performApproval(); // Throws exception
await unlockApproval(lock); // Never executed!
```

#### 2. Don't Ignore Lock Acquisition Failures

```typescript
// ❌ BAD: Silently proceed without lock
let lock;
try {
  lock = await lockConsultationApproval(consultationId);
} catch (error) {
  console.error(error); // Just log?
}
// Proceeds without lock protection! Race condition!
```

#### 3. Don't Use Locks for Long-Running Operations (>5 minutes)

```typescript
// ❌ BAD: 30-minute TTL
lock = await lockConsultationApproval(consultationId, 30 * 60 * 1000);
// Blocks all concurrent requests for 30 minutes!

// ✅ GOOD: Redesign as async job
await queueApprovalJob(consultationId);
// Process asynchronously, no lock needed
```

#### 4. Don't Manually Delete Locks

```typescript
// ❌ BAD: Direct Redis manipulation
await redis.del(`consultation-approval:${consultationId}`);
// Bypasses ownership verification!

// ✅ GOOD: Use unlockApproval
await unlockApproval(lock);
// Verifies ownership before deleting
```

#### 5. Don't Assume Immediate Availability After Release

```typescript
// ❌ BAD: Assumes immediate availability
await unlockApproval(lock1);
lock2 = await lockConsultationApproval(consultationId); // Might fail due to network delay!

// ✅ GOOD: Use existing lock or retry
await performSecondOperation(); // Use lock1
await unlockApproval(lock1); // Then release
```

---

## Related Documentation

- **[README](./00_README.md)**: Quick start guide and overview
- **[Migration Guide](./01_MIGRATION_GUIDE.md)**: Migrating from Redlock to Upstash
- **[Upstash Redis Docs](https://upstash.com/docs/redis)**: Official Upstash documentation
- **[Redis SET Command](https://redis.io/commands/set/)**: Understanding SET NX PX

---

**Questions?** See [Migration Guide](./01_MIGRATION_GUIDE.md) for architecture details and troubleshooting.
