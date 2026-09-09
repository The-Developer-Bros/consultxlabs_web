import { Redis } from "@upstash/redis";
import redisClient, {
  withCircuitBreaker,
  checkRedisHealth,
} from "../lib/redis";
import crypto from "crypto";
import { SlotLockError } from "./errors/SlotLockError";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// CN-1 (#676) — retries exhausted because the lock is genuinely HELD (SET NX
// kept returning non-OK), as opposed to a thrown Redis error. Typed so callers
// can tell benign contention apart from an unreachable Redis and decide whether
// to fail open (retry-later) or closed (503). Subclasses Error, so existing
// catch-all callers are unaffected.
export class LockContentionError extends Error {
  constructor(
    readonly key: string,
    readonly attempts: number,
  ) {
    super(`Failed to acquire lock for ${key} after ${attempts} attempts`);
    this.name = "LockContentionError";
  }
}

// CN-1 (#676) — Redis is unreachable / the circuit is open, so NO real lock can
// be taken. The event-checkout path must fail CLOSED (reject) on this rather
// than proceed unlocked: without a lock, two concurrent buyers can both clear
// the same finite event capacity. Mirrors CronLockUnavailableError.
export class EventCheckoutLockUnavailableError extends Error {
  readonly httpStatus = 503 as const;
  readonly code = "EVENT_CHECKOUT_LOCK_UNAVAILABLE" as const;
  constructor(readonly appointmentType: string) {
    super(
      `Cannot secure a checkout lock for this ${appointmentType.toLowerCase()} right now (locking service unavailable). Please try again shortly.`,
    );
    this.name = "EventCheckoutLockUnavailableError";
  }
}

/**
 * B4 — the optimistic capacity pre-check answered SOLD OUT before the mutex.
 * Distinct from EventCheckoutBusyError (someone holds the lock — retryable in
 * seconds): sold-out is a terminal answer until someone cancels, so no
 * retryAfter is offered and the copy says so plainly.
 */
export class EventFullError extends Error {
  readonly httpStatus = 409 as const;
  readonly code = "EVENT_SOLD_OUT" as const;
  constructor(readonly appointmentType: string) {
    super(
      `This ${appointmentType.toLowerCase()} is sold out. Your card was not charged.`,
    );
    this.name = "EventFullError";
  }
}

// #1169 PR 1 — same fail-closed doctrine as EventCheckoutLockUnavailableError,
// for every other booking-path lock (slot intervals, auto-allocate, consultee,
// approvals). Previously these acquired raw and rethrew ANY failure as a
// benign "contention" message, so a Redis outage read as "try again" while the
// caller proceeded to burn 10 backoff attempts per request.
export class BookingLockUnavailableError extends Error {
  readonly httpStatus = 503 as const;
  readonly code = "BOOKING_LOCK_UNAVAILABLE" as const;
  constructor(readonly context: string) {
    super(
      `Cannot secure a booking lock (${context}) right now (locking service unavailable). Please try again shortly.`,
    );
    this.name = "BookingLockUnavailableError";
  }
}

// ============================================================================
// Type Definitions
// ============================================================================

export interface ApprovalLock {
  key: string; // Redis key (e.g., "consultation-approval:clx123")
  value: string; // UUID for safe release verification
  ttl: number; // TTL in milliseconds (60000 = 60 seconds)
  acquiredAt: number; // Timestamp for monitoring
  client: Redis; // Client reference for release
}

interface LockRetryConfig {
  retryCount: number; // Number of retry attempts (default: 10)
  retryDelay: number; // Base delay in ms (default: 200)
  retryJitter: number; // Random jitter in ms (default: 200)
  exponentialBackoff: boolean; // Use exponential backoff (default: true)
  driftFactor: number; // Clock drift factor (default: 0.01)
}

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_RETRY_CONFIG: LockRetryConfig = {
  retryCount: 10,
  retryDelay: 200,
  retryJitter: 200,
  exponentialBackoff: true,
  driftFactor: 0.01,
};

