/**
 * #779 §A — CHARGE_MEMBER overage TIMEOUT cron. A member-pays overage sits
 * PENDING until the side-payment SUCCEEDS; if the member never settles it,
 * it must time out → FAILED so it stops counting toward the per-cycle
 * circuit-breaker ceiling, and the member gets told the obligation lapsed.
 *
 * Distinct from sweep-abandoned-overage-charges (#785): that sweep FAILs
 * never-*started* side-charges at 7d off the synthetic `overage:` intent to
 * free the ceiling silently. This cron is the hard 14-day wall — it gates on
 * the dedicated `chargeTimedOutAt` stamp + telemetry fields and NOTIFIES the
 * member. The two are idempotent against each other: a row the sweep already
 * moved to FAILED no longer matches `chargeStatus = PENDING` here.
 *
 * Schedule: daily at 04:30 IST (`.github/workflows/timeout-member-overages.yml`).
 *
 * Idempotent: claims on `chargeTimedOutAt:null` (+ `chargeStatus PENDING`),
 * so a re-run or second replica matches zero rows.
 *
 * Usage:
 *   npx tsx jobs/billing/timeout-member-overages.ts
 */

import "dotenv/config";
import prisma from "@/lib/prisma";
import { notifyMemberOverageTimedOut } from "@/lib/novu/org-workflows";
import { restoreOverageBaseCarve } from "@/lib/payments/billing/overage-base-carve";
import { recordSystemError } from "@/lib/enterprise/system-events";
import { getAppUrl } from "@/lib/url";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "@/lib/observability/job-sentry";

// #779 — 14-day window before a never-settled member overage times out.
const TIMEOUT_DAYS = 14;
const TIMEOUT_REASON = "Payment not completed within 14 days";

interface TimeoutStats {
  scanned: number;
  timedOut: number;
}

export async function runTimeoutMemberOverages(): Promise<TimeoutStats> {
  const stats: TimeoutStats = { scanned: 0, timedOut: 0 };
  const now = new Date();
  const cutoff = new Date(now.getTime() - TIMEOUT_DAYS * 86_400_000);

  const stale = await prisma.overageEvent.findMany({
    where: {
      overageBehavior: "CHARGE_MEMBER",
      chargeStatus: "PENDING",
      createdAt: { lt: cutoff },
      chargeTimedOutAt: null,
    },
    select: {
      id: true,
      marginalPaise: true,
      currency: true,
      programAssignment: {
        select: {
          membership: { select: { userId: true } },
          program: {
            select: {
              name: true,
              contract: {
                select: { organization: { select: { name: true } } },
              },
            },
          },
        },
      },
    },
  });
  stats.scanned = stale.length;

  for (const ev of stale) {
    const claimed = await prisma.$transaction(
      async (tx) => {
        // Claim only if still PENDING + un-stamped (PENDING→FAILED is the
        // only legal target; a row the member paid (→CHARGED) or the
        // abandoned-sweep moved (→FAILED) between read and here won't match).
        const claim = await tx.overageEvent.updateMany({
          where: {
            id: ev.id,
            chargeStatus: "PENDING",
            chargeTimedOutAt: null,
          },
          data: {
            chargeStatus: "FAILED",
            chargeTimedOutAt: now,
            chargeFailureReason: TIMEOUT_REASON,
          },
        });
        if (claim.count === 0) return null;
        // #812 §P0 — the member never pays basePaise on a timed-out charge;
        // return it to the org's parent accrual in the same tx.
        return restoreOverageBaseCarve(tx, { overageEventId: ev.id });
      },
      { isolationLevel: "Serializable", maxWait: 10_000, timeout: 15_000 },
    );

    if (claimed === null) continue;
    stats.timedOut += 1;
    if (claimed === "invoiced") {
      void recordSystemError({
        organizationId: null,
        category: "OVERAGE",
        summary: `Timed-out overage ${ev.id}: basePaise not restorable — parent already invoiced; manual billing adjustment needed`,
        err: new Error("OVERAGE_BASE_RESTORE_AFTER_INVOICE"),
        context: { overageEventId: ev.id },
      }).catch(() => {});
    }

    // Fire-and-forget — committed state, no DB writes in the notify path.
    void notifyMemberOverageTimedOut(ev.programAssignment.membership.userId, {
      orgName: ev.programAssignment.program.contract.organization.name,
      programName: ev.programAssignment.program.name,
      amountPaise: ev.marginalPaise,
      currency: ev.currency,
      payUrl: `${getAppUrl()}/dashboard/overage?charge=${ev.id}`,
    }).catch((err) =>
      console.error("[timeout-member-overages] notify failed:", err),
    );
  }

  return stats;
}

async function main() {
  await abortIfMaintenance("timeout-member-overages");
  console.log(
    `[timeout-member-overages] Starting at ${new Date().toISOString()}`,
  );
  Sentry.logger.info("job:timeout-member-overages started");
  const stats = await withCronLock(
    "timeout-member-overages",
    { failMode: "closed" },
    () => runTimeoutMemberOverages(),
  );
  console.log(
    `[timeout-member-overages] Done. scanned=${stats.scanned} timedOut=${stats.timedOut}`,
  );
  Sentry.logger.info("job:timeout-member-overages finished", {
    scanned: stats.scanned,
    timedOut: stats.timedOut,
  });
}

if (require.main === module) {
  runJob("timeout-member-overages", () =>
    main().finally(() => prisma.$disconnect()),
  );
}
