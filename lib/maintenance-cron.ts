/**
 * Maintenance Mode Guard — Cron Job Utility
 *
 * All cron job scripts should call abortIfMaintenance() at entry.
 * This prevents jobs from reading/writing to the database during
 * OFFLINE maintenance (when DB may be mid-migration) and prevents
 * financial jobs from running during DEGRADED maintenance.
 *
 * Fail-open design: if Redis is unreachable, the job proceeds normally.
 * This matches the fail-open design of the rest of the maintenance system.
 *
 * Usage in each job script:
 *   import { abortIfMaintenance } from "@/lib/maintenance-cron";
 *   await abortIfMaintenance("cleanup-abandoned-payments");
 *
 * Usage in the HTTP twins under app/api/cleanup/** , which run inside the Next
 * server and therefore cannot call process.exit:
 *   import { assertNotInMaintenance } from "@/lib/maintenance-cron";
 *   await assertNotInMaintenance("cleanup-abandoned-payments"); // throws 503
 */

import * as Sentry from "@sentry/nextjs";
import { Redis } from "@upstash/redis";
import { flushJobSentry } from "@/lib/observability/job-sentry";

// Financial jobs that must NOT run even in DEGRADED mode.
// These jobs call external APIs to create/cancel financial objects,
// or mutate financial state (earnings, payouts, refunds) that could
// become inconsistent during a partial deployment.
// Exported for the lock-registry drift test (#1169): every member that is
// cron-scheduled must hold a fail-closed lock.
export const FINANCIAL_JOB_NAMES = new Set([
  "process-payouts",
  "create-payout-batch",
  "handle-stuck-payouts",
  "reconcile-payout-status",
  "cascade-refund-earnings",
  "reconcile-pending-refunds",
  "handle-lost-disputes",
  "reconcile-disputes",
  "cleanup-abandoned-payments",
  "release-earnings",
  "reconcile-payment-status",
  "sync-payment-earnings",
  "generate-subscription-invoices",
  "settle-invoice-accruals",
  // #1506 — cancels and refunds consultant no-shows through
  // refundBookingPayment; every job that calls the refund front door belongs
  // here so DEGRADED maintenance holds it with the other refunding jobs.
  "detect-consultant-no-shows",
  // #1506 — expirePaymentPendingRequests/expireApprovedUnallocatedSubscriptions
  // in this job call refundPaymentsForExpired, another refund front-door
  // caller that must be held with the rest of the money jobs.
  "expire-stale-requests",
  // Added by the wave-5 sweep: each of these either moves money directly or
  // mutates the org contract/program state the checkout sponsorship resolver
  // reads, so a partial deployment can bill against a half-written entitlement.
  "release-pending-trust-earnings",
  "auto-renew-contracts",
  "dunning",
  "timeout-member-overages",
  "advance-program-cycles",
  "expire-contracts",
  // Registers IRNs with the government portal and writes the resulting IRP
  // state onto the invoice. It moves no money, but a half-deployed payload
  // becomes a statutory record that can only be cancelled for 24 hours.
  "irp-uploader",
  // #1370 — its healer mints tax invoices, which burns numbers from a gapless
  // statutory series. A half-deployed run leaves gaps that cannot be filled.
  "gst-outward-register-export",
]);

/** The maintenance phases that can stop a job. */
export type BlockingMaintenancePhase = "OFFLINE" | "DEGRADED";

/**
 * Thrown by {@link assertNotInMaintenance} in place of the `process.exit(0)`
 * a long-lived server process must never take. Carries the status the HTTP
 * layer should answer with so every call site maps it the same way.
 */
export class MaintenanceActiveError extends Error {
  readonly httpStatus = 503;
  readonly phase: BlockingMaintenancePhase;
  readonly jobName: string;

