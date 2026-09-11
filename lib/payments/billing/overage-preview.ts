/**
 * #777 §C — pre-checkout overage *preview*. Advisory only: the authoritative
 * overage is computed + persisted at checkout by `recordOverageAtCheckout`.
 * This resolver answers "if this member books this plan via this org now, will
 * it breach the cap, and what does it cost?" so the checkout UI can warn BEFORE
 * pay instead of surfacing a charge after.
 *
 * It resolves the same active ProgramAssignment as checkout and runs the same
 * `computeOverageForBooking` mapper over the assignment's CURRENT (pre-booking)
 * usage — so preview and recorder share one code path and can't drift.
 */
import prisma from "@/lib/prisma";
import type { CoveredPlanType, OverageBehavior } from "@prisma/client";
import {
  computeOverageForBooking,
  type OverageContext,
} from "@/lib/payments/billing/overage";
import { sumPaise } from "@/lib/payments/utils/money";

export interface OveragePreviewParams {
  organizationId: string;
  membershipId: string;
  coveredPlanType: CoveredPlanType;
  bookingPricePaise: number;
  /** Engagements this booking consumes (1 for CONSULTATION/WEBINAR). */
  engagementsConsumed?: number;
}

export interface OveragePreviewResult {
  /**
   * false → nothing to warn about: PERSONAL funding, no covering assignment, or
   * an unlimited LICENSE seat (fully covered). The checkout shows no overage line.
   */
  applicable: boolean;
  programName: string | null;
  overageBehavior: OverageBehavior | null;
  coveredPaise: number;
  /** What the member (CHARGE_MEMBER) or org (CHARGE_ORG) will owe over the cap. */
  marginalPaise: number;
  surchargePaise: number;
  willExceedCap: boolean;
  /** true → the booking is refused at the cap (BLOCK behavior or circuit breaker). */
  willBlock: boolean;
  chargeTo: "MEMBER" | "ORG" | null;
  reason: string;
}

const NOT_APPLICABLE: OveragePreviewResult = {
  applicable: false,
  programName: null,
  overageBehavior: null,
  coveredPaise: 0,
  marginalPaise: 0,
  surchargePaise: 0,
  willExceedCap: false,
  willBlock: false,
  chargeTo: null,
  reason: "no org-covered allocation",
};

export async function previewOverageForBooking(
  params: OveragePreviewParams,
): Promise<OveragePreviewResult> {
  const { organizationId, membershipId, coveredPlanType } = params;
  const bookingPricePaise = Math.max(0, Math.floor(params.bookingPricePaise));
  const engagementsConsumed = Math.max(
    1,
    Math.floor(params.engagementsConsumed ?? 1),
  );

  // PERSONAL funding never meters against a program → no overage concept.
  const billingAccount = await prisma.billingAccount.findUnique({
    where: { ownerOrgId: organizationId },
    select: { fundingSource: true },
  });
  if (billingAccount?.fundingSource === "PERSONAL") return NOT_APPLICABLE;

  const now = new Date();
  const assignment = await prisma.programAssignment.findFirst({
    where: {
      membershipId,
      periodStart: { lte: now },
      periodEnd: { gte: now },
      program: {
        status: "ACTIVE",
        OR: [
          { coveredPlanTypes: { isEmpty: true } },
          { coveredPlanTypes: { has: coveredPlanType } },
        ],
        contract: {
          organizationId,
          status: "ACTIVE",
          effectiveFrom: { lte: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }],
        },
      },
    },
    orderBy: { periodEnd: "desc" },
    select: {
      id: true,
      engagementsUsed: true,
      consumedPaise: true,
      program: {
        select: {
          name: true,
          type: true,
          licensedSeatConfig: {
            select: {
              overageBehavior: true,
              overageSurchargeBps: true,
              maxOveragePerCyclePaise: true,
              coveredEngagementsPerCycle: true,
              priceCapPerEngagementPaise: true,
            },
          },
          creditPoolConfig: {
            select: {
              overageBehavior: true,
              overageSurchargeBps: true,
              maxOveragePerCyclePaise: true,
              creditBudgetPerCycle: true,
            },
          },
        },
      },
    },
  });

  if (!assignment) return NOT_APPLICABLE;

  // Cycle overage-so-far — same query as the recorder (a ProgramAssignment is
  // per-cycle, so every non-reversed event on it is cycle-scoped).
  const soFarAgg = await prisma.overageEvent.aggregate({
    where: {
      programAssignmentId: assignment.id,
      chargeStatus: { notIn: ["REVERSED", "BLOCKED", "FAILED"] },
    },
    _sum: { marginalPaise: true },
  });
  const cycleOverageSoFarPaise = sumPaise(soFarAgg._sum.marginalPaise);

  const isCredit = assignment.program.type === "CREDIT_POOL";
  const lsc = assignment.program.licensedSeatConfig;
  const cpc = assignment.program.creditPoolConfig;

  const ctx: OverageContext = isCredit
    ? {
        programType: "CREDIT_POOL",
        overageBehavior: cpc?.overageBehavior ?? "BLOCK",
        overageSurchargeBps: cpc?.overageSurchargeBps ?? null,
        maxOveragePerCyclePaise: cpc?.maxOveragePerCyclePaise ?? null,
        cycleOverageSoFarPaise,
        // 1 credit = ₹1 = 100 paise (same as recordBookingUtilization).
        creditBudgetPaise: (cpc?.creditBudgetPerCycle ?? 0) * 100,
        consumedPaise: assignment.consumedPaise,
      }
    : {
        programType: "LICENSED_SEAT",
        overageBehavior: lsc?.overageBehavior ?? "BLOCK",
        overageSurchargeBps: lsc?.overageSurchargeBps ?? null,
        maxOveragePerCyclePaise: lsc?.maxOveragePerCyclePaise ?? null,
        cycleOverageSoFarPaise,
        coveredEngagementsPerCycle: lsc?.coveredEngagementsPerCycle ?? null,
        engagementsUsed: assignment.engagementsUsed,
        priceCapPerEngagementPaise: lsc?.priceCapPerEngagementPaise ?? null,
      };

  const result = computeOverageForBooking(ctx, {
    bookingPricePaise,
    engagementsConsumed,
  });

  return {
    applicable: true,
    programName: assignment.program.name,
    overageBehavior: ctx.overageBehavior,
    coveredPaise: result.coveredPaise,
    marginalPaise: result.marginalPaise,
    surchargePaise: result.surchargePaise,
    willExceedCap: result.marginalPaise > 0,
    willBlock: result.decision === "BLOCK",
    chargeTo: result.chargeTo,
    reason: result.reason,
  };
}
