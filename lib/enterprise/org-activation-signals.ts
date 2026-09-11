/**
 * Server-side companion to org-activation.ts — the few extra reads the
 * analytics payload doesn't already carry. Lives apart from the pure model so
 * client components can import the derivations without pulling prisma (→ pg →
 * node builtins) into the browser bundle.
 */
import prisma from "@/lib/prisma";
import { ENABLE_LIVE_PAYOUTS } from "@/lib/feature-flags";
import { sumPaise } from "@/lib/payments/utils/money";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Kept bounded: aggregate counts + one capped assignment scan for the
 * cap-near signal.
 */
export async function resolveActivationSignals(orgId: string): Promise<{
  hasContract: boolean;
  hasActiveContract: boolean;
  contractExpiringSoonCount: number;
  kybVerified: boolean;
  pendingOverageCount: number;
  pendingOveragePaise: number;
  stuckPayoutCount: number;
  creditPoolMaxUtilizationPct: number | null;
}> {
  const now = new Date();
  const soon = new Date(now.getTime() + THIRTY_DAYS_MS);

  const [
    contractCount,
    activeContractCount,
    expiringCount,
    kyb,
    overageAgg,
    stuckPayoutCount,
    meteredAssignments,
  ] = await Promise.all([
    prisma.contract.count({ where: { organizationId: orgId } }),
    prisma.contract.count({
      where: { organizationId: orgId, status: "ACTIVE" },
    }),
    prisma.contract.count({
      where: {
        organizationId: orgId,
        status: "ACTIVE",
        effectiveTo: { gte: now, lte: soon },
      },
    }),
    prisma.orgKybVerification.findUnique({
      where: { organizationId: orgId },
      select: { kybVerifiedAt: true },
    }),
    prisma.overageEvent.aggregate({
      where: {
        programAssignment: { program: { contract: { organizationId: orgId } } },
        chargeStatus: { in: ["PENDING", "ACCRUED"] },
      },
      _count: { _all: true },
      _sum: { marginalPaise: true },
    }),
    ENABLE_LIVE_PAYOUTS
      ? Promise.resolve(0)
      : prisma.organizationPayout.count({
          where: { organizationId: orgId, status: "PROCESSING" },
        }),
    // Cap-near: scan active in-window assignments + their program meter (a
    // future row is 0% by definition — skip it). Bounded take — an org with
    // >500 live assignments is past the point this banner matters.
    prisma.programAssignment.findMany({
      where: {
        status: "ACTIVE",
        periodStart: { lte: now },
        program: { contract: { organizationId: orgId }, status: "ACTIVE" },
        periodEnd: { gte: now },
      },
      take: 500,
      select: {
        engagementsUsed: true,
        consumedPaise: true,
        program: {
          select: {
            type: true,
            licensedSeatConfig: {
              select: { coveredEngagementsPerCycle: true },
            },
            creditPoolConfig: { select: { creditBudgetPerCycle: true } },
          },
        },
      },
    }),
  ]);

  let maxPct: number | null = null;
  for (const a of meteredAssignments) {
    let pct: number | null = null;
    if (a.program.type === "CREDIT_POOL") {
      const budget = (a.program.creditPoolConfig?.creditBudgetPerCycle ?? 0) * 100;
      if (budget > 0) pct = (a.consumedPaise / budget) * 100;
    } else {
      const cap = a.program.licensedSeatConfig?.coveredEngagementsPerCycle;
      if (cap && cap > 0) pct = (a.engagementsUsed / cap) * 100;
    }
    if (pct != null) maxPct = maxPct == null ? pct : Math.max(maxPct, pct);
  }

  return {
    hasContract: contractCount > 0,
    hasActiveContract: activeContractCount > 0,
    contractExpiringSoonCount: expiringCount,
    kybVerified: kyb?.kybVerifiedAt != null,
    pendingOverageCount: overageAgg._count._all,
    pendingOveragePaise: sumPaise(overageAgg._sum.marginalPaise),
    stuckPayoutCount,
    creditPoolMaxUtilizationPct: maxPct,
  };
}
