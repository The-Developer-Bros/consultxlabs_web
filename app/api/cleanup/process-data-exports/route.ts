/**
 * POST /api/cleanup/process-data-exports
 *
 * CRON_SECRET-gated HTTP entry for the data-export worker.
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { processDataExports } from "@/scripts/cleanup/process-data-exports";

export const { GET, POST } = cleanupRoute({
  job: "process-data-exports",
  run: () => processDataExports(),
  summarize: (r) => ({
    picked: r.picked,
    succeeded: r.succeeded,
    failed: r.failed,
  }),
  failureMessage: "Data export tick failed",
});
