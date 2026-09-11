/**
 * Cron: DPDP ConsentArtifact retention sweeper.
 *
 * Two-mode implementation gated by the `DPDP_SWEEPER_DELETE` env flag:
 *
 *   DPDP_SWEEPER_DELETE=false (default, "stub" behaviour):
 *     Counts artifacts past their 7-year `auditRetainedUntil` window
 *     and logs a warning. Does NOT delete. Safe for every environment
 *     including production — the counter itself is a useful
 *     observability signal (alerts when retention debt accumulates).
 *
 *   DPDP_SWEEPER_DELETE=true (live mode, opt-in per environment):
 *     Deletes expired artifacts in capped batches so a large backlog
 *     can't monopolise the Prisma connection pool for minutes at a
 *     time. DPDP Rules (Nov 2025) require deletion — this mode flips
 *     on once the archival pipeline (hash-only record for dispute
 *     resolution) has landed upstream.
 *
 * The flag lives in env (not in code) so we can enable deletion on
 * staging first, observe a sweep cycle, then promote to prod by
 * flipping the env var alone — no deploy needed.
 *
 * Schedule: weekly, Sunday 03:00 IST.
 */

import prisma from "@/lib/prisma";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "@/lib/observability/job-sentry";

const DELETE_BATCH_SIZE = 500;
const MAX_BATCHES_PER_RUN = 40; // caps total work at 20k rows / sweep

export async function runConsentRetentionSweeper(): Promise<{
  expired: number;
  deleted: number;
  deleteMode: boolean;
}> {
  await abortIfMaintenance("consent-retention-sweeper");
  Sentry.logger.info("job:consent-retention-sweeper started");
  const deleteMode = process.env.DPDP_SWEEPER_DELETE === "true";
  const now = new Date();

  const expired = await prisma.consentArtifact.count({
    where: { auditRetainedUntil: { lt: now } },
  });

  if (!deleteMode) {
    if (expired > 0) {
      console.warn(
        `[DPDP] ${expired} consent artifacts past retention window; ` +
          `DPDP_SWEEPER_DELETE != "true" — skipping delete. ` +
          `Flip the flag after the archival pipeline is live.`,
      );
    } else {
      console.log("[DPDP] consent retention clean — no expired artifacts");
    }
    Sentry.logger.info("job:consent-retention-sweeper finished", { expired, deleted: 0 });
    return { expired, deleted: 0, deleteMode: false };
  }

  console.log(
    `[DPDP] consent retention sweeper entering DELETE mode — candidates=${expired}`,
  );

  let deleted = 0;
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    // Page by primary key to stay deterministic between batches.
    const batch = await prisma.consentArtifact.findMany({
      where: { auditRetainedUntil: { lt: now } },
      select: { id: true },
      take: DELETE_BATCH_SIZE,
      orderBy: { id: "asc" },
    });
    if (batch.length === 0) break;
    const result = await prisma.consentArtifact.deleteMany({
      where: { id: { in: batch.map((b) => b.id) } },
    });
    deleted += result.count;
    console.log(
      `[DPDP] batch ${i + 1}/${MAX_BATCHES_PER_RUN}: deleted ${result.count}`,
    );
    // If we deleted a short batch we're done.
    if (batch.length < DELETE_BATCH_SIZE) break;
  }

  console.log(
    `[DPDP] consent retention sweeper finished — deleted=${deleted} of expired=${expired}`,
  );

  Sentry.logger.info("job:consent-retention-sweeper finished", { expired, deleted });
  return { expired, deleted, deleteMode: true };
}

async function main() {
  console.log(
    `[consent-retention-sweeper] Starting at ${new Date().toISOString()}`,
  );
  const r = await withCronLock(
    "consent-retention-sweeper",
    { failMode: "open" },
    () => runConsentRetentionSweeper(),
  );
  console.log(
    `[consent-retention-sweeper] Done. expired=${r.expired} deleted=${r.deleted} deleteMode=${r.deleteMode}`,
  );
}

if (require.main === module) {
  runJob("consent-retention-sweeper", () => main().finally(() => prisma.$disconnect()));
}