// #1319 — DEFAULT_RETRY_CONFIG waits up to 204.6 s (11 exponential attempts),
// eight times the 26 s function ceiling. Every REQUEST-path acquisition
// (approvals, allocation, consultee, appointment) therefore surfaced
// contention as a 504, never as the structured 409 the client can retry.
// Request paths use this bounded budget (~7 s); DEFAULT stays only for
// callers that genuinely run outside a request.
export const REQUEST_PATH_RETRY_CONFIG: LockRetryConfig = {
  ...DEFAULT_RETRY_CONFIG,
  retryCount: 5,
};

// FIX Issue #2: Increased default TTLs from 15-30s to 60s
// This prevents lock expiration during slow database operations
const DEFAULT_LOCK_TTL = 60000; // 60 seconds

// #832 — one 60s budget cannot cover every checkout shape: a class checkout
// writes N sessions × M slots plus a gateway round-trip and can outlive its
// lock, silently admitting a second buyer. Sized per checkout type (mirrors
// the LONG_JOB_TTL_MS precedent in lib/cron/with-cron-lock.ts); checkout
// also renews once before the gateway call and aborts if ownership is lost.
//
// CLASS additionally carries the documented serverless-freeze worst case
// (bugs/finances/high-concurrency-and-spikes.md): a freeze suspends the
// instance AFTER the single checked renewal while Redis keeps counting the
// TTL down, so at 300s a frozen checkout could lose ownership mid-payment
// and let a second instance enter. 600s consolidates the old end-to-end
// envelope (initial window + the one renewal, ~594s effective after drift)
// into a single grant, so a late freeze cannot outlive ownership. Hard-crash
// stalls stay bounded where it matters: contention losers hold only
// CHECKOUT_WAIT_RETRY_CONFIG (~7s) and get a structured 409, and the
// Serializable recount + #440 GiST constraint remain the correctness
// backstops behind the lock.
export const CHECKOUT_LOCK_TTL_MS: Record<string, number> = {
  CONSULTATION: 60_000,
  SUBSCRIPTION: 120_000,
  WEBINAR: 120_000,
  CLASS: 600_000,
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate a unique lock value using UUID
 */
function generateLockValue(): string {
  return crypto.randomUUID();
}

/**
 * Calculate retry delay with exponential backoff and jitter
 */
function calculateRetryDelay(attempt: number, config: LockRetryConfig): number {
  const baseDelay = config.exponentialBackoff
    ? config.retryDelay * Math.pow(2, attempt)
    : config.retryDelay;
  const jitter = Math.random() * config.retryJitter;
  return baseDelay + jitter;
}

// ============================================================================
// Core Lock Operations
// ============================================================================

/**
 * Acquire a distributed lock with retry logic
 * Uses Upstash-compatible SET NX PX operation
 */
async function acquireLockWithRetry(
  key: string,
  ttl: number,
  config: LockRetryConfig = DEFAULT_RETRY_CONFIG,
): Promise<ApprovalLock> {
  const client = redisClient as Redis;
  const value = generateLockValue();
  const effectiveTTL = Math.floor(ttl * (1 - config.driftFactor));
  const startTime = Date.now();

  for (let attempt = 0; attempt <= config.retryCount; attempt++) {
    try {
      const result = await client.set(key, value, {
        nx: true, // Only set if not exists
        px: effectiveTTL, // TTL in milliseconds
      });

      if (result === "OK") {
        const duration = Date.now() - startTime;
        console.log(
          JSON.stringify({
            event: "lock_acquired",
            key,
            attempts: attempt + 1,
            duration_ms: duration,
            ttl: effectiveTTL,
            timestamp: new Date().toISOString(),
          }),
        );

        return {
          key,
          value,
          ttl: effectiveTTL,
          acquiredAt: Date.now(),
          client,
        };
      }

      // Lock already held, retry
      if (attempt < config.retryCount) {
        const delay = calculateRetryDelay(attempt, config);
        console.log(
          JSON.stringify({
            event: "lock_retry",
            key,
            attempt: attempt + 1,
            delay_ms: delay,
            timestamp: new Date().toISOString(),
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error: unknown) {
      console.error(
        JSON.stringify({
          event: "lock_error",
          key,
          attempt: attempt + 1,
          error: getErrorMessage(error),
          timestamp: new Date().toISOString(),
        }),
      );

      if (attempt === config.retryCount) {
        throw error;
      }
    }
  }

  const totalDuration = Date.now() - startTime;
  // CN-1 — typed contention (lock was HELD, never a Redis error; those rethrow
  // above). The ms detail rides the log, not the message, so the class is clean.
  console.log(
    JSON.stringify({
      event: "lock_contention_exhausted",
      key,
      attempts: config.retryCount + 1,
      duration_ms: totalDuration,
      timestamp: new Date().toISOString(),
    }),
  );
  throw new LockContentionError(key, config.retryCount + 1);
}

// #1169 PR 1 — one guarded front door for every booking lock: health-probe
// fail-closed, breaker-wrapped acquisition, and contention kept OUT of the
// breaker's failure count (a held lock is not a Redis fault). Mirrors the
// lockEventCheckout pattern so the whole module fails the same way.
async function acquireGuarded(
  key: string,
  ttl: number,
  context: string,
  config: LockRetryConfig = REQUEST_PATH_RETRY_CONFIG,
): Promise<ApprovalLock> {
  if (!(await checkRedisHealth())) {
    throw new BookingLockUnavailableError(context);
  }

  let lock: ApprovalLock | LockContentionError;
  try {
    lock = await withCircuitBreaker<ApprovalLock | LockContentionError>(
      async () => {
        try {
          return await acquireLockWithRetry(key, ttl, config);
        } catch (error) {
          if (error instanceof LockContentionError) return error;
          throw error; // Redis I/O error → propagate to the breaker
        }
      },
    );
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        event: "booking_lock_unavailable",
        key,
        context,
        error: getErrorMessage(error),
        timestamp: new Date().toISOString(),
      }),
    );
    throw new BookingLockUnavailableError(context);
  }

  if (lock instanceof LockContentionError) {
    throw lock;
  }
  return lock;
}

/**
 * Release a distributed lock safely using atomic Lua script
 * Never throws - safe for finally blocks
 *
 * FIX Issue #3: Non-atomic lock release
 * Previous implementation used separate GET then DEL commands,
 * which could release another client's lock if TTL expired between operations.
 * Now uses atomic Lua script to check-and-delete in single operation.
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

    const result = await lock.client.eval(script, [lock.key], [lock.value]);

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
  } catch (error: unknown) {
    // Never throw in unlock - log only
    console.error(
      JSON.stringify({
        event: "lock_release_error",
        key: lock.key,
        error: getErrorMessage(error),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

/**
 * Extend lock TTL (heartbeat pattern)
 * Call periodically during long operations to prevent expiration
 *
 * FIX Issue #2: Lock TTL Too Short
 * For long-running operations, this allows extending the lock
 * without releasing and re-acquiring (which could fail).
 */
export async function extendLock(
  lock: ApprovalLock,
  additionalTtl: number = 30000,
): Promise<boolean> {
  try {
    // Atomic extend using Lua script - only if we still own the lock
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;

    const result = await lock.client.eval(
      script,
      [lock.key],
      [lock.value, additionalTtl.toString()],
    );

    if (result === 1) {
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
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        event: "lock_extension_error",
        key: lock.key,
        error: getErrorMessage(error),
        timestamp: new Date().toISOString(),
      }),
    );
    return false;
  }
}

