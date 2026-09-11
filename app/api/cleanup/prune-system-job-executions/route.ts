/**
 * POST /api/cleanup/prune-system-job-executions
 *
 * HTTP shim. CRON_SECRET-gated like every other cleanup route.
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { pruneSystemJobExecutions } from "@/scripts/cleanup/prune-system-job-executions";

export const { GET, POST } = cleanupRoute({
  job: "prune-system-job-executions",
  run: () => pruneSystemJobExecutions(),
  status: () => 200,
  failureMessage: "System job execution prune failed",
});
