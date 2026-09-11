/**
 * Outbound Webhook Dispatch Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/cleanup/dispatch-outbound-webhooks.ts.
 * Adds GitHub Actions-specific stdout output and exit-code mapping.
 *
 * Runs every minute via .github/workflows/dispatch-outbound-webhooks.yml.
 */

// Why: tsx does not auto-load .env when run outside the Next.js runtime;
// without dotenv/config DATABASE_URL is undefined and PrismaClient throws.
// See docs/enterprise/50-operations/03-runbooks.md "Running cron jobs locally".
import "dotenv/config";

import {
  dispatchOutboundWebhooks,
  disconnectDatabase,
  type DispatchOutboundWebhooksResult,
} from "../../scripts/cleanup/dispatch-outbound-webhooks";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import prisma from "../../lib/prisma";
import { recordSystemEvent } from "../../lib/enterprise/system-events";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

// The delivery table IS the queue (see worker.ts). If overdue rows pile up
// past this, the worker isn't keeping pace — page someone (#776 §K).
const QUEUE_BACKLOG_THRESHOLD = 200;

async function checkQueueBacklog(): Promise<void> {
  const backlog = await prisma.outboundWebhookDelivery.count({
    where: {
      OR: [
        { status: "PENDING" },
        { status: "RETRY", nextRetryAt: { lte: new Date() } },
      ],
    },
  });
  if (backlog > QUEUE_BACKLOG_THRESHOLD) {
    await recordSystemEvent({
      category: "WEBHOOK",
      severity: "WARN",
      message: `Outbound webhook queue backlog: ${backlog} deliveries due`,
      context: { backlog, threshold: QUEUE_BACKLOG_THRESHOLD },
    });
  }
}

function outputToGitHubActions(result: DispatchOutboundWebhooksResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;

  const outputs = [
    `scanned=${result.scanned}`,
    `succeeded=${result.succeeded}`,
    `retried=${result.retried}`,
    `failed=${result.failed}`,
    `success=${result.success}`,
  ].join("\n");

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("fs") as typeof import("fs");
  fs.appendFileSync(outputFile, outputs + "\n");
}

if (require.main === module) {
  runJob("dispatch-outbound-webhooks", async () => {
    await abortIfMaintenance("dispatch-outbound-webhooks");
    Sentry.logger.info("job:dispatch-outbound-webhooks started");
    console.log("📤 Dispatching outbound webhooks...");
    try {
      const result = await dispatchOutboundWebhooks();
      console.log(JSON.stringify(result, null, 2));
      outputToGitHubActions(result);
      await checkQueueBacklog();
      Sentry.logger.info("job:dispatch-outbound-webhooks finished", { scanned: result.scanned, succeeded: result.succeeded, retried: result.retried, failed: result.failed });
      if (!result.success) process.exitCode = 1;
    } finally {
      await disconnectDatabase();
    }
  });
}