// ============================================================================
// Public API - Approval Payment Locks
// ============================================================================

/**
 * Lock a consultation approval to prevent concurrent approval attempts
 * @param consultationId - The consultation ID to lock
 * @param ttl - Time to live in milliseconds (default 60 seconds)
 * @returns Lock instance (must be released with unlockApproval)
 */
export async function lockConsultationApproval(
  consultationId: string,
  ttl: number = DEFAULT_LOCK_TTL,
): Promise<ApprovalLock> {
  const key = `consultation-approval:${consultationId}`;
  try {
    return await acquireGuarded(key, ttl, "consultation-approval");
  } catch (error) {
    if (error instanceof BookingLockUnavailableError) throw error;
    throw new Error(
      "Lock contention: Another approval is in progress for this consultation. Please try again.",
    );
  }
}

/**
 * #1319 — the approval routes open a 30 s Serializable transaction; a 30 s
 * grant could lapse mid-transaction. TTL must exceed the tx timeout + slack.
 */
export const APPROVAL_LOCK_TTL_MS = 45_000;

/**
 * Lock a subscription approval to prevent concurrent approval attempts
 * @param subscriptionId - The subscription ID to lock
 * @param ttl - Time to live in milliseconds (default 60 seconds)
 * @returns Lock instance (must be released with unlockApproval)
 */
