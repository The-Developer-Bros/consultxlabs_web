/**
 * @jest-environment node
 */

/**
 * #777 §C — the pre-checkout preview and the at-checkout recorder MUST agree.
 * Both now funnel through `computeOverageForBooking`, so this pins:
 *   (1) the shared mapper == the raw `computeOverage` for the same inputs
 *       (no drift in the context → input translation), and
 *   (2) a behavior table (covered / CHARGE_MEMBER / CHARGE_ORG / BLOCK /
 *       circuit-breaker / CREDIT_POOL money-meter) so a future edit can't
 *       silently change what a member is warned about vs what they're charged.
 */

import {
  computeOverage,
  computeOverageForBooking,
  type OverageContext,
} from "@/lib/payments/billing/overage";

describe("computeOverageForBooking — parity with computeOverage", () => {
  it("LICENSED_SEAT context maps identically to the raw input", () => {
    const ctx: OverageContext = {
      programType: "LICENSED_SEAT",
      overageBehavior: "CHARGE_ORG",
      overageSurchargeBps: 1000,
      maxOveragePerCyclePaise: null,
      cycleOverageSoFarPaise: 0,
      coveredEngagementsPerCycle: 5,
      engagementsUsed: 5,
      priceCapPerEngagementPaise: null,
    };
    const viaMapper = computeOverageForBooking(ctx, {
      bookingPricePaise: 100_000,
      engagementsConsumed: 1,
    });
    const viaRaw = computeOverage({
      programType: "LICENSED_SEAT",
      bookingPricePaise: 100_000,
      engagementsConsumed: 1,
      overageBehavior: "CHARGE_ORG",
      overageSurchargeBps: 1000,
      maxOveragePerCyclePaise: null,
      cycleOverageSoFarPaise: 0,
      coveredEngagementsPerCycle: 5,
      engagementsUsed: 5,
      priceCapPerEngagementPaise: null,
    });
    expect(viaMapper).toEqual(viaRaw);
  });

  it("CREDIT_POOL context maps identically to the raw input", () => {
    const ctx: OverageContext = {
      programType: "CREDIT_POOL",
      overageBehavior: "CHARGE_MEMBER",
      overageSurchargeBps: null,
      maxOveragePerCyclePaise: null,
      cycleOverageSoFarPaise: 0,
      creditBudgetPaise: 50_000,
      consumedPaise: 50_000,
    };
    const viaMapper = computeOverageForBooking(ctx, {
      bookingPricePaise: 30_000,
      engagementsConsumed: 1,
    });
    const viaRaw = computeOverage({
      programType: "CREDIT_POOL",
      bookingPricePaise: 30_000,
      engagementsConsumed: 1,
      overageBehavior: "CHARGE_MEMBER",
      overageSurchargeBps: null,
      maxOveragePerCyclePaise: null,
      cycleOverageSoFarPaise: 0,
      creditBudgetPaise: 50_000,
      consumedPaise: 50_000,
    });
    expect(viaMapper).toEqual(viaRaw);
  });
});

describe("computeOverageForBooking — preview behavior table", () => {
  const seat = (over: Partial<OverageContext> = {}): OverageContext => ({
    programType: "LICENSED_SEAT",
    overageBehavior: "CHARGE_MEMBER",
    maxOveragePerCyclePaise: null,
    cycleOverageSoFarPaise: 0,
    coveredEngagementsPerCycle: 5,
    engagementsUsed: 2,
    priceCapPerEngagementPaise: null,
    ...over,
  });

  it("within cap → not an overage (nothing to warn)", () => {
    const r = computeOverageForBooking(seat(), {
      bookingPricePaise: 100_000,
      engagementsConsumed: 1,
    });
    expect(r.marginalPaise).toBe(0);
    expect(r.decision).toBe("PROCEED");
  });

  it("cap exhausted + CHARGE_MEMBER → member owes the marginal", () => {
    const r = computeOverageForBooking(
      seat({ engagementsUsed: 5, overageBehavior: "CHARGE_MEMBER" }),
      { bookingPricePaise: 100_000, engagementsConsumed: 1 },
    );
    expect(r.marginalPaise).toBe(100_000);
    expect(r.chargeTo).toBe("MEMBER");
    expect(r.decision).toBe("PROCEED");
  });

  it("cap exhausted + CHARGE_ORG → org owes the marginal", () => {
    const r = computeOverageForBooking(
      seat({ engagementsUsed: 5, overageBehavior: "CHARGE_ORG" }),
      { bookingPricePaise: 100_000, engagementsConsumed: 1 },
    );
    expect(r.chargeTo).toBe("ORG");
    expect(r.decision).toBe("PROCEED");
  });

  it("cap exhausted + BLOCK → booking refused", () => {
    const r = computeOverageForBooking(
      seat({ engagementsUsed: 5, overageBehavior: "BLOCK" }),
      { bookingPricePaise: 100_000, engagementsConsumed: 1 },
    );
    expect(r.decision).toBe("BLOCK");
    expect(r.chargeTo).toBeNull();
  });

  it("circuit breaker ceiling reached → BLOCK regardless of behavior", () => {
    const r = computeOverageForBooking(
      seat({
        engagementsUsed: 5,
        overageBehavior: "CHARGE_ORG",
        maxOveragePerCyclePaise: 50_000,
        cycleOverageSoFarPaise: 0,
      }),
      { bookingPricePaise: 100_000, engagementsConsumed: 1 },
    );
    expect(r.decision).toBe("BLOCK");
    expect(r.reason).toContain("circuit breaker");
  });

  it("CREDIT_POOL money-meter → marginal is the over-budget paise", () => {
    const r = computeOverageForBooking(
      {
        programType: "CREDIT_POOL",
        overageBehavior: "CHARGE_MEMBER",
        maxOveragePerCyclePaise: null,
        cycleOverageSoFarPaise: 0,
        creditBudgetPaise: 50_000,
        consumedPaise: 40_000,
      },
      { bookingPricePaise: 30_000, engagementsConsumed: 1 },
    );
    // 10_000 of the 30_000 booking is covered; 20_000 is overage.
    expect(r.coveredPaise).toBe(10_000);
    expect(r.marginalPaise).toBe(20_000);
    expect(r.chargeTo).toBe("MEMBER");
  });
});
