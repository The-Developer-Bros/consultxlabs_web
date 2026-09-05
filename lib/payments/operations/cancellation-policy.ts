/**
 * Cancellation/refund policy — the pure maths, and nothing else.
 *
 * The terms that govern a booking are typed, versioned rows since #1499
 * (`CancellationPolicy` + `CancellationPolicyTier`), pointed at by
 * `Appointment.cancellationPolicyId`. A published version is immutable, so an org
 * or the platform editing its ladder later never retroactively changes a buyer's
 * terms — the same guarantee the old `Json` snapshot gave, now with FK integrity
 * and per-org tiers behind it.
 *
 * This module stays free of Prisma on purpose: it is imported by the cancel routes,
 * the trial and event refund paths and the support context, and it is unit-tested
 * with no mocks. Loading a policy row is `cancellation-policy-store.ts`; turning one
 * into money is here.
 */

/** One rung of a notice ladder, in the units the API and the UI speak. */
export interface RefundTier {
  /** Tier applies when the booking starts at least this many hours away. */
  hoursBefore: number;
  /** Percentage of the paid amount refunded; may carry two decimals. */
  refundPct: number;
}

/** A loaded policy version, flattened to what the maths needs. */
export interface CancellationPolicyTerms {
  /** The row these terms came from; null for the built-in platform fallback. */
  policyId: string | null;
  source: "PLATFORM" | "ORG";
  version: number;
  tiers: RefundTier[];
  /** Consultant-initiated cancellations always refund this percentage. */
  consultantInitiatedPct: number;
}

// Industry-standard defaults (Calendly/Cal.com-style): full refund a day out,
// half inside the day, nothing inside two hours. Consultant-initiated is
// always 100% — the buyer did nothing wrong.
export const PLATFORM_DEFAULT_TIERS: RefundTier[] = [
  { hoursBefore: 24, refundPct: 100 },
  { hoursBefore: 2, refundPct: 50 },
  { hoursBefore: 0, refundPct: 0 },
];

/**
 * The ladder every booking falls back to: a booking with no policy row, a booking
 * sold before #1499, and an org that has never published its own.
 */
export const PLATFORM_DEFAULT_TERMS: CancellationPolicyTerms = {
  policyId: null,
  source: "PLATFORM",
  version: 1,
  tiers: PLATFORM_DEFAULT_TIERS,
  consultantInitiatedPct: 100,
};

/** A version may not carry more rungs than this — see `validateTierLadder`. */
export const MAX_POLICY_TIERS = 6;

/**
 * Whether a percentage carries at most two decimal places, i.e. whether it
 * survives the `Math.round(pct * 100)` that stores it as basis points.
 *
 * The obvious test, `Math.round(v * 100) !== v * 100`, rejects perfectly legal
 * percentages: `0.07 * 100` is `7.000000000000001` in IEEE 754, so a 0.07% rung
 * an OWNER typed was refused as "more than two decimal places". Compare against
 * a tolerance instead — 1e-6 basis points is far below anything a percentage can
 * legitimately mean, and far above the representation error (#1513 review).
 */
export function isTwoDecimalPercent(v: number): boolean {
  const bps = v * 100;
  return Number.isFinite(bps) && Math.abs(bps - Math.round(bps)) < 1e-6;
}

/** Basis-point rows as stored → the percent tiers the maths and the API use. */
export function tiersFromBps(
  rows: { hoursBefore: number; refundBps: number }[],
): RefundTier[] {
  return rows.map((row) => ({
    hoursBefore: row.hoursBefore,
    refundPct: row.refundBps / 100,
  }));
}

/**
 * The one ladder rule, shared by the Zod body schema, the publish helper and the
 * seed, so a ladder that the editor accepts cannot be one the quote cannot read.
 * Returns null when the ladder is valid, or the reason it is not.
 *
 * The last rung must be exactly `hoursBefore: 0` because `computeRefundPct` walks
 * the rungs downwards and returns 0 if it falls off the end — a ladder that stops
 * at 2 hours would silently mean "nothing inside two hours" without ever saying so.
 */
export function validateTierLadder(tiers: RefundTier[]): string | null {
  if (tiers.length < 1) return "A policy needs at least one tier";
  if (tiers.length > MAX_POLICY_TIERS)
    return `A policy may not have more than ${MAX_POLICY_TIERS} tiers`;
  const sorted = [...tiers].sort((a, b) => b.hoursBefore - a.hoursBefore);
  for (const [index, tier] of sorted.entries()) {
    if (!Number.isInteger(tier.hoursBefore) || tier.hoursBefore < 0)
      return "Each tier's notice must be a whole number of hours, zero or more";
    if (tier.refundPct < 0 || tier.refundPct > 100)
      return "Each tier's refund must be between 0 and 100 percent";
    if (!isTwoDecimalPercent(tier.refundPct))
      return "A refund percentage may carry at most two decimal places";
    if (index > 0 && sorted[index - 1].hoursBefore === tier.hoursBefore)
      return "Two tiers may not share the same notice period";
  }
  if (sorted[sorted.length - 1].hoursBefore !== 0)
    return "The last tier must start at 0 hours so every cancellation is covered";
  return null;
}

/**
 * Percentage of the paid amount to refund for a cancellation `hoursUntilStart`
 * hours before the booking starts. Negative hours (already started/past)
 * refund nothing unless consultant-initiated.
 */