export async function lockSubscriptionApproval(
  subscriptionId: string,
  ttl: number = DEFAULT_LOCK_TTL,
): Promise<ApprovalLock> {
  const key = `subscription-approval:${subscriptionId}`;
  try {
    return await acquireGuarded(key, ttl, "subscription-approval");
  } catch (error) {
    if (error instanceof BookingLockUnavailableError) throw error;
    throw new Error(
      "Lock contention: Another approval is in progress for this subscription. Please try again.",
    );
  }
}

/**
 * #1319 — the pay-link MINT is its own atom, nested under the approval atom.
 * The approval routes mint while they still hold `consultation-approval:` /
 * `subscription-approval:`, so minting under those keys would contend with
 * the caller itself; resend paths mint with no approval lock at all. The old
 * private `lock:approval_payment:` name in approval-payment.ts was this atom
 * under an unguarded single-shot SET NX; it lives here now, guarded.
 * Lock order: approval → mint, never the reverse.
 */
export async function lockApprovalPaymentMint(
  kind: "CONSULTATION" | "SUBSCRIPTION" | "TRIAL",
  id: string,
  ttl: number = DEFAULT_LOCK_TTL,
): Promise<ApprovalLock> {
  const key = `approval-payment-mint:${kind.toLowerCase()}:${id}`;
  try {
    return await acquireGuarded(key, ttl, "approval-payment-mint");
  } catch (error) {
    if (error instanceof BookingLockUnavailableError) throw error;
    throw new Error(
      "Lock contention: a payment link is already being created for this request. Please try again.",
    );
  }
}

/**
 * Release an approval lock
 * @param lock - The lock instance to release
 */
export async function unlockApproval(lock: ApprovalLock): Promise<void> {
  await releaseLock(lock);
}

/** The approval grant lapsed mid-retry; the caller must not keep writing. */
export class ApprovalLockLostError extends Error {
  readonly code = "APPROVAL_LOCK_LOST";
  readonly httpStatus = 409;
  constructor(key: string) {
    super(
      "This request is being processed by another action. Please refresh and try again.",
    );
    this.name = "ApprovalLockLostError";
    this.key = key;
  }
  readonly key: string;
}

/**
 * #1319 — re-grant the approval lock for one more Serializable attempt. Four
 * attempts of up to 40 s each outlive a fixed 45 s grant, and a lapsed grant
 * lets a second approval run the post-commit mint concurrently.
 */
export async function renewApprovalLock(
  lock: ApprovalLock | null | undefined,
  ttl: number = APPROVAL_LOCK_TTL_MS,
): Promise<void> {
  if (!lock) return;
  if (!(await extendLock(lock, ttl))) throw new ApprovalLockLostError(lock.key);
}

// ============================================================================
// Public API - Slot Booking Locks (interval-granular, one namespace)
//
// #1169 PR 1 — two structural fixes in one design:
//
// 1. ONE NAMESPACE PER PHYSICAL RESOURCE. Consultation checkout, the
//    request-for-approval path, and trial scheduling previously locked under
//    THREE different key families (`slot-booking:`, per-instant, and
//    `trial-slot-booking:`), so a trial and a checkout for the same
//    consultant-minute never contended (#1093 §1). Every direct slot writer
//    now locks the same `slot-booking:` atom keys.
//
// 2. INTERVAL KEYS, NOT INSTANT KEYS. A key on the raw `startsAt` instant
//    means a 10:00–12:00 booking and an 11:00–12:00 booking hold DIFFERENT
//    keys and both proceed to payment. Locking one key per 30-minute atom the
//    interval covers makes any overlap collide on its shared atoms.
//
// The allocator (SlotAllocationService) intentionally keeps its coarser
// consultant-wide lock: it discovers slots dynamically under that lock, and
// its write transaction re-validates conflicts and absorbs the #440 exclusion
// constraint (23P01 → 409). The atom keys serialize the DIRECT writers, which
// are the paths that race each other between availability-check and write.
// ============================================================================

const SLOT_ATOM_MS = 30 * 60 * 1000;

