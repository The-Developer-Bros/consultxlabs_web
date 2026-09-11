/**
 * Appointment Reminders API Endpoint
 *
 * Thin wrapper around scripts/send-appointment-reminders.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Every 15 minutes (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { sendAppointmentReminders } from "@/scripts/appointments/send-appointment-reminders";

export const { GET, POST } = cleanupRoute({
  job: "appointment-reminders",
  run: () => sendAppointmentReminders(),
  summarize: (r) => ({
    reminders24h: r.reminders24h,
    reminders1h: r.reminders1h,
  }),
  failureMessage: "Failed to send appointment reminders",
});
