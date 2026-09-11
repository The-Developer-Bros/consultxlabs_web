/**
 * Webhook Event Archive API Endpoint
 *
 * Thin wrapper around scripts/archive-webhook-events.ts
 * Provides HTTP endpoint for manual triggering or alternative cron systems.
 *
 * Schedule: Weekly (via GitHub Actions or external cron)
 */

import { cleanupRoute } from "@/lib/cron/cleanup-route";
import { archiveWebhookEvents } from "@/scripts/cleanup/archive-webhook-events";

export const { GET, POST } = cleanupRoute({
  job: "archive-webhook-events",
  run: () => archiveWebhookEvents(),
  summarize: (r) => ({
    processedEventsDeleted: r.processedEventsDeleted,
    failedEventsDeleted: r.failedEventsDeleted,
    totalDeleted: r.totalDeleted,
  }),
  failureMessage: "Failed to archive webhook events",
});
