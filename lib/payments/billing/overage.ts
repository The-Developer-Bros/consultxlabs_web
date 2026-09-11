/**
 * #771 / #715 / #775 — overage calculator (review §10).
 *
 * Pure function: given a program's cap config + current cycle usage + the
 * booking price, compute the covered vs marginal (overage) split, apply the
 * optional surcharge markup + per-cycle circuit breaker, and resolve
 * `overageBehavior` (BLOCK / CHARGE_MEMBER / CHARGE_ORG) into a decision.
 *
 * Pricing model (#775): the marginal is the over-cap portion of the *real*
 * booking price (consulting rates are heterogeneous, so we pass through rather
 * than apply a flat per-unit tier), capped by `priceCapPerEngagementPaise`,
 * then marked up by `overageSurchargeBps`. CREDIT_POOL meters in paise
 * (`creditBudgetPaise`/`consumedPaise`); LICENSED_SEAT meters by engagement.
 *
 * Money is paise. No DB access — the caller loads the program config + cycle
 * usage, calls this, and (on PROCEED with marginal > 0) persists an
 * `OverageEvent` + the matching ledger postings; CHARGE_ORG events roll into
 * an `InvoiceLineItem` at the cycle-close invoice rollup, CHARGE_MEMBER events
 * settle instantly via a parent-linked side-Payment.
 */
import type { OverageBehavior, ProgramType } from "@prisma/client";

export interface OverageInput {
  programType: ProgramType; // LICENSED_SEAT | CREDIT_POOL
  bookingPricePaise: number;
  /** Engagements this booking consumes (1 for CONSULTATION; N for multi-session). */
  engagementsConsumed: number;
  overageBehavior: OverageBehavior;
  /** Per-cycle overage ceiling (circuit breaker); null = no ceiling. */
  maxOveragePerCyclePaise: number | null;
  /** Cumulative overage already charged this cycle (paise). */
  cycleOverageSoFarPaise: number;
  /**
   * #775 — bps markup applied to the pass-through marginal, AFTER the
   * per-engagement price cap. null/0 = no markup. May push the marginal above
   * the single booking price by the surcharge — intended (overage costs more).
   */
  overageSurchargeBps?: number | null;

  // LICENSED_SEAT inputs
  /** null = unlimited (LICENSE-funded contract). */
  coveredEngagementsPerCycle?: number | null;
  engagementsUsed?: number;
  /** Caps the marginal charge per overage engagement; null = uncapped. */
  priceCapPerEngagementPaise?: number | null;

  // CREDIT_POOL (money-meter, D4) inputs
  /** Cycle budget in paise (1 credit == ₹1 == 100 paise). */
  creditBudgetPaise?: number | null;
  consumedPaise?: number;
}

type OverageDecision = "PROCEED" | "BLOCK";
type OverageChargeTarget = "MEMBER" | "ORG" | null;

export interface OverageResult {
  coveredPaise: number;
  /** Pass-through over-cap portion (pre-surcharge). `coveredPaise + basePaise == price`. */
  basePaise: number;
  /** The `overageSurchargeBps` markup on `basePaise`. 0 when no surcharge. */
  surchargePaise: number;
  /** Authoritative charged total: `basePaise + surchargePaise`. */
  marginalPaise: number;
  decision: OverageDecision;
  chargeTo: OverageChargeTarget;
  reason: string;
}

/**
 * #777 §C — pre-booking overage *context*: the program config + the cycle usage
 * BEFORE this booking is metered. Lets two callers share one mapping into
 * `OverageInput` so the pre-checkout preview and the at-checkout recorder can
 * never drift:
 *   - the recorder (`recordOverageAtCheckout`) reconstructs the pre-booking
 *     state from the post-meter values (used-after − delta, consumed-after − price);
 *   - the preview (`previewOverageForBooking`) reads the assignment's current
 *     (still pre-booking) state directly.
 * Both then call `computeOverageForBooking` and get the identical decision.
 */
export interface OverageContext {
  programType: ProgramType;
  overageBehavior: OverageBehavior;
  overageSurchargeBps?: number | null;
  maxOveragePerCyclePaise: number | null;
  cycleOverageSoFarPaise: number;
  // LICENSED_SEAT
  coveredEngagementsPerCycle?: number | null;
  priceCapPerEngagementPaise?: number | null;
  /** Pre-booking engagements used this cycle. */
  engagementsUsed?: number;
  // CREDIT_POOL
  creditBudgetPaise?: number | null;
  /** Pre-booking paise consumed this cycle. */
  consumedPaise?: number;
}

/**
 * Map a pre-booking `OverageContext` + the prospective booking into the pure
 * `computeOverage`. Single source of truth for the `OverageInput` shape so the
 * preview and the recorder stay in lock-step (asserted in
 * `__tests__/enterprise/overage-preview.test.ts`).
 */
