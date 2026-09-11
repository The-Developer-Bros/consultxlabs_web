import type { Tx } from "@/lib/prisma";
/**
 * RateCard resolver — time-scoped rate lookup.
 *
 * A rate change must not rewrite history. When settlement processes a
 * payment (possibly days after the booking — earnings sit on a hold
 * period), it must apply the rate that was effective at the BOOKING
 * time, not the current rate card. Otherwise a retroactively-bumped
 * split would retroactively change what the consultant was owed for
 * work already done, which is both unfair and audit-unfriendly.
 *
 * The schema expresses this via `RateCard.effectiveFrom` + `effectiveTo`:
 * a rate change is modeled as a NEW RateCard row with `effectiveFrom =
 * now()` and the previous card's `effectiveTo = now()`. Time-windowed
 * queries return the card that governed a given instant.
 *
 * Resolution order (most specific wins):
 *   1. `Membership.rateCardOverride` — per-consultant override
 *   2. Contract-scoped RateCard matching `plan` + time window
 *   3. Org-scoped RateCard matching `plan` + time window
 *   4. Org-scoped default RateCard (planType=null, planId=null) matching time window
 *   5. Default 10/10/80 bps
 */

import type { Prisma, CoveredPlanType, RateCard } from "@prisma/client";

// #780 — reads come through the extended client (money as number); the raw
// model type still says bigint.
type RateCardRow = Omit<RateCard, "minGrossPaise" | "maxGrossPaise"> & {
  minGrossPaise: number | null;
  maxGrossPaise: number | null;
};

export interface ResolvedRateCard {
  rateCardId: string | null; // null → hardcoded default
  platformBps: number;
  orgBps: number;
  consultantBps: number;
}

export const DEFAULT_RATE_CARD: ResolvedRateCard = {
  rateCardId: null,
  platformBps: 1000, // 10%
  orgBps: 1000, // 10%
  consultantBps: 8000, // 80%
};

/**
 * #1335 — is settlement allowed to forward the booking's contract/plan scope?
 *
 * Off unless the value is exactly `"on"`, because flipping it changes which
 * card settles live money: contract- and plan-scoped cards have been creatable
 * since the resolver shipped and have never been selected, so any that already
 * exist would start paying a different split the moment they become reachable.
 * An org has to be able to audit its cards first and flip second.
 *
 * Read from `process.env` per call rather than at module load so the flip is a
 * deployment variable, not a value baked into whichever bundle imported this
 * module first. Same shape as `TDS_ENGINE` in
 * `lib/payments/payouts/payout-service.ts`.
 */
export function isScopedRateCardResolutionEnabled(): boolean {
  return process.env.RATE_CARD_SCOPED_RESOLUTION === "on";
}

function toResolved(card: RateCardRow): ResolvedRateCard {
  return {
    rateCardId: card.id,
    platformBps: card.platformBps,
    orgBps: card.orgBps,
    consultantBps: card.consultantBps,
  };
}

/**
 * Find the RateCard that was effective at `at` for the given scope.
 * Returns null if none found.
 */
