/**
 * GSTR-8 draft export (#1230) — monthly GST-TCS u/s 52 statement draft.
 *
 * Reads the TCS columns the accrual writer is meant to populate
 * (Payment.gstTcsCollectedPaise via ConsultantEarnings.gstTcsAccruedPaise).
 * Today both are null everywhere, so this emits an explicit empty draft with
 * a warning rather than pretending compliance. The moment the accrual writer
 * lands, this job becomes the filing input without further changes.
 *
 * workflow_dispatch-only until TCS collection goes live; scheduling a filing
 * draft that always reads zeros would just normalize ignoring the warning.
 */

import { runJob } from "@/lib/observability/job-sentry";
import prisma from "@/lib/prisma";
import * as Sentry from "@sentry/nextjs";
import { buildGstr8Draft, type Gstr8SourceRow } from "@/lib/compliance/gstr8";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import {
  previousIstCalendarMonthStart,
  nextMonthStart,
} from "@/lib/compliance/ist-period";

async function main() {
  runJob("gstr8-draft-export", async () => {
    await abortIfMaintenance("gstr8-draft-export");
    // #476 — fail-open: the draft is read-only console output, harmless to repeat.
    await withCronLock("gstr8-draft-export", { failMode: "open" }, async () => {
      // Default: previous calendar month in IST terms. The shift is shared
      // with the outward-supplies register export (#1370).
      const monthStart = process.env.GSTR8_MONTH_START
        ? new Date(process.env.GSTR8_MONTH_START)
        : previousIstCalendarMonthStart();
      const monthEnd = nextMonthStart(monthStart);

      const earnings = await prisma.consultantEarnings.findMany({
        where: {
          createdAt: { gte: monthStart, lt: monthEnd },
          gstTcsAccruedPaise: { not: null },
        },
        select: {
          consultantProfileId: true,
          grossAmount: true,
          refundedShareAmount: true,
          gstTcsAccruedPaise: true,
        },
      });

      const rows: Gstr8SourceRow[] = earnings.map((e) => ({
        consultantProfileId: e.consultantProfileId,
        // Net taxable value = gross minus refunds; the TCS accrual itself was
        // computed on that net base by the writer.
        netTaxablePaise: Number(e.grossAmount - e.refundedShareAmount),
        tcsCollectedPaise: Number(e.gstTcsAccruedPaise ?? 0),
      }));

      const draft = buildGstr8Draft(rows, monthStart);

      // Draft output only — filing remains a human action on the portal.
      console.log("[gstr8-draft]", JSON.stringify(draft, null, 2));
      if (draft.warnings.length > 0) {
        for (const w of draft.warnings) {
          console.warn(`[gstr8-draft] WARN ${w}`);
        }
        Sentry.logger.warn("job:gstr8-draft-empty", {
          period: draft.periodLabel,
        });
      }
    });
  });
}

main().catch((err) => {
  console.error("[gstr8-draft] fatal:", err);
  process.exit(1);
});
