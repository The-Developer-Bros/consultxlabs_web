/**
 * Sentry bootstrap for cron job processes — #1066.
 *
 * Jobs run as bare Node processes (`npx tsx jobs/<area>/<job>.ts` under GitHub
 * Actions). Next's instrumentation hook is the only thing in this repo that
 * ever calls `Sentry.init`, and it never fires there, so every
 * `captureException` under `jobs/**` was a silent no-op.
 *
 * `init` alone would not have fixed it. The SDK batches events over HTTP and a
 * cron process exits the instant its work is done, well before the transport
 * drains. So this module owns BOTH halves — init before the body, flush in a
 * `finally` after it — instead of leaving 58 entrypoints to each remember the
 * second one. jobs/reconcile/reconcile-ledgers.ts had already hand-rolled a
 * flush (#837) and now inherits it like everything else.
 *
 * Corollary the whole mechanism rests on: a job body must never call
 * `process.exit()`. It tears the process down synchronously, so the flush —
 * and any `finally` that disconnects Prisma — never runs. Set
 * `process.exitCode` and return instead.
 *
 * SCOPE, so nobody later assumes more than this delivers: `Sentry.init` runs
 * here at runJob time, which is AFTER every module import has already been
 * evaluated. OpenTelemetry auto-instrumentation patches http/pg/Prisma at
 * require time, so it has nothing left to patch by then. Explicit
 * `captureException`, `captureMessage` and `Sentry.logger` calls work — that is
 * all this module is for — but jobs produce NO spans and NO automatic
 * breadcrumbs. `tracesSampleRate` is pinned to 0 below to say so out loud.
 */

import fs from "node:fs";
import * as Sentry from "@sentry/nextjs";
import { initSentry } from "@/sentry.shared.config";
import { reportSentryError } from "@/lib/observability/report";
// Leaf module on purpose: importing this from with-cron-lock would drag
// lib/redis into every job, and that throws at import without Upstash env.
import { CronLockHeldError } from "@/lib/cron/cron-lock-errors";

/**
 * Drain budget. Generous relative to the 2s the ledger job used for its single
 * page, because a failing run can have queued several events and GitHub-hosted
 * runners sit on shared networking. Jobs that queue events in a loop should
 * raise it per-call rather than raise it for everyone.
 */
export const JOB_FLUSH_TIMEOUT_MS = 5_000;

/**
 * Jobs emit no spans at all (see SCOPE above), so sampling traces at the app's
 * rate would be meaningless. Pinning it also closes a real trap: the app's rate
 * keys off NODE_ENV, which a bare `tsx` process does not set, so jobs would
 * otherwise resolve to 100% while reporting `environment: production`.
 */
const JOB_TRACES_SAMPLE_RATE = 0;

/** Sentry environments that mean "a developer's machine", not a deployment. */
const LOCAL_SENTRY_ENVIRONMENTS = new Set(["development", "test", "local"]);

/**
 * #901 kept a developer's `.env` DSN from flooding the shared production
 * project during `next dev`, by gating on NODE_ENV. That gate does not hold
 * here: a bare `npx tsx jobs/…` process has no NODE_ENV at all, so it reads as
 * "not development" and passes. Sixteen jobs load `dotenv/config`, the local
 * `.env` carries a real DSN, and the runbook documents running jobs locally as
 * normal debugging — so without this, every local run shipped to production.
 *
 * The Sentry environment is the signal that actually distinguishes the two: the
 * workflows set it to `production`, a developer's `.env` sets `development`.
 */
function isDeployedJobEnvironment(): boolean {
  const environment = process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT;
  if (!environment) return false;
  return !LOCAL_SENTRY_ENVIRONMENTS.has(environment);
}

let initialised = false;