async function findEffective(
  tx: Tx,
  where: Prisma.RateCardWhereInput,
  at: Date,
): Promise<RateCardRow | null> {
  return tx.rateCard.findFirst({
    where: {
      ...where,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: { effectiveFrom: "desc" },
  });
}

/**
 * Resolve the effective RateCard for a booking, applying the full
 * override chain.
 *
 * @param params.orgId              Organization id (null → marketplace default)
 * @param params.contractId         Contract id for Contract-scoped rate cards
 * @param params.membershipOverrideId  Direct override on Membership
 * @param params.planType           CoveredPlanType filter (plan-specific rates)
 * @param params.planId             Specific plan id filter (plan-level rates)
 * @param params.at                 Point in time — defaults to now()
 */
export async function resolveEffectiveRateCard(
  tx: Tx,
  params: {
    orgId: string | null;
    contractId?: string | null;
    membershipOverrideId?: string | null;
    planType?: CoveredPlanType | null;
    planId?: string | null;
    at?: Date;
  },
): Promise<ResolvedRateCard> {
  const at = params.at ?? new Date();

  // 1. Membership-level override. Scoped to the resolving org/contract: the
  // id arrives from membership state, and a dangling or cross-tenant id must
  // fall through to the plan/org/default chain — never silently settle
  // bookings on another org's split bps.
  if (params.membershipOverrideId) {
    const override = await tx.rateCard.findFirst({
      where: {
        id: params.membershipOverrideId,
        OR: [
          ...(params.contractId
            ? [{ ownerContractId: params.contractId }]
            : []),
          ...(params.orgId ? [{ ownerOrgId: params.orgId }] : []),
        ],
      },
    });
    if (override) return toResolved(override);
  }

  // 2 + 3. Plan-scoped (contract first, then org)
  if (params.planId) {
    if (params.contractId) {
      const card = await findEffective(
        tx,
        { ownerContractId: params.contractId, planId: params.planId },
        at,
      );
      if (card) return toResolved(card);
    }
    if (params.orgId) {
      const card = await findEffective(
        tx,
        { ownerOrgId: params.orgId, planId: params.planId },
        at,
      );
      if (card) return toResolved(card);
    }
  }

  if (params.planType) {
    if (params.contractId) {
      const card = await findEffective(
        tx,
        {
          ownerContractId: params.contractId,
          planType: params.planType,
          planId: null,
        },
        at,
      );
      if (card) return toResolved(card);
    }
    if (params.orgId) {
      const card = await findEffective(
        tx,
        { ownerOrgId: params.orgId, planType: params.planType, planId: null },
        at,
      );
      if (card) return toResolved(card);
    }
  }

  // 4. Org-scoped default
  if (params.contractId) {
    const card = await findEffective(
      tx,
      { ownerContractId: params.contractId, planType: null, planId: null },
      at,
    );
    if (card) return toResolved(card);
  }
  if (params.orgId) {
    const card = await findEffective(
      tx,
      { ownerOrgId: params.orgId, planType: null, planId: null },
      at,
    );
    if (card) return toResolved(card);
  }

  // 5. Default 10/10/80
  return DEFAULT_RATE_CARD;
}

/**
 * Bump a RateCard: mark the current effective card as `effectiveTo = now()`
 * and insert a new card with `effectiveFrom = now()`. The two operations
 * MUST run in the same transaction so reads are atomic.
 */
export async function bumpRateCard(
  tx: Tx,
  params: {
    scope: { ownerOrgId?: string; ownerContractId?: string };
    planType?: CoveredPlanType | null;
    planId?: string | null;
    next: { platformBps: number; orgBps: number; consultantBps: number };
    /**
     * Optional gross-amount bounds applied to the new card. Passed to
     * the initial `create` so callers don't need a follow-up update
     * just to set them. Both fields are nullable on the schema so
     * `undefined` means "leave unset (null)".
     */
    minGrossPaise?: number | null;
    maxGrossPaise?: number | null;
    effectiveAt?: Date;
    reason?: string;
  },
): Promise<RateCardRow> {
  const at = params.effectiveAt ?? new Date();
  const current = await findEffective(
    tx,
    {
      ...(params.scope.ownerOrgId && { ownerOrgId: params.scope.ownerOrgId }),
      ...(params.scope.ownerContractId && {
        ownerContractId: params.scope.ownerContractId,
      }),
      planType: params.planType ?? null,
      planId: params.planId ?? null,
    },
    at,
  );
  if (current) {
    await tx.rateCard.update({
      where: { id: current.id },
      data: { effectiveTo: at },
    });
  }
  return tx.rateCard.create({
    data: {
      ownerOrgId: params.scope.ownerOrgId ?? null,
      ownerContractId: params.scope.ownerContractId ?? null,
      planType: params.planType ?? null,
      planId: params.planId ?? null,
      platformBps: params.next.platformBps,
      orgBps: params.next.orgBps,
      consultantBps: params.next.consultantBps,
      minGrossPaise: params.minGrossPaise ?? null,
      maxGrossPaise: params.maxGrossPaise ?? null,
      effectiveFrom: at,
      effectiveTo: null,
    },
  });
}