export function computeOverageForBooking(
  ctx: OverageContext,
  booking: { bookingPricePaise: number; engagementsConsumed: number },
): OverageResult {
  const base = {
    bookingPricePaise: booking.bookingPricePaise,
    engagementsConsumed: booking.engagementsConsumed,
    overageBehavior: ctx.overageBehavior,
    maxOveragePerCyclePaise: ctx.maxOveragePerCyclePaise,
    cycleOverageSoFarPaise: ctx.cycleOverageSoFarPaise,
    overageSurchargeBps: ctx.overageSurchargeBps ?? null,
  };
  return computeOverage(
    ctx.programType === "CREDIT_POOL"
      ? {
          ...base,
          programType: "CREDIT_POOL",
          creditBudgetPaise: ctx.creditBudgetPaise ?? null,
          consumedPaise: ctx.consumedPaise ?? 0,
        }
      : {
          ...base,
          programType: "LICENSED_SEAT",
          coveredEngagementsPerCycle: ctx.coveredEngagementsPerCycle ?? null,
          engagementsUsed: ctx.engagementsUsed ?? 0,
          priceCapPerEngagementPaise: ctx.priceCapPerEngagementPaise ?? null,
        },
  );
}

/** Compute the overage outcome for one booking. Pure; no side effects. */
export function computeOverage(input: OverageInput): OverageResult {
  const price = Math.max(0, Math.floor(input.bookingPricePaise));

  // --- Step 1: coverage split → marginalPaise -----------------------------
  let coveredPaise = price;
  let marginalPaise = 0;

  if (input.programType === "CREDIT_POOL") {
    const budget = input.creditBudgetPaise ?? 0;
    const consumed = input.consumedPaise ?? 0;
    const remaining = Math.max(0, budget - consumed);
    coveredPaise = Math.min(price, remaining);
    marginalPaise = price - coveredPaise;
  } else {
    // LICENSED_SEAT
    const cap = input.coveredEngagementsPerCycle;
    if (cap === null || cap === undefined) {
      // Unlimited (LICENSE-funded): fully covered, no overage.
      coveredPaise = price;
      marginalPaise = 0;
    } else {
      const used = input.engagementsUsed ?? 0;
      // #710/#713 — defensive lower bound only. Callers MUST pass the true
      // engagement count (CLASS debits N): a 0/garbage input floors to 1 and
      // UNDER-counts the over-cap split for multi-session bookings. The
      // recorder passes max(1, meter delta) and the meter never flags overage
      // on a 0 delta, so 1 is unreachable-wrong in practice; NaN is normalized
      // so the split can't poison every downstream paise field.
      const engagements = Number.isFinite(input.engagementsConsumed)
        ? Math.max(1, Math.floor(input.engagementsConsumed))
        : 1;
      const remainingSeats = Math.max(0, cap - used);
      if (remainingSeats >= engagements) {
        coveredPaise = price;
        marginalPaise = 0;
      } else {
        const overageEngagements = engagements - remainingSeats;
        const perEngagement = Math.floor(price / engagements);
        const rawMarginal = overageEngagements * perEngagement;
        const perCap = input.priceCapPerEngagementPaise;
        // priceCap caps the marginal per overage engagement (an absorbed discount).
        const capped =
          perCap != null
            ? Math.min(rawMarginal, overageEngagements * perCap)
            : rawMarginal;
        marginalPaise = Math.min(price, capped);
        coveredPaise = price - marginalPaise;
      }
    }
  }

  if (marginalPaise <= 0) {
    return {
      coveredPaise: price,
      basePaise: 0,
      surchargePaise: 0,
      marginalPaise: 0,
      decision: "PROCEED",
      chargeTo: null,
      reason: "within cap",
    };
  }

  // --- Step 1b: surcharge markup on the pass-through marginal --------------
  // `basePaise` is the pass-through over-cap portion (covered + base == price).
  // The surcharge is itemized separately so the total stays auditable: the
  // marginal == base + surcharge, and the surcharge is what pushes the marginal
  // above the single booking price.
  const basePaise = marginalPaise;
  const surchargeBps = input.overageSurchargeBps ?? 0;
  const surchargePaise =
    surchargeBps > 0 ? Math.floor((basePaise * surchargeBps) / 10000) : 0;
  marginalPaise = basePaise + surchargePaise;

  // --- Step 2: per-cycle circuit breaker → hard BLOCK regardless of behavior
  if (
    input.maxOveragePerCyclePaise != null &&
    input.cycleOverageSoFarPaise + marginalPaise > input.maxOveragePerCyclePaise
  ) {
    return {
      coveredPaise,
      basePaise,
      surchargePaise,
      marginalPaise,
      decision: "BLOCK",
      chargeTo: null,
      reason: "per-cycle overage ceiling reached (circuit breaker)",
    };
  }

  // --- Step 3: behavior branch --------------------------------------------
  switch (input.overageBehavior) {
    case "BLOCK":
      return {
        coveredPaise,
        basePaise,
        surchargePaise,
        marginalPaise,
        decision: "BLOCK",
        chargeTo: null,
        reason: "cap exhausted, behavior=BLOCK",
      };
    case "CHARGE_MEMBER":
      return {
        coveredPaise,
        basePaise,
        surchargePaise,
        marginalPaise,
        decision: "PROCEED",
        chargeTo: "MEMBER",
        reason: "overage charged to member",
      };
    case "CHARGE_ORG":
      return {
        coveredPaise,
        basePaise,
        surchargePaise,
        marginalPaise,
        decision: "PROCEED",
        chargeTo: "ORG",
        reason: "overage charged to org invoice",
      };
    default:
      return {
        coveredPaise,
        basePaise,
        surchargePaise,
        marginalPaise,
        decision: "BLOCK",
        chargeTo: null,
        reason: "unknown overageBehavior — failing safe to BLOCK",
      };
  }
}
