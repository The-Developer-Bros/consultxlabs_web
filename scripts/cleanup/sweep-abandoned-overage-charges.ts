/**
 * Abandoned CHARGE_MEMBER overage-charge sweeper (#785, task #25).
 *
 * cycleOverageSoFarPaise (overage-settlement.ts) sums marginalPaise over
 * chargeStatus NOT IN (REVERSED, BLOCKED, FAILED) — so a never-paid PENDING
 * CHARGE_MEMBER side-charge COUNTS toward maxOveragePerCyclePaise and can
 * hard-block (402 PROGRAM_CAP_EXHAUSTED) the next legitimate booking even though
 * ₹0 was collected. No payment.failed webhook arrives for an abandon-before-pay,
 * so nothing frees the ceiling. This job FAILs abandoned PENDING side-charges; the
 * member can still retry later (FAILED→PENDING via the resume-checkout order route).
 */
import prisma from "@/lib/prisma";
import { transitionOverage } from "@/lib/payments/billing/overage-transitions";
import { restoreOverageBaseCarve } from "@/lib/payments/billing/overage-base-carve";
import { recordSystemError } from "@/lib/enterprise/system-events";
import { withCronLock } from "@/lib/cron/with-cron-lock";

export interface OverageSweepResult {
  success: boolean;
  scanned: number;
  failed: number;
}

// #476 — locked at the core so the GH Actions entry (jobs/**) and the
// CRON_SECRET HTTP entry (app/api/cleanup/**) share one mutual exclusion.
// fail-closed: FAILing a side-charge twice would double-free the ceiling.
export async function sweepAbandonedOverageCharges(
  opts: { ageDays?: number; limit?: number } = {},
): Promise<OverageSweepResult> {
  return withCronLock(
    "sweep-abandoned-overage-charges",
    { failMode: "closed" },
    () => sweepAbandonedOverageChargesUnlocked(opts),
  );
}

async function sweepAbandonedOverageChargesUnlocked(
  opts: { ageDays?: number; limit?: number } = {},
): Promise<OverageSweepResult> {
  const ageDays = opts.ageDays ?? 7;
  const limit = opts.limit ?? 500;
  const cutoff = new Date(Date.now() - ageDays * 86_400_000);

  // Abandoned = PENDING CHARGE_MEMBER side-charge older than the grace window
  // whose side-Payment never succeeded AND was never even started at the
  // gateway. #785: the side-Payment's `paymentIntent` is the synthetic
  // `overage:<parentId>` until the member opens resume-checkout, which the
  // order route (app/api/overage/[id]/order) overwrites with the real gateway
  // order id. So `paymentIntent startsWith "overage:"` ⟺ the member never
  // began paying = genuinely abandoned. A charge whose intent was replaced may
  // be captured-but-webhook-stuck; FAILing it would strand collected money
  // (a late capture is now recoverable via FAILED→CHARGED, but don't
  // manufacture that case). The state machine's allowed-from still skips a
  // charge that paid (→CHARGED) between this read and the transition.
  const abandoned = await prisma.overageEvent.findMany({
    where: {
      chargeStatus: "PENDING",
      overageBehavior: "CHARGE_MEMBER",
      createdAt: { lt: cutoff },
      OR: [
        { paymentId: null },
        {
          payment: {
            is: {
              paymentStatus: { not: "SUCCEEDED" },
              paymentIntent: { startsWith: "overage:" },
            },
          },
        },
      ],
    },
    select: { id: true },
    take: limit,
  });

  if (abandoned.length === 0) {
    return { success: true, scanned: 0, failed: 0 };
  }

  // Per-event tx: the PENDING→FAILED claim (CAS — a side-charge that paid
  // (→CHARGED) between the read and here matches zero rows) and the basePaise
  // restore (#812 §P0) must land together. chargeFailureReason makes the
  // silent write-off auditable (#779 §A) — the 14d timeout cron distinguishes
  // its own FAILs via chargeTimedOutAt.
  let failed = 0;
  let invoicedSkips = 0;
  for (const a of abandoned) {
    const outcome = await prisma.$transaction(async (tx) => {
      const moved = await transitionOverage(tx, { id: a.id }, "FAILED", {
        chargeFailureReason: `Abandoned before payment started (swept at ${ageDays}d)`,
      });
      if (moved === 0) return null;
      // FAILing the side-charge means the member never pays basePaise — give
      // it back to the org's parent accrual so the next rollup bills it.
      return restoreOverageBaseCarve(tx, { overageEventId: a.id });
    });
    if (outcome === null) continue;
    failed += 1;
    if (outcome === "invoiced") {
      // Parent already rolled onto an issued invoice with the carved (smaller)
      // base — the org was under-billed for this session. Needs a manual
      // billing adjustment; surface it instead of silently diverging the leg.
      invoicedSkips += 1;
      void recordSystemError({
        organizationId: null,
        category: "OVERAGE",
        summary: `Abandoned overage ${a.id}: basePaise not restorable — parent already invoiced; manual billing adjustment needed`,
        err: new Error("OVERAGE_BASE_RESTORE_AFTER_INVOICE"),
        context: { overageEventId: a.id },
      }).catch(() => {});
    }
  }

  console.log(
    `🧹 Failed ${failed} abandoned CHARGE_MEMBER overage charge(s) — circuit-breaker ceiling freed` +
      (invoicedSkips > 0
        ? ` (${invoicedSkips} need manual billing adjustment — parent already invoiced)`
        : ""),
  );
  return { success: true, scanned: abandoned.length, failed };
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