// Interval acquisition retries less than a single-key lock: N keys × 10
// exponential retries could pin a request for minutes, and a held atom almost
// always means a genuine concurrent booking on that time — fail toward 409.
const INTERVAL_RETRY_CONFIG: LockRetryConfig = {
  ...DEFAULT_RETRY_CONFIG,
  retryCount: 5,
};

/**
 * Booking-flash-sale budget (audit B4/B8c): checkout waiters must fail FAST,
 * not queue. The worst-case retry chain here is ~6.2s + jitter ≈ 7s —
 * comfortably inside the ~26s function ceiling, so the loser of a hot-slot or
 * hot-event race gets a structured 409 instead of an infrastructure timeout.
 * Holding a checkout lock takes 5-20s (revalidation + gateway call + tx), so
 * waiting longer rarely helps anyway: by the second retry the winner has
 * either committed (re-validation answers definitively) or is minutes from
 * done. Callers that genuinely want to queue can still pass DEFAULT.
 */
export const CHECKOUT_WAIT_RETRY_CONFIG: LockRetryConfig = {
  ...DEFAULT_RETRY_CONFIG,
  retryCount: 5,
};

/**
 * Typed contention for the EVENT-checkout mutex (audit B4). The old throw was
 * a generic Error, which classifyError mislabeled and no client could
 * distinguish from a fault. 409 + retryAfter: another buyer holds the mutex;
 * the pre-check has already answered "sold out" separately.
 */
export class EventCheckoutBusyError extends Error {
  readonly httpStatus = 409 as const;
  readonly retryAfterSeconds = 10;
  readonly code = "EVENT_CHECKOUT_BUSY";
  constructor(readonly appointmentType: string) {
    super(
      `Another user is currently checking out this ${appointmentType.toLowerCase()}. Please try again in a few seconds.`,
    );
    this.name = "EventCheckoutBusyError";
  }
}

/**
 * Typed contention for the CONSULTEE lock (audit B8c): the same account
 * booking from two devices at once — the loser must get a structured 409 in
 * time, not a function timeout wearing a 500's clothes.
 */
export class ConsulteeBookingBusyError extends Error {
  readonly httpStatus = 409 as const;
  readonly retryAfterSeconds = 30;
  readonly code = "CONSULTEE_BOOKING_BUSY";
  constructor() {
    super(
      "Another booking is already in progress for your account. Please try again in a moment.",
    );
    this.name = "ConsulteeBookingBusyError";
  }
}

/**
 * The 30-minute atom starts covering [startsAt, endsAt). Starts are floored to
 * the half-hour grid so an unaligned interval still collides with the aligned
 * bookings it overlaps.
 */
export function slotAtomStarts(startsAt: Date, endsAt: Date): Date[] {
  const floored = Math.floor(startsAt.getTime() / SLOT_ATOM_MS) * SLOT_ATOM_MS;
  const atoms: Date[] = [];
  for (let t = floored; t < endsAt.getTime(); t += SLOT_ATOM_MS) {
    atoms.push(new Date(t));
  }
  return atoms;
}

/**
 * Lock every 30-minute atom of [startsAt, endsAt) for one consultant, in
 * ascending order (total order → no deadlock against another interval).
 * All-or-nothing: on a held atom or a Redis fault, every atom already taken is
 * released before throwing.
 *
 * Throws SlotLockError on genuine contention (fail open — the caller returns
 * a retryable 409/423) and BookingLockUnavailableError when Redis is
 * unreachable (fail closed — no unlocked booking may proceed).
 */
