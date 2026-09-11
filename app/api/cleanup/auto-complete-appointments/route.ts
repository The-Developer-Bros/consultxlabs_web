/**
 * Auto-Complete Appointments API Endpoint
 *
 * Thin wrapper around scripts/auto-complete-appointments.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Hourly (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { autoCompleteAppointments } from "@/scripts/appointments/auto-complete-appointments";

export const { GET, POST } = cleanupRoute({
  job: "auto-complete-appointments",
  run: () => autoCompleteAppointments(),
  summarize: (r) => ({
    webinarsCompleted: r.webinarsCompleted,
    classesCompleted: r.classesCompleted,
    consultationsCompleted: r.consultationsCompleted,
    subscriptionsCompleted: r.subscriptionsCompleted,
  }),
  failureMessage: "Failed to auto-complete appointments",
});
