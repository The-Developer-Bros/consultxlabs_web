/**
 * Slot Availability Reconciliation API Endpoint
 *
 * Thin wrapper around scripts/reconcile-slot-availability.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Hourly (via GitHub Actions or external cron)
 */

import { cleanupRoute, statusFor } from "@/lib/cron/cleanup-route";
import { reconcileSlotAvailability } from "@/scripts/appointments/reconcile-slot-availability";

export const { GET, POST } = cleanupRoute({
  job: "reconcile-slot-availability",
  run: () => reconcileSlotAvailability(),
  summarize: (r) => ({
    tentativeFlagsCleared: r.tentativeFlagsCleared,
    doubleBookingsDetected: r.doubleBookingsDetected,
    // #1206 — sessions the top-up pass recovered for partially-scheduled plans.
    topUpsPlaced: r.topUps.placed,
    topUpSessionsPlaced: r.topUps.sessionsPlaced,
  }),
  // 207 when double bookings were detected and the run itself was clean.
  status: (r) => statusFor(r, r.doubleBookingsDetected > 0),
  failureMessage: "Failed to reconcile slot availability",
});