export async function lockSlotInterval(
  consultantProfileId: string,
  startsAt: Date | string,
  endsAt: Date | string,
  ttl: number = DEFAULT_LOCK_TTL,
): Promise<ApprovalLock[]> {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const atoms = slotAtomStarts(start, end);
  if (atoms.length === 0) {
    // toISOString throws on Invalid Date — format defensively so unparseable
    // input surfaces this refusal, not a RangeError from the message itself.
    const fmt = (d: Date, raw: Date | string) =>
      Number.isNaN(d.getTime())
        ? `unparseable(${String(raw)})`
        : d.toISOString();
    throw new Error(
      `lockSlotInterval: empty interval ${fmt(start, startsAt)} → ${fmt(end, endsAt)}`,
    );
  }

  const acquired: ApprovalLock[] = [];
  try {
    for (const atom of atoms) {
      const key = `slot-booking:${consultantProfileId}:${atom.toISOString()}`;
      acquired.push(
        await acquireGuarded(key, ttl, "slot-interval", INTERVAL_RETRY_CONFIG),
      );
    }
    // #1170 review — sequential acquisition erodes the earliest atoms' TTLs
    // (worst case ~57.6s of backoff across 8 atoms vs a 59.4s effective TTL),
    // so atom 1 could expire before the caller's critical section even starts.
    // Re-arm every atom to a fresh shared deadline once the last one is held;
    // a failed re-arm means ownership was already lost — abort, never proceed.
    if (acquired.length > 1) {
      const effectiveTTL = Math.floor(
        ttl * (1 - INTERVAL_RETRY_CONFIG.driftFactor),
      );
      for (const lock of acquired) {
        if (!(await extendLock(lock, effectiveTTL))) {
          throw new LockContentionError(lock.key, 1);
        }
      }
    }
    return acquired;
  } catch (error) {
    // Roll back partial acquisition in reverse before surfacing the failure.
    for (const lock of [...acquired].reverse()) {
      await releaseLock(lock);
    }
    if (error instanceof LockContentionError) {
      const conflictingAtom =
        atoms[acquired.length]?.toISOString() ?? String(startsAt);
      throw new SlotLockError(consultantProfileId, conflictingAtom, 60);
    }
    throw error;
  }
}

/**
 * Release an interval lock. Reverse order, never throws — safe for finally.
 */
export async function unlockSlotInterval(locks: ApprovalLock[]): Promise<void> {
  for (const lock of [...locks].reverse()) {
    await releaseLock(lock);
  }
}

/**
 * Extend every atom of an interval lock (#832 checked-renewal pattern).
 * Returns false if ANY atom's ownership was lost — the caller must abort.
 */
export async function extendSlotInterval(
  locks: ApprovalLock[],
  additionalTtl: number,
): Promise<boolean> {
  for (const lock of locks) {
    if (!(await extendLock(lock, additionalTtl))) return false;
  }
  return true;
}

/**
 * Lock the slot interval for one direct booking write. Named for its history —
 * this is the same lock checkout and request-for-approval always took, now
 * interval-granular and shared with trials.
 */
export async function lockSlotBooking(
  consultantProfileId: string,
  startsAt: string,
  endsAt: string,
  ttl: number = DEFAULT_LOCK_TTL,
): Promise<ApprovalLock[]> {
  return lockSlotInterval(consultantProfileId, startsAt, endsAt, ttl);
}

/**
 * Release a slot booking (interval) lock
 */
export async function unlockSlotBooking(locks: ApprovalLock[]): Promise<void> {
  await unlockSlotInterval(locks);
}

// ============================================================================
// Public API - Event Checkout Locks
// ============================================================================

/**
 * Lock event checkout to prevent concurrent booking attempts
 * Used for webinars, classes, and subscription scheduling periods
 * @param appointmentType - Type of appointment (WEBINAR, CLASS, SUBSCRIPTION)
 * @param eventOrPlanId - Event ID or plan ID to lock
 * @param ttl - Time to live in milliseconds (default 60 seconds)
 * @returns Lock instance (must be released with unlockEventCheckout)
 */
