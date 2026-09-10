/**
 * Upstash Redis Client
 *
 * This module provides:
 * - Redis client for distributed locking (used by appointmentlock.ts)
 * - Circuit breaker pattern to handle Redis failures gracefully
 * - Simple lock/unlock utilities
 *
 * NOTE: API rate limiting is handled by Arcjet at the route level.
 * This module focuses on Redis operations for distributed state management.
 *
 * Mock Mode:
 * - Set USE_MOCK_REDIS=true for local development without Upstash credentials
 * - Automatically enabled when NODE_ENV=test
 * - Mock provides in-memory Redis with full Lua script support
 */

import * as Sentry from "@sentry/nextjs";
import { Redis } from "@upstash/redis";
import crypto from "crypto";
import { getMockRedis, MockRedis } from "./redis-mock";

// Check if we should use mock Redis
const USE_MOCK_REDIS =
  process.env.USE_MOCK_REDIS === "true" || process.env.NODE_ENV === "test";

// Type that represents either real Redis or MockRedis
type RedisClient = Redis | MockRedis;

let redis: RedisClient;

if (USE_MOCK_REDIS) {
  // Use mock Redis for local dev and tests
  console.log(
    JSON.stringify({
      event: "redis_mock_enabled",
      reason:
        process.env.NODE_ENV === "test"
          ? "NODE_ENV=test"
          : "USE_MOCK_REDIS=true",
      timestamp: new Date().toISOString(),
    }),
  );
  redis = getMockRedis();
} else {
  // Validate environment variables for real Redis
  if (
    !process.env.UPSTASH_REDIS_REST_URL ||
    !process.env.UPSTASH_REDIS_REST_TOKEN
  ) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set (or use USE_MOCK_REDIS=true for local dev)",
    );
  }

  // Initialize real Upstash Redis client
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

// ============================================================================
// Circuit Breaker Pattern
// Prevents cascading failures when a backing service is unavailable
// ============================================================================

interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  halfOpenSuccesses: number;
}

const CIRCUIT_CONFIG = {
  failureThreshold: 5, // Open after 5 consecutive failures
  resetTimeout: 30000, // Try again after 30 seconds
  halfOpenSuccessThreshold: 3, // Close after 3 successful half-open requests
};

export interface CircuitBreaker {
  /** Run `operation` under this breaker. See {@link withCircuitBreaker}. */
  run<T>(
    operation: () => Promise<T>,
    fallback?: () => T,
    shouldTrip?: (error: unknown) => boolean,
  ): Promise<T>;
  /** Current state, for health endpoints and monitoring dashboards. */
  status(): {
    name: string;
    state: string;
    failures: number;
    lastFailure: number | null;
  };
  /** Force back to CLOSED. Admin escape hatch, not part of normal operation. */
  reset(): void;
}

/**
 * #1280 2.1 — one breaker per backing service, not one breaker for all of them.
 *
 * There used to be a single module-level `circuitBreaker` object here, and
 * `lib/stream-client.ts` routed every Stream call through it. The coupling ran
 * in both directions and both were wrong:
 *
 *   - Five Stream failures opened it, and `utils/appointmentlock.ts` acquires
 *     booking locks through the same breaker — so a VIDEO VENDOR OUTAGE STOPPED
 *     CHECKOUT. Nothing about Redis was unhealthy.
 *   - A Redis outage surfaced to users as "Video is temporarily unavailable",
 *     and `/api/health` attributed it to Stream, pointing whoever was on call at
 *     the wrong vendor during an incident.
 *   - Counts interleaved, so three Stream errors plus two Redis errors tripped a
 *     breaker that neither service had failed five times to earn.
 *
 * The breaker is close to inert today: state is per-instance, serverless
 * instances are short-lived, and one rarely accumulates five failures before it
 * dies. That is precisely why this is worth fixing and the thresholds are not —
 * the coupling is a correctness bug that will bite exactly once, under load,
 * during someone else's outage. #1280 Bucket 4 says leave the numbers alone.
 *
 * Each instance owns its own state. Nothing is shared but the config.
 */
