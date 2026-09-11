import redis, {
  acquireLock,
  releaseLock,
  isMockRedis,
  checkRedisHealth,
  isRedisCircuitOpen,
} from "@/lib/redis";
import {
  CronLockHeldError,
  CronLockUnavailableError,
} from "@/lib/cron/cron-lock-errors";

/**
 * #476 — distributed mutual exclusion for cron job entries. Schedule overlap,
 * workflow_dispatch re-runs, and the GH-Actions + CRON_SECRET HTTP double
 * entry can all run the same job twice; jobs whose side effects are only
 * partially idempotent (dunning emails, notify fan-outs) must not double-run.
 *
 * This wraps the CORE function (scripts/** or lib/**) so every entry point
 * inherits the lock. It is for mutual exclusion only — data correctness comes
 * from the CAS transitions and unique constraints, never from this lock
 * (Redis is a different failure domain than Postgres; see ADR 13).
 */

// The error types live in a leaf module so an `instanceof` check does not drag
// lib/redis (which throws at import without Upstash env) in with it. Re-exported
// here because ~44 call sites already import them from this path. (#1066)
export { CronLockHeldError, CronLockUnavailableError };

const DEFAULT_TTL_MS = 15 * 60 * 1000; // workflows set timeout-minutes: 10
/** Payout/reconcile family runs up to 30 min (ADR 05) — lock must outlive it. */
export const LONG_JOB_TTL_MS = 35 * 60 * 1000;

export interface CronLockOpts {
  ttlMs?: number;
  /**
   * closed — money jobs: without a real lock the job refuses to run and the
   *   workflow's notify-on-failure step pages (silent unlocked double-runs of
   *   dunning/payout sweeps are worse than a missed schedule).
   * open — cleanup/alert jobs: run unlocked with a warning when Redis is
   *   absent; their side effects are harmless to repeat.
   */
  failMode: "open" | "closed";
}

/** #697 — errorLog is @db.Text but a stack dump has no business being unbounded. */
const ERROR_LOG_MAX_CHARS = 8_000;

/** Fleet-level dead-man key (#866): every locked run refreshes it, so
 * /api/health can flag >6h of total cron silence without the Actions API. */
const HEARTBEAT_KEY = "cron:heartbeat:last";

/**
 * #697 INF-2 — SystemJobExecution trail, written inside the lock so a held-lock
 * skip leaves no row. Every step is guarded (dynamic import included): the
 * trail must never fail a job, and a workflow without a generated Prisma
 * client or DATABASE_URL must degrade to "no trail", not to a crash.
 */
async function recordJobStart(jobName: string): Promise<string | null> {
  try {
    const { default: prisma } = await import("@/lib/prisma");
    const row = await prisma.systemJobExecution.create({
      data: {
        jobId: jobName, // no job-config table exists; jobName doubles as the id
        jobName,
        status: "RUNNING",
        triggeredBy: process.env.GITHUB_ACTIONS ? "github-actions" : "manual",
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    console.warn(`[${jobName}] job-trail start write failed:`, err);
    return null;
  }
}

async function recordJobFinish(
  jobName: string,
  executionId: string | null,
  startedAtMs: number,
  error?: unknown,
): Promise<void> {
  if (!executionId) return;
  try {
    const { default: prisma } = await import("@/lib/prisma");
    await prisma.systemJobExecution.update({
      where: { id: executionId },
      data: {
        status: error === undefined ? "COMPLETED" : "FAILED",
        endedAt: new Date(),
        durationMs: Date.now() - startedAtMs,
        errorLog:
          error === undefined
            ? undefined
            : String(
                error instanceof Error ? (error.stack ?? error.message) : error,
              ).slice(0, ERROR_LOG_MAX_CHARS),
      },
    });
  } catch (err) {
    console.warn(`[${jobName}] job-trail finish write failed:`, err);
  }
}

async function touchHeartbeat(jobName: string): Promise<void> {
  try {
    await redis.set(HEARTBEAT_KEY, new Date().toISOString());
  } catch (err) {
    console.warn(`[${jobName}] heartbeat write failed:`, err);
  }
}

export async function withCronLock<T>(
  jobName: string,
  opts: CronLockOpts,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `cron:lock:${jobName}`;

  if (isMockRedis()) {
    if (opts.failMode === "closed") throw new CronLockUnavailableError(jobName);
    console.warn(
      `[${jobName}] Redis not configured — running UNLOCKED (fail-open)`,
    );
    // No trail/heartbeat on this path: mock Redis means a laptop or a test,
    // and the trail exists for the deployed fleet.
    return fn();
  }

  // acquireLock returns null for BOTH "held" and "circuit open". Held is a
  // clean skip; an unreachable Redis on a fail-closed job must page instead —
  // otherwise money jobs freeze silently for as long as the outage lasts.
  if (opts.failMode === "closed") {
    const healthy = await checkRedisHealth();
    if (!healthy) throw new CronLockUnavailableError(jobName);
  }

  const token = await acquireLock(key, opts.ttlMs ?? DEFAULT_TTL_MS);
  if (!token) {
    // acquireLock returns null for BOTH "held" and "Redis trouble": the
    // breaker fallback short-circuits to null while OPEN, and during the
    // FIRST FOUR consecutive failures the breaker is still CLOSED while every
    // acquire already fails. The pre-acquire health check cannot see either
    // window (it ran earlier, and it deliberately bypasses the breaker). So
    // on a null token for a fail-closed job we probe Redis AGAIN, right now:
    // unhealthy ⇒ page (CronLockUnavailableError); reachable ⇒ someone really
    // holds the lock (clean CronLockHeldError skip).
    if (opts.failMode === "closed") {
      const healthyNow = await checkRedisHealth();
      if (!healthyNow || isRedisCircuitOpen()) {
        throw new CronLockUnavailableError(jobName);
      }
    }
    throw new CronLockHeldError(jobName);
  }

  const startedAtMs = Date.now();
  await touchHeartbeat(jobName);
  const executionId = await recordJobStart(jobName);

  try {
    const result = await fn();
    await recordJobFinish(jobName, executionId, startedAtMs);
    return result;
  } catch (err) {
    await recordJobFinish(jobName, executionId, startedAtMs, err);
    throw err;
  } finally {
    await releaseLock(key, token); // never throws; TTL is the safety net
  }
}
