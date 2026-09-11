/**
 * Webhook Event Archive - Core Logic
 *
 * Deletes old processed webhook events to keep the database lean.
 * Keeps failed events longer for debugging purposes.
 *
 * Retention policy:
 * - Processed events: 30 days
 * - Failed/errored events: 90 days
 *
 * This module exports the core archive function.
 * It is imported by:
 * - jobs/archive-webhook-events.ts (GitHub Actions)
 * - app/api/cleanup/archive-webhook-events/route.ts (API endpoint)
 *
 * Schedule: Weekly (Sunday midnight)
 */

import prisma from "../../lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";

// Delete processed events older than this
const PROCESSED_RETENTION_DAYS = 30;

// Keep failed events longer for debugging
const FAILED_RETENTION_DAYS = 90;

export interface WebhookArchiveResult {
  success: boolean;
  processedEventsDeleted: number;
  failedEventsDeleted: number;
  totalDeleted: number;
  errors: string[];
  timestamp: string;
}

/**
 * Archive (delete) old webhook events
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
export async function archiveWebhookEvents(): Promise<WebhookArchiveResult> {
  return withCronLock("archive-webhook-events", { failMode: "open" }, () =>
    archiveWebhookEventsUnlocked(),
  );
}

async function archiveWebhookEventsUnlocked(): Promise<WebhookArchiveResult> {
  const errors: string[] = [];
  let processedEventsDeleted = 0;
  let failedEventsDeleted = 0;

  const processedRetention = new Date(
    Date.now() - PROCESSED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const failedRetention = new Date(
    Date.now() - FAILED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );

  console.log("🗄️ Starting webhook event archival...");
  console.log(`   Processed retention: ${PROCESSED_RETENTION_DAYS} days`);
  console.log(`   Failed retention: ${FAILED_RETENTION_DAYS} days`);

  try {
    // Get counts before deletion for reporting
    const processedCount = await prisma.webhookEvent.count({
      where: {
        processed: true,
        error: null,
        receivedAt: { lt: processedRetention },
      },
    });

    const failedCount = await prisma.webhookEvent.count({
      where: {
        OR: [{ processed: false }, { error: { not: null } }],
        receivedAt: { lt: failedRetention },
      },
    });

    console.log(
      `\nFound ${processedCount} processed events older than ${PROCESSED_RETENTION_DAYS} days`,
    );
    console.log(
      `Found ${failedCount} failed/errored events older than ${FAILED_RETENTION_DAYS} days`,
    );

    // Log some statistics before deletion
    const byProvider = await prisma.webhookEvent.groupBy({
      by: ["provider"],
      where: {
        OR: [
          {
            processed: true,
            error: null,
            receivedAt: { lt: processedRetention },
          },
          {
            OR: [{ processed: false }, { error: { not: null } }],
            receivedAt: { lt: failedRetention },
          },
        ],
      },
      _count: true,
    });

    console.log("\nEvents to archive by provider:");
    byProvider.forEach((p) => {
      console.log(`   ${p.provider}: ${p._count}`);
    });

    // Delete old processed events (no errors)
    const processedResult = await prisma.webhookEvent.deleteMany({
      where: {
        processed: true,
        error: null,
        receivedAt: { lt: processedRetention },
      },
    });
    processedEventsDeleted = processedResult.count;
    console.log(`\n✅ Deleted ${processedEventsDeleted} old processed events`);

    // Delete very old failed/errored events
    const failedResult = await prisma.webhookEvent.deleteMany({
      where: {
        OR: [{ processed: false }, { error: { not: null } }],
        receivedAt: { lt: failedRetention },
      },
    });
    failedEventsDeleted = failedResult.count;
    console.log(`✅ Deleted ${failedEventsDeleted} old failed/errored events`);

    // Report remaining events
    const remainingCount = await prisma.webhookEvent.count();
    console.log(`\n📊 Remaining webhook events: ${remainingCount}`);
  } catch (error) {
    const msg = `Failed to archive webhook events: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
  }

  const totalDeleted = processedEventsDeleted + failedEventsDeleted;

  // Summary
  console.log("\n📊 Webhook Event Archive Summary:");
  console.log(`   Processed events deleted: ${processedEventsDeleted}`);
  console.log(`   Failed events deleted: ${failedEventsDeleted}`);
  console.log(`   Total deleted: ${totalDeleted}`);

  return {
    success: errors.length === 0,
    processedEventsDeleted,
    failedEventsDeleted,
    totalDeleted,
    errors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
