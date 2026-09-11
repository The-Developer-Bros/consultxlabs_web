/**
 * PM-34 (#677) — the failure-signal decision shared by both cascade consumers.
 *
 * Leaf module on purpose (same pattern as lib/cron/cron-lock-errors): the
 * script this decision belongs to pulls prisma, the refund operation and the
 * Redis-backed cron lock, and neither consumer's failure signal should need
 * any of that to be unit-testable.
 *
 * `result.success === false` means at least one SUCCEEDED gateway refund
 * failed its earnings cascade — money state stays inconsistent until a later
 * run picks it up. That must surface as failure at every entry point instead
 * of a green exit the cron monitor waves through:
 *   - jobs/refunds/cascade-refund-earnings.ts → non-zero process exit
 *     (`process.exitCode`, never process.exit() — that would kill the Sentry
 *     flush; see lib/observability/job-sentry)
 *   - app/api/cleanup/cascade-refund-earnings/route.ts → non-2xx status,
 *     which is what external cron health checks key on
 */

import type { RefundEarningCascadeResult } from "./cascade-refund-earnings";

export function cascadeRunFailed(
  result: Pick<RefundEarningCascadeResult, "success">,
): boolean {
  return !result.success;
}
