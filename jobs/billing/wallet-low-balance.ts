/**
 * #777 §C — WALLET low-balance cron. NOTIFY-ONLY floor.
 *
 * Candidates: WALLET BillingAccounts with a configured minBalancePaise whose
 * live walletBalance has dipped below it, that haven't fired in the last 24h.
 * `autoTopUpLastFiredAt` doubles as the notify cooldown — one alert per
 * account per day, claimed via a conditional updateMany so two cron replicas
 * (or a same-day re-run) can't double-notify.
 *
 * There is NO money movement here and NO WalletTopUp row is created. The
 * gateway-mandate auto-charge is a TODO(#1319) for when Razorpay mandates land
 * (that's why autoTopUpMandateId / autoTopUpAmountPaise stay unused by this
 * wave). For now we just detect, tell finance, and stamp the cooldown.
 *
 * Schedule: daily at 05:15 IST (`.github/workflows/wallet-low-balance.yml`).
 * Quiet slot — after the 23:30 UTC dunning cron, no other cron at 23:xx.
 *
 * Usage:
 *   npx tsx jobs/billing/wallet-low-balance.ts
 */

import "dotenv/config";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "@/lib/observability/job-sentry";
import prisma from "@/lib/prisma";
import { notifyOrgWalletLow } from "@/lib/novu/org-workflows";
import { getAppUrl } from "@/lib/url";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { abortIfMaintenance } from "@/lib/maintenance-cron";

const COOLDOWN_MS = 24 * 60 * 60 * 1000;

interface WalletLowStats {
  scanned: number;
  notified: number;
}

export async function runWalletLowBalance(): Promise<WalletLowStats> {
  const stats: WalletLowStats = { scanned: 0, notified: 0 };
  const now = new Date();
  const cooldownCutoff = new Date(now.getTime() - COOLDOWN_MS);

  // walletBalance < minBalancePaise can't be expressed as a column compare in
  // the Prisma filter, so we narrow on the cooldown + non-null floor here and
  // do the balance comparison in JS below.
  const candidates = await prisma.billingAccount.findMany({
    where: {
      fundingSource: "WALLET",
      minBalancePaise: { not: null },
      OR: [
        { autoTopUpLastFiredAt: null },
        { autoTopUpLastFiredAt: { lt: cooldownCutoff } },
      ],
    },
    select: {
      id: true,
      ownerOrgId: true,
      walletBalance: true,
      minBalancePaise: true,
      currency: true,
      autoTopUpLastFiredAt: true,
      organization: { select: { name: true } },
    },
  });

  for (const ba of candidates) {
    const balance = ba.walletBalance ?? 0;
    const minimum = ba.minBalancePaise ?? 0;
    if (balance >= minimum) continue;
    stats.scanned += 1;

    // Claim the row by stamping the cooldown only if the value we read still
    // holds — the same gate doubles as the per-account 24h rate-limit. Loser
    // (concurrent replica / re-run) sees count 0 and skips the notify.
    const claim = await prisma.billingAccount.updateMany({
      where: { id: ba.id, autoTopUpLastFiredAt: ba.autoTopUpLastFiredAt },
      data: { autoTopUpLastFiredAt: now },
    });
    if (claim.count === 0) continue;

    // TODO(#1319): when Razorpay mandates land, charge autoTopUpMandateId for
    // autoTopUpAmountPaise here (inside a tx that writes the WalletTopUp +
    // ledger row) when autoTopUpEnabled. This wave is NOTIFY-ONLY — no money
    // moves and no WalletTopUp is created.

    stats.notified += 1;
    void notifyOrgWalletLow(ba.ownerOrgId, {
      orgName: ba.organization?.name ?? "",
      balancePaise: balance,
      minimumPaise: minimum,
      currency: ba.currency,
      topUpUrl: `${getAppUrl()}/dashboard/organization/${ba.ownerOrgId}/billing`,
    }).catch((err) =>
      console.error("[wallet-low-balance] notify failed:", err),
    );
  }

  return stats;
}

async function main() {
  await abortIfMaintenance("wallet-low-balance");
  console.log(`[wallet-low-balance] Starting at ${new Date().toISOString()}`);
  Sentry.logger.info("job:wallet-low-balance started");
  const stats = await withCronLock(
    "wallet-low-balance",
    { failMode: "open" },
    () => runWalletLowBalance(),
  );
  console.log(
    `[wallet-low-balance] Done. scanned=${stats.scanned} notified=${stats.notified}`,
  );
  Sentry.logger.info("job:wallet-low-balance finished", {
    scanned: stats.scanned,
    notified: stats.notified,
  });
}

if (require.main === module) {
  runJob("wallet-low-balance", () =>
    main().finally(() => prisma.$disconnect()),
  );
}
