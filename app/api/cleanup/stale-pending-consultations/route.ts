/**
 * Stale Pending Consultations Cleanup API Endpoint
 *
 * Thin wrapper around scripts/cleanup-stale-pending-consultations.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Hourly (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { cleanupStalePendingConsultations } from "@/scripts/appointments/cleanup-stale-pending-consultations";

export const { GET, POST } = cleanupRoute({
  job: "cleanup-stale-pending-consultations",
  run: () => cleanupStalePendingConsultations(),
  summarize: (r) => ({
    consultationsCancelled: r.consultationsCancelled,
    slotsReleased: r.slotsReleased,
  }),
  failureMessage: "Failed to cleanup stale pending consultations",
});
