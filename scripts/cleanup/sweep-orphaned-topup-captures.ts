/**
 * Captured-but-uncredited wallet top-up reconciler (#785, task #23).
 *
 * confirmTopUp's body is a single $transaction (claim PENDING→CONFIRMED + wallet
 * credit + ledger post). If the ledger post fails the whole tx rolls back, so a
 * gateway-CAPTURED top-up reverts to PENDING and the gateway won't resend. Before
 * #785 the abandoned-cleanup cron then hard-deleted it, losing the org's money.
 *
 * confirmTopUp now stamps `capturedAt` + `providerPaymentId` OUTSIDE the tx, so a
 * captured-but-uncredited top-up keeps those even after a rollback. This job finds
 * those rows and re-runs the (idempotent) confirm to land the credit.
 */
import prisma from "@/lib/prisma";
import { confirmTopUp } from "@/lib/api/organizations/wallet";
import { withCronLock } from "@/lib/cron/with-cron-lock";

export interface TopupCaptureSweepResult {
  success: boolean;
  scanned: number;
  recredited: number;
  stillFailing: number;
  errors: string[];
}

export interface TopupCaptureSweepOptions {
  /** Let confirmTopUp's own in-request path settle first. */
  graceMinutes?: number;
  /** Long tail — the money is real; don't silently drop very old captures. */
  maxAgeHours?: number;
  limit?: number;
}

// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function sweepOrphanedTopupCaptures(
  opts: TopupCaptureSweepOptions = {},
): Promise<TopupCaptureSweepResult> {
  return withCronLock("sweep-orphaned-topup-captures", { failMode: "closed" }, () =>
    sweepOrphanedTopupCapturesUnlocked(opts),
  );
}

async function sweepOrphanedTopupCapturesUnlocked(
  opts: TopupCaptureSweepOptions = {},
): Promise<TopupCaptureSweepResult> {
  const graceMinutes = opts.graceMinutes ?? 5;
  const maxAgeHours = opts.maxAgeHours ?? 720; // 30 days
  const limit = opts.limit ?? 200;
  const now = Date.now();
  const captureBefore = new Date(now - graceMinutes * 60_000);
  const tooOld = new Date(now - maxAgeHours * 3_600_000);

  // Captured (capturedAt + providerPaymentId set outside the tx) but still
  // PENDING ⇒ the confirm/ledger post rolled back. `lt/gte` on capturedAt also
  // excludes null (null never satisfies a comparison in Postgres).
  const orphans = await prisma.walletTopUp.findMany({
    where: {
      status: "PENDING",
      providerPaymentId: { not: null },
      capturedAt: { lt: captureBefore, gte: tooOld },
    },
    select: { providerOrderId: true, providerPaymentId: true, amountPaise: true },
    orderBy: { capturedAt: "asc" },
    take: limit,
  });

  const errors: string[] = [];
  let recredited = 0;
  let stillFailing = 0;

  for (const t of orphans) {
    try {
      const result = await confirmTopUp(prisma, {
        providerOrderId: t.providerOrderId,
        providerPaymentId: t.providerPaymentId!,
        amountPaise: t.amountPaise,
      });
      // confirmed=false ⇒ a concurrent path already CONFIRMED it (not stuck).
      if (result.confirmed) {
        recredited++;
        console.log(`✅ Re-credited captured top-up ${t.providerOrderId}`);
      }
    } catch (e) {
      stillFailing++;
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${t.providerOrderId}: ${msg}`);
    }
  }

  return { success: true, scanned: orphans.length, recredited, stillFailing, errors };
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
