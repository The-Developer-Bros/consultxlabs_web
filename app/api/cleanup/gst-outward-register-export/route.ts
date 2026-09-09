/**
 * POST /api/cleanup/gst-outward-register-export — #1370
 *
 * HTTP twin of the monthly outward-supplies register export, CRON_SECRET-gated
 * like every other cleanup route. It exists so the register can be re-run
 * without a GitHub Actions dispatch — during a filing week that matters, because
 * the healer inside is what mints the tax invoices checkout was allowed to miss.
 *
 * It shares `runGstOutwardRegisterExport` with the Actions entry point, so it
 * takes the same fail-closed `gst-outward-register-export` cron lock; a manual
 * call that overlaps the scheduled run answers 409 rather than racing the
 * gapless invoice series. The CSV is not written here — there is nowhere to put
 * it and nothing to collect it — so this call heals, stamps and reports.
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { runGstOutwardRegisterExport } from "@/jobs/compliance/gst-outward-register-export";

export const { GET, POST } = cleanupRoute({
  job: "gst-outward-register-export",
  run: () => runGstOutwardRegisterExport({ writeCsv: false }),
  summarize: (r) => ({
    period: r.period,
    mintedByHealer: r.mintedByHealer,
    documentCount: r.documentCount,
    warnings: r.warnings,
  }),
  // A register with warnings still succeeded; the warnings are a filer's
  // worklist, not a failed run.
  status: () => 200,
  failureMessage: "Failed to export the GST outward-supplies register",
});
