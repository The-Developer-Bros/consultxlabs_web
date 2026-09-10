/**
 * POST /api/cleanup/prune-audit-logs
 *
 * HTTP shim. CRON_SECRET-gated like every other cleanup route.
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { pruneAuditLogs } from "@/scripts/cleanup/prune-audit-logs";

export const { GET, POST } = cleanupRoute({
  job: "prune-audit-logs",
  run: () => pruneAuditLogs(),
  failureMessage: "Audit prune failed",
});
