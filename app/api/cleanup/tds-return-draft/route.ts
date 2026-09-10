/**
 * POST /api/cleanup/tds-return-draft — #1407
 *
 * HTTP twin of the quarterly Form 26Q draft export, CRON_SECRET-gated like
 * every other cleanup route. It runs the same core with the same defaults —
 * the quarter that CLOSED, not the one containing today — so a filing week
 * re-run does not need a GitHub Actions dispatch. The full-PAN CSV still goes
 * to the private finance bucket and the masked draft to the log; there is no
 * Actions artifact on this path, so the response carries the storage path
 * rather than the file.
 *
 * It shares `runTdsReturnDraftExport` with the Actions entry point, so it takes
 * the same `tds-26q-draft-export` cron lock (fail-open — the draft is a
 * read-only export, harmless to repeat).
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { runTdsReturnDraftExport } from "@/jobs/compliance/tds-26q-draft-export";

export const { GET, POST } = cleanupRoute({
  job: "tds-26q-draft-export",
  run: () => runTdsReturnDraftExport(),
  summarize: (r) => ({
    financialYear: r.financialYear,
    quarter: r.quarter,
    deducteeCount: r.deducteeCount,
    alreadyReported: r.alreadyReported,
    warnings: r.warnings.length,
    storagePath: r.storagePath,
  }),
  // Warnings are the filer's worklist, not a failed run — same posture as the
  // GST outward register twin.
  status: () => 200,
  failureMessage: "Failed to export the TDS return draft",
});
