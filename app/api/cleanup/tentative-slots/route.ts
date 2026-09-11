/**
 * Tentative Slot Cleanup API Endpoint
 *
 * Thin wrapper around scripts/cleanup-tentative-slots.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 2 hours (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { cleanupTentativeSlots } from "@/scripts/appointments/cleanup-tentative-slots";

export const { GET, POST } = cleanupRoute({
  job: "cleanup-tentative-slots",
  run: () => cleanupTentativeSlots(),
  summarize: (r) => ({
    slotsReleased: r.slotsReleased,
    appointmentsAffected: r.appointmentsAffected,
  }),
  failureMessage: "Failed to cleanup tentative slots",
});
