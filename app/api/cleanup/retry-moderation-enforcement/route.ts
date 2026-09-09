/**
 * Moderation enforcement retry endpoint (#1270).
 *
 * Thin wrapper around scripts/cleanup/retry-moderation-enforcement.ts. Re-drives
 * the Stream write of moderation actions whose recorded outcome says it failed,
 * so a ban taken while Stream was down stops depending on someone noticing.
 *
 * Schedule: every 30 minutes, `CRON_SECRET`-gated like the other cleanup jobs,
 * driven by `.github/workflows/retry-moderation-enforcement.yml`. Scheduled
 * rather than on-demand because the failure it repairs is invisible from the
 * product: the database says banned and the moderator was told it worked, so
 * nobody would think to press a button.
 */
import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { retryModerationEnforcement } from "@/scripts/cleanup/retry-moderation-enforcement";

export const { GET, POST } = cleanupRoute({
  job: "retry-moderation-enforcement",
  run: () => retryModerationEnforcement(),
  summarize: (r) => ({
    scanned: r.scanned,
    recovered: r.recovered,
    stillFailing: r.stillFailing,
    gaveUp: r.gaveUp,
  }),
  // 207 when enforcement is still not on Stream after a re-drive — that is an
  // account the platform believes is banned and Stream does not.
  status: (r) => (r.stillFailing > 0 || r.gaveUp > 0 ? 207 : 200),
  failureMessage: "Failed to retry moderation enforcement",
});
