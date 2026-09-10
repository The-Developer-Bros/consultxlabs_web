/**
 * #830 — orphaned-confirmation re-drive (GitHub Actions wrapper). Finds
 * SUCCEEDED payments whose slots are still tentative and re-runs the
 * confirmation under the webhook's own Serializable discipline, and (#1356)
 * re-drives the chat channel a capture failed to create. Runs every 30 minutes.
 */
import {
  reconcileOrphanedConfirmations,
  disconnectDatabase,
} from "../../scripts/payments/reconcile-orphaned-confirmations";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

async function main(): Promise<void> {
  await abortIfMaintenance("reconcile-orphaned-confirmations");
  Sentry.logger.info("job:reconcile-orphaned-confirmations started");
  console.log("🩹 Starting orphaned-confirmation reconcile...");
  try {
    const result = await reconcileOrphanedConfirmations();
    console.log(
      `Done. scanned=${result.scanned} confirmed=${result.confirmed} stillBlocked=${result.stillBlocked} ` +
        `channelsEnsured=${result.channelsEnsured} channelsFailed=${result.channelsFailed} ` +
        `channelBuyerOps=${result.channelBuyerOps} channelsDeferred=${result.channelsDeferred}`,
    );
    Sentry.logger.info("job:reconcile-orphaned-confirmations finished", {
      scanned: result.scanned,
      confirmed: result.confirmed,
      stillBlocked: result.stillBlocked,
      channelsEnsured: result.channelsEnsured,
      channelsFailed: result.channelsFailed,
      channelBuyerOps: result.channelBuyerOps,
      channelsDeferred: result.channelsDeferred,
    });
  } finally {
    await disconnectDatabase();
  }
}

runJob("reconcile-orphaned-confirmations", main);
