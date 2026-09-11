/**
 * The two cron-lock outcome types, kept in a LEAF module with no imports.
 *
 * They used to live in `with-cron-lock.ts`, which imports `lib/redis` — and
 * `lib/redis` throws at module load when the Upstash env vars are missing. That
 * meant a module wanting nothing more than an `instanceof` check inherited a
 * hard Upstash dependency at import time. `lib/observability/job-sentry.ts`
 * needs exactly that check and is imported by every job, so the classes moved
 * down here. `with-cron-lock.ts` re-exports them, so existing importers are
 * unaffected and `instanceof` identity is preserved. (#1066)
 */

/** Another replica already holds the lock — the run is a clean skip, not a failure. */
export class CronLockHeldError extends Error {
  readonly httpStatus = 409 as const;
  readonly code = "CRON_LOCK_HELD" as const;
  constructor(readonly jobName: string) {
    super(`${jobName} is already running — skipped (cron lock held)`);
    this.name = "CronLockHeldError";
  }
}

/**
 * A fail-closed job refused to run because no real Redis lock is possible.
 *
 * Deliberately NOT a subclass of CronLockHeldError: a job that cannot obtain a
 * lock has not been skipped by a healthy sibling, it has failed, and it must
 * still page. `runJobWithSentry` only treats CronLockHeldError as a skip.
 */
export class CronLockUnavailableError extends Error {
  readonly code = "CRON_LOCK_UNAVAILABLE" as const;
  constructor(readonly jobName: string) {
    super(
      `${jobName} is fail-closed and requires a real Redis lock, but Redis is not configured or unreachable`,
    );
    this.name = "CronLockUnavailableError";
  }
}