export function createCircuitBreaker(name: string): CircuitBreaker {
  const circuitBreaker: CircuitBreakerState = {
    failures: 0,
    lastFailure: 0,
    state: "CLOSED",
    halfOpenSuccesses: 0,
  };

  const log = (level: "log" | "warn" | "error", fields: object) => {
    console[level](
      JSON.stringify({
        breaker: name,
        timestamp: new Date().toISOString(),
        ...fields,
      }),
    );
  };

  /**
   * Is the breaker refusing right now?
   *
   * Also owns the OPEN→HALF_OPEN transition, because "has the reset window
   * elapsed" and "should this call be refused" are the same question asked
   * once. Split out of `run` for SonarCloud's cognitive-complexity gate — the
   * combined version was 21 against a limit of 15, and a breaker whose state
   * machine is hard to read is a bad thing to own.
   */
  function isRefusing(): boolean {
    if (circuitBreaker.state !== "OPEN") return false;

    const timeSinceFailure = Date.now() - circuitBreaker.lastFailure;
    if (timeSinceFailure > CIRCUIT_CONFIG.resetTimeout) {
      circuitBreaker.state = "HALF_OPEN";
      circuitBreaker.halfOpenSuccesses = 0;
      log("log", { event: "circuit_breaker_half_open" });
      return false;
    }

    log("warn", {
      event: "circuit_breaker_rejected",
      remaining_ms: CIRCUIT_CONFIG.resetTimeout - timeSinceFailure,
    });
    return true;
  }

  /** Advance the state machine on a successful call. */
  function recordSuccess(): void {
    if (circuitBreaker.state === "HALF_OPEN") {
      circuitBreaker.halfOpenSuccesses++;
      if (
        circuitBreaker.halfOpenSuccesses >=
        CIRCUIT_CONFIG.halfOpenSuccessThreshold
      ) {
        circuitBreaker.state = "CLOSED";
        circuitBreaker.failures = 0;
        circuitBreaker.halfOpenSuccesses = 0;
        log("log", {
          event: "circuit_breaker_closed",
          reason: "successful_half_open_tests",
        });
      }
      return;
    }
    if (circuitBreaker.state === "CLOSED" && circuitBreaker.failures > 0) {
      circuitBreaker.failures = 0;
    }
  }

  /** Advance the state machine on a failure that counts. */
  function recordFailure(): void {
    circuitBreaker.failures++;
    circuitBreaker.lastFailure = Date.now();

    if (circuitBreaker.state === "HALF_OPEN") {
      circuitBreaker.state = "OPEN";
      circuitBreaker.halfOpenSuccesses = 0;
      log("error", {
        event: "circuit_breaker_reopened",
        reason: "half_open_failure",
      });
      return;
    }
    if (circuitBreaker.failures >= CIRCUIT_CONFIG.failureThreshold) {
      circuitBreaker.state = "OPEN";
      log("error", {
        event: "circuit_breaker_opened",
        failures: circuitBreaker.failures,
      });
      Sentry.logger.warn(
        Sentry.logger
          .fmt`${name} circuit breaker: opened after ${circuitBreaker.failures} failures`,
      );
    }
  }

  async function run<T>(
    operation: () => Promise<T>,
    fallback?: () => T,
    shouldTrip?: (error: unknown) => boolean,
  ): Promise<T> {
    if (isRefusing()) {
      if (fallback) return fallback();
      // The message is load-bearing: `withStreamCircuitBreaker` matches on
      // "circuit breaker is OPEN" to tell a fast-fail from a real error.
      throw new Error(`${name} circuit breaker is OPEN - service unavailable`);
    }

    try {
      const result = await operation();
      recordSuccess();
      return result;
    } catch (error) {
      // #899 — a caller-classified expected error (e.g. Stream "channel not
      // found") proves the backend is up; rethrow without touching breaker
      // state so 404-style misses don't dilute the outage signal.
      if (shouldTrip && !shouldTrip(error)) throw error;

      recordFailure();
      if (fallback) return fallback();
      throw error;
    }
  }

  function reset(): void {
    circuitBreaker.state = "CLOSED";
    circuitBreaker.failures = 0;
    circuitBreaker.lastFailure = 0;
    circuitBreaker.halfOpenSuccesses = 0;
    console.log(
      JSON.stringify({
        event: "circuit_breaker_reset",
        breaker: name,
        reason: "manual_reset",
        timestamp: new Date().toISOString(),
      }),
    );
  }

  return {
    run,
    reset,
    status: () => ({
      name,
      state: circuitBreaker.state,
      failures: circuitBreaker.failures,
      lastFailure:
        circuitBreaker.lastFailure > 0 ? circuitBreaker.lastFailure : null,
    }),
  };
}