export function computeRefundPct(
  terms: CancellationPolicyTerms | null | undefined,
  hoursUntilStart: number,
  isConsultantInitiated: boolean,
): number {
  const policy = terms ?? PLATFORM_DEFAULT_TERMS;
  if (isConsultantInitiated) return policy.consultantInitiatedPct;
  if (hoursUntilStart < 0) return 0;
  // Tiers sorted descending by hoursBefore; first tier whose threshold the
  // cancellation clears wins.
  const sorted = [...policy.tiers].sort(
    (a, b) => b.hoursBefore - a.hoursBefore,
  );
  for (const tier of sorted) {
    if (hoursUntilStart >= tier.hoursBefore) return tier.refundPct;
  }
  return 0;
}

/** Everything the quote needs, all of it read off `BookingRefundContext`. */
export interface BookingRefundQuoteInput {
  /** The terms loaded from the booking's policy row; null falls back to platform. */
  policy: CancellationPolicyTerms | null;
  /** Null when the booking has no undelivered session left. */
  hoursUntilNextSession: number | null;
  /** Slots of any status on the booking; zero means none was ever scheduled. */
  slotsTotal: number;
  /** Sessions still owed to the buyer — the proration numerator. */
  sessionsRemaining: number;
  /** Only a subscription prorates; every other booking refunds off the whole price. */
  isSubscription: boolean;
  isConsultantInitiated: boolean;
  /** #1500 — the whole booking was paid with referral/free credit (`free_`, amount 0). */
  isFreeCreditFunded: boolean;
  /** Gross captured on the booking's payment, in paise. */
  grossPaise: number;
  /** Gross less anything already given back. */
  refundablePaise: number;
}

export interface BookingRefundQuote {
  /** What the booking actually settles at, after the #1500 credit rule. */
  refundPct: number;
  /**
   * What the notice ladder alone answered, before the credit rule rounded it up.
   * Surfaced rather than recomputed so the refund reason can name the real tier
   * without a second implementation of the ladder.
   */
  tierRefundPct: number;
  /** The notice the tier table was asked about; infinite when never scheduled. */
  noticeHours: number;
  /** The undelivered share of the price, before the tier percentage. */
  proratedBasePaise: number;
  /** True only when proration actually moved the number. */
  prorated: boolean;
  /** What the cancellation pays back, clamped to the refundable balance. */
  refundPaise: number;
  /** #1500 — the credit is restored whole rather than at the tier percentage. */
  creditRestoresInFull: boolean;
}

/**
 * What cancelling a 1:1 booking right now pays back (#1319).
 *
 * The cancel route and its preview both used to compute this inline, the same
 * four steps in the same order, in two files — which is the shape of a number
 * that eventually stops agreeing with itself. The preview's whole purpose is to
 * tell a buyer what the click will do, so a quote that restates the rule rather
 * than calling it is a second opinion. Both sides call this now.
 *
 * The steps, and why each is what it is:
 *
 *   - Notice. A booking with no slot ever scheduled has INFINITE notice, not
 *     negative notice. Mapping "never allocated" onto the same -1 as "already
 *     started" made cancelling earlier score worse than cancelling later, which
 *     no tier table can mean. It is keyed on `slotsTotal` deliberately, because
 *     deriving it from the absence of live and completed slots would also match
 *     a booking whose slots have all been cancelled.
 *   - Tier. `computeRefundPct` against the terms frozen at purchase.
 *   - Proration (#1006). The refundable base is the undelivered share of the
 *     plan price. The denominator is every session the plan ever held time for,
 *     which is `slotsTotal` — not completed plus live, because summing only
 *     those drops every terminal-but-not-completed session out of the plan and
 *     the quote then promises more than the cancel pays (#1174). A plan with
 *     `slotsTotal === 0` keeps the full gross: that is the never-scheduled
 *     booking the notice step already tiers at 100%.
 *   - Clamp. To the remaining refundable balance, not the gross. Against a
 *     payment carrying an earlier partial refund the gross overshoots, the
 *     refund operation rejects the whole request with AMOUNT_EXCEEDS_REFUNDABLE,
 *     and the buyer loses the remainder they were owed.
 */
export function quoteBookingRefund(
  input: BookingRefundQuoteInput,
): BookingRefundQuote {
  const neverScheduled = input.slotsTotal === 0;
  const noticeHours = neverScheduled
    ? Number.POSITIVE_INFINITY
    : (input.hoursUntilNextSession ?? -1);

  const refundPct = computeRefundPct(
    input.policy,
    noticeHours,
    input.isConsultantInitiated,
  );

  // #1500 — the credits rail cannot pay a fraction (refundBookingPayment refuses an
  // amountPaise on a free_ intent), so a PARTIAL tier on a fully-credit-funded
  // booking restores the credit IN FULL instead of escalating. A zero tier still
  // returns nothing — that is the policy, not a rounding, so a late cancel bites a
  // credit buyer exactly as it bites a card buyer.
  const creditRestoresInFull = input.isFreeCreditFunded && refundPct > 0;
  const effectivePct = creditRestoresInFull ? 100 : refundPct;

  const isProratable = input.isSubscription && input.slotsTotal > 0;
  // Integer paise in BigInt: the products can leave the safe-integer range
  // long before the amounts stop being real money (repo rule for lib/payments).
  const proratedBasePaise = isProratable
    ? Number(
        (BigInt(input.grossPaise) * BigInt(input.sessionsRemaining)) /
          BigInt(input.slotsTotal),
      )
    : input.grossPaise;
  // refundPct may carry two decimals; scale by 100 so the division is exact.
  const refundBeforeClamp = Number(
    (BigInt(proratedBasePaise) * BigInt(Math.round(effectivePct * 100))) /
      BigInt(10_000),
  );

  return {
    refundPct: effectivePct,
    tierRefundPct: refundPct,
    noticeHours,
    proratedBasePaise,
    prorated: isProratable && input.sessionsRemaining < input.slotsTotal,
    refundPaise: Math.min(refundBeforeClamp, input.refundablePaise),
    creditRestoresInFull,
  };
}
