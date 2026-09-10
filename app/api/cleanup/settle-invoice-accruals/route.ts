/**
 * POST /api/cleanup/settle-invoice-accruals — #1407
 *
 * HTTP twin of the monthly accrual rollup, CRON_SECRET-gated like every other
 * cleanup route. Every other job under `jobs/**` already has one; this one did
 * not, so the only way to re-run the job that turns INVOICE_ACCRUAL legs into
 * an actual OrganizationInvoice was a GitHub Actions dispatch — during a
 * billing cycle that matters, because an org that misses the rollup is simply
 * not billed until the next month.
 *
 * It shares `runSettleInvoiceAccruals` with the Actions entry point, so it
 * takes the same fail-closed `settle-invoice-accruals` cron lock: a manual call
 * that overlaps the scheduled run answers 409 rather than racing it into a
 * second invoice for the same accruals.
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { runSettleInvoiceAccruals } from "@/jobs/billing/settle-invoice-accruals";

export const { GET, POST } = cleanupRoute({
  job: "settle-invoice-accruals",
  run: () => runSettleInvoiceAccruals(),
  summarize: (r) => ({
    orgsProcessed: r.orgsProcessed,
    invoicesCreated: r.invoicesCreated,
  }),
  // A run that found nothing to bill is a healthy run, and the flag being off
  // (ENABLE_CONSOLIDATED_INVOICE="false") reports zeroes rather than failing.
  status: () => 200,
  failureMessage: "Failed to settle invoice accruals",
});