/** The breaker guarding Redis itself. Stream has its own — see lib/stream-client.ts. */
const redisCircuitBreaker = createCircuitBreaker("redis");

/**
 * Execute a REDIS operation with circuit breaker protection.
 *
 * Circuit Breaker States:
 * - CLOSED: Normal operation, all requests go through
 * - OPEN: Redis is failing, fail fast without attempting
 * - HALF_OPEN: Testing if Redis is back, limited requests
 *
 * Callers reaching a DIFFERENT service must not use this — take an instance
 * from {@link createCircuitBreaker} instead, or a Redis outage and theirs will
 * trip each other. That was #1280 2.1.
 *
 * @param operation - The Redis operation to execute
 * @param fallback - Optional fallback value if circuit is open
 * @param shouldTrip - Optional predicate; when it returns false for a thrown
 *   error, that error is rethrown WITHOUT counting toward the breaker (an
 *   expected/application-level failure is not an outage). Defaults to "trip on
 *   any error".
 * @returns Result of operation or fallback
 */
export async function withCircuitBreaker<T>(
  operation: () => Promise<T>,
  fallback?: () => T,
  shouldTrip?: (error: unknown) => boolean,
): Promise<T> {
  return redisCircuitBreaker.run(operation, fallback, shouldTrip);
}

/**
 * Check Redis health (for monitoring and health endpoints)
 * @returns True if Redis is healthy, false otherwise
 */
// #1319 — every guarded lock acquisition opened with a PING, and an interval
// lock acquires one atom at a time, so a single consultation booking paid up
// to a dozen probe round-trips to learn the same thing. Cache the answer per
// instance for 2 s: short enough that a real outage still fails closed within
// one attempt, long enough to make the probe free inside one request. A stale
// negative can only produce a retryable 503, never an unlocked booking.
const HEALTH_CACHE_MS = 2_000;
let healthCachedAt = 0;
let healthCachedValue = false;

export async function checkRedisHealth(force = false): Promise<boolean> {
  const now = Date.now();
  if (!force && now - healthCachedAt < HEALTH_CACHE_MS) {
    return healthCachedValue;
  }
  try {
    const result = await redis.ping();
    healthCachedValue = result === "PONG";
  } catch {
    healthCachedValue = false;
  }
  healthCachedAt = now;
  return healthCachedValue;
}

/**
 * Get the REDIS circuit breaker status (for monitoring dashboards).
 *
 * Named for what it reports. It used to describe "the" breaker, back when there
 * was one for everything — which is how `/api/health` came to blame Stream for
 * a Redis outage (#1280 2.1). Stream's breaker reports itself.
 */
export function getCircuitBreakerStatus(): {
  state: string;
  failures: number;
  lastFailure: number | null;
} {
  const { state, failures, lastFailure } = redisCircuitBreaker.status();
  return { state, failures, lastFailure };
}