  constructor(jobName: string, phase: BlockingMaintenancePhase) {
    super(
      phase === "OFFLINE"
        ? `Maintenance mode is OFFLINE — ${jobName} is unavailable while the database may be mid-migration`
        : `Maintenance mode is DEGRADED — ${jobName} is a financial job and is unavailable until maintenance ends`,
    );
    this.name = "MaintenanceActiveError";
    this.jobName = jobName;
    this.phase = phase;
  }
}

/**
 * Read `maintenance:phase` from Redis. Returns null when the phase cannot be
 * established — no Redis configured, or the probe failed — which every caller
 * treats as "proceed", matching the fail-open design of the rest of the system.
 */
async function readMaintenancePhase(jobName: string): Promise<string | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    console.warn(
      `[${jobName}] UPSTASH_REDIS env vars not set — skipping maintenance check, proceeding`,
    );
    return null;
  }

  try {
    // Intentionally creates a fresh client per invocation — cron jobs run
    // infrequently and this avoids holding a persistent connection.
    const redis = new Redis({ url, token });
    return await redis.get<string>("maintenance:phase");
  } catch (error) {
    // Fail-open: if Redis is unreachable, proceed with the job
    console.warn(
      `[${jobName}] Could not check maintenance state (Redis error: ${
        error instanceof Error ? error.message : String(error)
      }) — proceeding`,
    );
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "maintenance" } },
    );
    return null;
  }
}

/**
 * The single phase→verdict rule both guards share: OFFLINE stops everything,
 * DEGRADED stops only the financial jobs, anything else proceeds.
 */
function blockingPhaseFor(
  phase: string | null,
  jobName: string,
): BlockingMaintenancePhase | null {
  if (phase === "OFFLINE") return "OFFLINE";
  if (phase === "DEGRADED" && FINANCIAL_JOB_NAMES.has(jobName)) {
    return "DEGRADED";
  }
  return null;
}

/**
 * Check maintenance state and exit cleanly if the job should not run.
 *
 * OFFLINE  → always exits (process.exit(0)) — DB may be mid-migration
 * DEGRADED → exits for financial jobs only — protects payment integrity
 * OFF      → continues normally
 *
 * @param jobName - Human-readable job name used in logs. Should match the
 *   file name (e.g. "cleanup-abandoned-payments" for
 *   jobs/payments/cleanup-abandoned-payments.ts). Financial job names must
 *   match exactly the entries in FINANCIAL_JOB_NAMES above.
 */
export async function abortIfMaintenance(jobName: string): Promise<void> {
  const phase = await readMaintenancePhase(jobName);
  const blocking = blockingPhaseFor(phase, jobName);

  if (blocking === "OFFLINE") {
    console.log(
      `[${jobName}] Maintenance mode is OFFLINE — skipping job to protect DB during migration`,
    );
  } else if (blocking === "DEGRADED") {
    console.log(
      `[${jobName}] Maintenance mode is DEGRADED — skipping financial job to protect payment integrity`,
    );
  } else {
    if (phase === "DEGRADED") {
      console.log(
        `[${jobName}] Maintenance mode is DEGRADED — proceeding (non-financial job)`,
      );
    }
    return;
  }

  // This exit bypasses runJob's finally, so it owns the drain itself —
  // anything the job logged before the guard would be lost. (#1066)
  await flushJobSentry();
  process.exit(0);
}

/**
 * Throwing twin of {@link abortIfMaintenance}, for the HTTP entry points under
 * `app/api/cleanup/**`. Those routes import the same job cores but run inside
 * the Next server, where `process.exit(0)` would take the whole instance down,
 * so the same phase rule surfaces as a `MaintenanceActiveError` the handler
 * answers with 503.
 *
 * @param jobName - Must be the canonical cron job name, not the route segment,
 *   because the DEGRADED branch is keyed on FINANCIAL_JOB_NAMES membership.
 */
export async function assertNotInMaintenance(jobName: string): Promise<void> {
  const phase = await readMaintenancePhase(jobName);
  const blocking = blockingPhaseFor(phase, jobName);
  if (blocking) throw new MaintenanceActiveError(jobName, blocking);
}
