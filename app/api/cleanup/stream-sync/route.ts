/**
 * Stream User Sync API Endpoint
 *
 * Thin wrapper around scripts/stream/stream-sync.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Weekly (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { performStreamUserSync } from "@/scripts/stream/stream-sync";

export const { GET, POST } = cleanupRoute({
  job: "stream-sync",
  run: (req) => {
    const dryRun = req.nextUrl.searchParams.get("dry-run") === "true";
    if (dryRun) {
      console.log("Stream user sync: DRY RUN");
    }
    return performStreamUserSync({ dryRun });
  },
  summarize: (r) => ({
    usersProcessed: r.totalStreamUsersProcessed,
    staleIdentified: r.totalStaleUsersIdentified,
    usersDeleted: r.totalStaleUsersDeleted,
    failedDeletions: r.totalFailedDeletions,
  }),
  failureMessage: "Failed to sync Stream users",
});