/**
 * Manually reset circuit breaker (for admin operations)
 */
export function resetCircuitBreaker(): void {
  redisCircuitBreaker.reset();
}

// ============================================================================
// Simple Lock/Unlock (for distributed locking)
// ============================================================================

/**
 * Acquire a simple lock with circuit breaker protection.
 *
 * When Redis is reachable: standard SET NX PX locking.
 * When Redis is unreachable / budget exhausted:
 *   - Circuit breaker trips after 5 consecutive failures
 *   - Returns null (= "lock not acquired") instead of crashing
 *   - Callers already handle null by telling the user to retry later
 *   - After 30 seconds, half-open probes test if Redis is back
 *
 * This means a Redis outage degrades to "temporarily cannot start
 * new payout batches / approval payments" rather than a 500 crash.
 *
 * @param key - The lock key
 * @param ttl - Time to live in milliseconds
 * @returns Lock token if acquired, null if locked or Redis unavailable
 */
export async function acquireLock(
  key: string,
  ttl: number,
): Promise<string | null> {
  return withCircuitBreaker(
    async () => {
      const token = crypto.randomUUID();
      const result = await redis.set(key, token, { nx: true, px: ttl });
      return result === "OK" ? token : null;
    },
    // Fallback when circuit is open: return null (= lock not acquired).
    // The caller's existing "try again later" message handles this gracefully.
    () => {
      console.warn(
        JSON.stringify({
          event: "lock_acquire_circuit_open",
          key,
          message:
            "Redis unavailable, returning null (lock not acquired). Caller will ask user to retry.",
          timestamp: new Date().toISOString(),
        }),
      );
      return null;
    },
  );
}

/**
 * True when the module-level circuit breaker is OPEN — Redis operations are
 * being short-circuited to their fallbacks without touching the server.
 *
 * `acquireLock` returns null for BOTH "lock genuinely held" and "breaker
 * open, acquire never ran", and `checkRedisHealth` deliberately bypasses the
 * breaker — so a caller that health-checks first can misread an open breaker
 * as a held lock. `withCronLock` uses this to make a fail-closed money job
 * PAGE (CronLockUnavailableError) instead of silently skipping.
 */
export function isRedisCircuitOpen(): boolean {
  return redisCircuitBreaker.status().state === "OPEN";
}

/**
 * Release a simple lock with circuit breaker protection.
 *
 * Uses atomic Lua script to check-and-delete, preventing release of
 * another client's lock. If Redis is unreachable, the lock will
 * expire naturally via its TTL — no data inconsistency, just a brief
 * period where the resource stays locked until TTL elapses.
 *
 * Never throws — safe for finally blocks.
 *
 * @param key - The lock key
 * @param token - The lock token (for safe release)
 */
export async function releaseLock(key: string, token: string): Promise<void> {
  try {
    await withCircuitBreaker(
      async () => {
        const script = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
          else
            return 0
          end
        `;
        await redis.eval(script, [key], [token]);
      },
      // Fallback: if Redis is down, the lock expires via TTL. Log and move on.
      () => {
        console.warn(
          JSON.stringify({
            event: "lock_release_circuit_open",
            key,
            message:
              "Redis unavailable, lock will expire via TTL. No action needed.",
            timestamp: new Date().toISOString(),
          }),
        );
      },
    );
  } catch (error) {
    // Never throw in release — log only. The lock's TTL is the safety net.
    console.error(
      JSON.stringify({
        event: "lock_release_error",
        key,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "redis" } },
    );
  }
}

/**
 * Check if mock Redis is being used
 */
export function isMockRedis(): boolean {
  return USE_MOCK_REDIS;
}

/**
 * Reset mock Redis state (for testing)
 * No-op if using real Redis
 */
export function resetRedisForTesting(): void {
  if (USE_MOCK_REDIS && redis instanceof MockRedis) {
    redis.clear();
  }
}

export default redis;
