/**
 * SystemEvent Retention Cron — Core Logic (#1230 wave-3)
 *
 * `SystemEvent` is the engineering-facing operational log (recordSystemEvent
 * / recordSystemError): stack traces, Prisma error dumps, HTTP statuses.
 * Until now it had NO retention — the table grew unbounded, held raw error
 * text that can embed personal data, and sat outside both the audit-log
 * prune job and DPDP erasure scrubbing.
 *
 * Policy: keep 400 days. Engineering events have no statutory retention
 * requirement (unlike OrgAuditLog's 7y financial windows) but a year-plus of
 * history covers incident retrospectives and seasonality. The window also
 * stays comfortably inside DPDP's storage-limitation principle: anything
 * older than ~13 months is noise with PII risk and no diagnostic value.
 *
 * Single deleteMany keyed on the createdAt index — the table is young and
 * this is its first prune; if volume ever demands batching, switch to an
 * id-cursor loop rather than offset pagination (which degrades linearly).
 *
 * Schedule: 03:05 UTC daily (ahead of prune-audit-logs at 03:15).
 */

import prisma from "../../lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import { runJob } from "@/lib/observability/job-sentry";

const RETENTION_DAYS = 400;

export async function pruneSystemEvents(): Promise<{
  pruned: number;
}> {
  return withCronLock(
    "prune-system-events",
    { failMode: "closed" },
    async () => {
      const cutoff = new Date(
        Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
      );
      const result = await prisma.systemEvent.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      if (result.count > 0) {
        console.log(
          `[prune-system-events] removed ${result.count} rows older than ${cutoff.toISOString()}`,
        );
      } else {
        console.log("[prune-system-events] nothing to prune");
      }
      return { pruned: result.count };
    },
  );
}

// The workflow executes this file directly; without an entry the scheduled run
// only loaded the module and exited, so nothing was ever pruned.
if (require.main === module) {
  runJob("prune-system-events", async () => {
    await abortIfMaintenance("prune-system-events");
    try {
      await pruneSystemEvents();
    } finally {
      await prisma.$disconnect();
    }
  });
}