/** Idempotent — job modules import one another, and tests re-enter this. */
export function initJobSentry(): void {
  if (initialised) return;
  initialised = true;
  try {
    const deployed = isDeployedJobEnvironment();
    if (!deployed) {
      // Loud on purpose: a workflow that forgot the env var looks identical to
      // a laptop from in here, and silence is what this whole PR is about.
      console.log(
        `[job-sentry] disabled — NEXT_PUBLIC_SENTRY_ENVIRONMENT is ${
          process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? "unset"
        }, which is not a deployed environment. Errors will not reach Sentry.`,
      );
    }
    // Reuse the app's single init: DSN, environment and PII (#901) must not
    // fork into a second, drifting definition. The overrides only ever NARROW
    // it — when the shared config says disabled (no DSN), it stays disabled.
    initSentry({
      ...(deployed ? {} : { enabled: false }),
      tracesSampleRate: JOB_TRACES_SAMPLE_RATE,
    });
  } catch (err) {
    // Telemetry setup failing must not stop the job doing its actual work, and
    // must not surface as an unhandled rejection either.
    console.error("[job-sentry] init failed; job runs uninstrumented:", err);
  }
}

/**
 * Drain the transport. Never throws: a job that completed its work must not go
 * red because telemetry could not be delivered.
 */
export async function flushJobSentry(
  timeoutMs: number = JOB_FLUSH_TIMEOUT_MS,
): Promise<void> {
  try {
    // flush RESOLVES false on timeout — it does not throw — and the queued
    // events are gone. That is silent loss, the exact failure this module
    // exists to remove, so the run has to say so in the log it leaves behind.
    const drained = await Sentry.flush(timeoutMs);
    if (!drained) {
      console.warn(
        `[job-sentry] flush timed out after ${timeoutMs}ms; queued events were dropped`,
      );
    }
  } catch (err) {
    console.warn("[job-sentry] flush failed:", err);
  }
}

/**
 * The `success=false` step output and `::error::` annotation each job used to
 * write by hand on its failure path. Nothing here varies per job except the
 * name, which is why it lives up here now.
 */
function markStepFailed(jobName: string, err: unknown): void {
  if (!process.env.GITHUB_ACTIONS) return;
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) fs.appendFileSync(outputFile, "success=false\n");
  console.log(
    `::error::${jobName} failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/**
 * Run a job body with Sentry initialised around it and flushed after it — on
 * success, on an early `return`, and on a throw.
 *
 * An escaping error is captured and turns the exit code non-zero rather than
 * being rethrown: an unhandled rejection would kill the process before the
 * flush it just queued an event for could finish.
 *
 * A job body therefore does not need its own catch. Let the error out and it
 * gets the capture, the job tag, the step annotation and the exit code for
 * free; catch it only when there is something genuinely job-specific to do,
 * and rethrow afterwards.
 */
export interface RunJobOpts {
  /**
   * Override the drain budget. Raise it for jobs that queue events in a loop —
   * the default assumes a handful, not a batch. Keep it inside the workflow's
   * own `timeout-minutes` or the runner kills the process mid-drain anyway.
   */
  flushTimeoutMs?: number;
}

export async function runJobWithSentry(
  jobName: string,
  body: () => Promise<void>,
  opts: RunJobOpts = {},
): Promise<void> {
  // Cannot throw — see initJobSentry. If it could, `void runJob(...)` would
  // turn it into an unhandled rejection and the job would die with no capture,
  // no annotation and no flush: the shape this module exists to remove.
  initJobSentry();
  try {
    await body();
  } catch (err) {
    // #476 — a held lock means another replica is already running this job.
    // Skipping is the correct outcome for every one of them, so this is not a
    // failure: nothing is captured, nothing pages, the exit code stays 0.
    // CronLockUnavailableError is a different thing and still falls through.
    if (err instanceof CronLockHeldError) {
      Sentry.logger.info(`job:${jobName} skipped — cron lock held`);
      console.log(`⏭️  ${err.message}`);
      return;
    }
    reportSentryError(err, { subsystem: "jobs", tags: { job: jobName } });
    console.error(`[${jobName}] Fatal:`, err);
    // Set the code before the step write: appendFileSync can throw on a bad
    // GITHUB_OUTPUT path, and the exit status must not depend on that.
    process.exitCode = 1;
    markStepFailed(jobName, err);
  } finally {
    await flushJobSentry(opts.flushTimeoutMs);
  }
}

/**
 * Module-tail form: `runJob("expire-contracts", main);`. Fire-and-forget by
 * design — Node keeps the process alive until the returned promise settles.
 */
export function runJob(
  jobName: string,
  body: () => Promise<void>,
  opts?: RunJobOpts,
): void {
  void runJobWithSentry(jobName, body, opts);
}