export async function lockEventCheckout(
  appointmentType: string,
  eventOrPlanId: string,
  ttl: number = DEFAULT_LOCK_TTL,
  // B4 — bounded waiter budget for checkout callers (CHECKOUT_WAIT_RETRY_CONFIG).
  // #1319 — no caller may queue for minutes inside a request; the default is
  // the bounded request-path budget now.
  retryConfig: LockRetryConfig = REQUEST_PATH_RETRY_CONFIG,
): Promise<ApprovalLock> {
  const key = `event-checkout:${appointmentType}:${eventOrPlanId}`;

  // CN-1 (#676) — was: catch ALL errors → benign contention message, which
  // failed OPEN (a Redis outage let the caller proceed UNLOCKED and double-book
  // an event's capacity). Now we fail CLOSED on an unreachable Redis. The probe
  // mirrors withCronLock's checkRedisHealth gate and closes the entry window.
  if (!(await checkRedisHealth())) {
    throw new EventCheckoutLockUnavailableError(appointmentType);
  }

  // Acquire through the circuit breaker (same breaker as lib/redis.ts /
  // lib/maintenance.ts) so a mid-flight outage trips it and fails closed too.
  // Genuine contention is returned as a sentinel — NOT thrown — so the breaker
  // doesn't count "lock held" as a Redis failure; only real I/O errors throw
  // inside the operation and feed the breaker.
  let lock: ApprovalLock | "CONTENTION";
  try {
    lock = await withCircuitBreaker<ApprovalLock | "CONTENTION">(async () => {
      try {
        return await acquireLockWithRetry(key, ttl, retryConfig);
      } catch (error) {
        if (error instanceof LockContentionError) return "CONTENTION";
        throw error; // Redis I/O error → propagate to the breaker
      }
    });
  } catch (error: unknown) {
    // Circuit open or Redis unreachable during acquisition → fail closed.
    // #873 — log the original cause so triage can tell a real Redis outage
    // from another fault before rethrowing the opaque typed error.
    console.error(
      JSON.stringify({
        event: "event_checkout_lock_unavailable",
        key,
        appointmentType,
        error: getErrorMessage(error),
        timestamp: new Date().toISOString(),
      }),
    );
    throw new EventCheckoutLockUnavailableError(appointmentType);
  }

  if (lock === "CONTENTION") {
    // Genuine contention — another buyer holds the mutex. Fail OPEN
    // (retry-later): benign, expected, and now TYPED so the route can answer
    // a structured 409 with retryAfter instead of classifyError guessing.
    throw new EventCheckoutBusyError(appointmentType);
  }

  return lock;
}

/**
 * Release an event checkout lock
 * @param lock - The lock instance to release
 */
export async function unlockEventCheckout(lock: ApprovalLock): Promise<void> {
  await releaseLock(lock);
}

// ============================================================================
// Public API - Appointment Locks (cancel / reschedule)
// #1319 — this used to be the last raw acquisition in the module (no health
// probe, no breaker: it failed OPEN on a Redis outage) and had no callers.
// Cancel and reschedule now take it, through the same guarded front door as
// every other booking lock, so a stale tab and a live cancel serialize
// instead of racing the CAS.
// ============================================================================

/** Cancel/reschedule hold a 25 s transaction; the grant must outlive it. */
export const APPOINTMENT_LOCK_TTL_MS = 75_000; // reschedule tx 60 s + maxWait; cancel 40 s

export class AppointmentBusyError extends Error {
  readonly httpStatus = 423 as const;
  readonly code = "APPOINTMENT_BUSY" as const;
  constructor(readonly appointmentId: string) {
    super("This appointment is being updated. Please try again in a moment.");
    this.name = "AppointmentBusyError";
  }
}

/**
 * Lock one appointment for a lifecycle mutation. Order: this is the coarsest
 * key and is taken FIRST (event/consultant → consultee → slot).
 */
export async function lockAppointment(
  appointmentId: string,
  ttl: number = APPOINTMENT_LOCK_TTL_MS,
): Promise<ApprovalLock> {
  const key = `appointment-lock:${appointmentId}`;
  try {
    return await acquireGuarded(key, ttl, "appointment");
  } catch (error) {
    if (error instanceof BookingLockUnavailableError) throw error;
    throw new AppointmentBusyError(appointmentId);
  }
}

/** Release an appointment lock (never throws — safe in finally). */
export async function unlockAppointment(lock: ApprovalLock): Promise<void> {
  await releaseLock(lock);
}

/** Run one lifecycle mutation under the appointment lock; always releases. */
export async function withAppointmentLock<T>(
  appointmentId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await lockAppointment(appointmentId);
  try {
    return await fn();
  } finally {
    await unlockAppointment(lock);
  }
}

// ============================================================================
// (Removed) Trial Slot Booking Locks — #1169 PR 1
// Trials previously locked under `trial-slot-booking:`, a namespace nothing
// else read, so a trial never contended with a checkout for the same minute.
// The trial route now takes lockSlotBooking (the shared atom keys) instead.
// ============================================================================

// ============================================================================
// Public API - Auto-Allocation Locks
// FIX Issue #1 from Architecture Review (#446):
// autoAllocate() had NO distributed lock — double-booking via race condition
// ============================================================================

