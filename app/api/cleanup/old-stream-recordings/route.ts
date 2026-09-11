/**
 * POST /api/cleanup/old-stream-recordings
 *
 * HTTP shim around scripts/cleanup/cleanup-old-stream-recordings.ts.
 * Gated by CRON_SECRET like every other route under /api/cleanup.
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { cleanupOldStreamRecordings } from "@/scripts/cleanup/cleanup-old-stream-recordings";

export const { GET, POST } = cleanupRoute({
  job: "cleanup-old-stream-recordings",
  run: () => cleanupOldStreamRecordings(),
  summarize: (r) => ({ success: r.success }),
  failureMessage: "Stream retention sweep failed",
});