/**
 * Lock auto-allocation for a specific consultant to prevent concurrent
 * auto-allocations from double-booking the same slots.
 *
 * WHY CONSULTANT-LEVEL (not per-slot):
 * autoAllocate() discovers slots dynamically inside the transaction,
 * so per-slot locks can't be acquired upfront. Since auto-allocate
 * searches a consultant's ENTIRE availability pool, two concurrent
 * auto-allocations for the same consultant MUST be serialized.
 *
 * @param consultantProfileId - The consultant's profile ID
 * @param ttl - Time to live in milliseconds (default 120s to match transaction timeout)
 * @returns Lock instance (must be released with unlockAutoAllocate)
 */
export async function lockAutoAllocate(
  consultantProfileId: string,
  // #860 — optional day/slot-range scope. When the target day is known upfront
  // (manual allocation), sharding the key lets non-overlapping-day allocations
  // for one consultant run in parallel instead of all serializing. autoAllocate
  // omits it (slots are discovered dynamically UNDER the lock) and stays
  // consultant-wide. #440's GiST exclusion constraint is the correctness
  // backstop for any residual cross-day overlap.
  scope?: string,
  ttl: number = 150000, // 150s — 30s buffer over 120s transaction timeout (after 1% drift: ~148.5s)
): Promise<ApprovalLock> {
  const key = scope
    ? `auto-allocate:${consultantProfileId}:${scope}`
    : `auto-allocate:${consultantProfileId}`;
  try {
    return await acquireGuarded(key, ttl, "auto-allocate");
  } catch (error) {
    if (error instanceof BookingLockUnavailableError) throw error;
    throw new Error(
      "Lock contention: Another auto-allocation is in progress for this consultant. Please try again.",
    );
  }
}

/**
 * Release an auto-allocation lock
 * @param lock - The lock instance to release
 */
export async function unlockAutoAllocate(lock: ApprovalLock): Promise<void> {
  await releaseLock(lock);
}

// ============================================================================
// Public API - Consultee Booking Locks
// #898 follow-up — the GiST exclusion constraint `slot_no_confirmed_overlap`
// is keyed on consultantProfileId, so it CANNOT stop the SAME consultee being
// booked across two DIFFERENT consultants at overlapping times. The AE-1
// consultee-calendar conflict check (SlotValidationService.validateNoConflicts)
// runs at Read-Committed with no consultee lock, leaving a check-then-write
// window under concurrent checkout. This lock serializes booking activity for
// one consultee (different consultees stay fully parallel) so the
// consultee-conflict-check → slot write is atomic.
// ============================================================================

/**
 * Lock all booking activity for a single consultee so concurrent bookings
 * (across different consultants) cannot both pass the consultee-calendar
 * conflict check and overcommit the same person.
 *
 * Keyed on consulteeUserId ONLY — different consultees never contend.
 *
 * LOCK ORDER (deadlock avoidance): always acquired AFTER the consultant-level
 * lock (lockAutoAllocate / lockEventCheckout) and BEFORE any per-slot lock.
 * Every booking path follows the same consultant → consultee → slot order, so
 * the locks form a total order and cannot cycle.
 *
 * @param consulteeUserId - The consultee's user ID
 * @param ttl - Time to live in ms (default 150s — matches lockAutoAllocate so it
 *   spans the allocation transaction)
 */
export async function lockConsulteeBooking(
  consulteeUserId: string,
  ttl: number = 150000,
  // B8c / #1319 — bounded for every caller: an allocation or approval that
  // waits three minutes for this key dies at the function ceiling anyway.
  retryConfig: LockRetryConfig = REQUEST_PATH_RETRY_CONFIG,
): Promise<ApprovalLock> {
  const key = `consultee-booking:${consulteeUserId}`;
  try {
    return await acquireGuarded(key, ttl, "consultee-booking", retryConfig);
  } catch (error) {
    if (error instanceof BookingLockUnavailableError) throw error;
    // Typed contention (B8c): the same account booking from two devices —
    // the loser gets a structured 409 in time, never a timeout wearing 500.
    throw new ConsulteeBookingBusyError();
  }
}

/**
 * Release a consultee booking lock
 * @param lock - The lock instance to release
 */
export async function unlockConsulteeBooking(
  lock: ApprovalLock,
): Promise<void> {
  await releaseLock(lock);
}
