/**
 * @jest-environment node
 */

/**
 * B1/#1499 — the refund policy a booking was sold under. The terms live in typed
 * versioned rows now, but the guarantee is the same one the Json snapshot gave: the
 * ladder that governs a booking is the one that was live when it was bought, and a
 * booking with no policy at all is governed by the platform defaults.
 *
 * #1500 — and a booking funded entirely by referral credit restores that credit in
 * full inside any partial tier, because the credits rail cannot pay a fraction. A 0%
 * tier still restores nothing.
 */

import {
  computeRefundPct,
  quoteBookingRefund,
  validateTierLadder,
  MAX_POLICY_TIERS,
  PLATFORM_DEFAULT_TIERS,
  PLATFORM_DEFAULT_TERMS,
  type CancellationPolicyTerms,
} from "@/lib/payments/operations/cancellation-policy";

function terms(
  overrides: Partial<CancellationPolicyTerms> = {},
): CancellationPolicyTerms {
  return { ...PLATFORM_DEFAULT_TERMS, ...overrides };
}

describe("computeRefundPct — platform default tiers", () => {
  it.each([
    [48, 100], // two days out → full refund
    [24, 100], // exactly at the 24h boundary → full refund
    [23.9, 50], // inside a day → half
    [2, 50], // exactly at the 2h boundary → half
    [1.5, 0], // inside two hours → nothing
    [0, 0], // at start time → nothing
  ])("%s hours before start → %s%%", (hours, pct) => {
    expect(computeRefundPct(null, hours, false)).toBe(pct);
  });

  it("refunds nothing after the booking started", () => {
    expect(computeRefundPct(null, -3, false)).toBe(0);
  });

  it("consultant-initiated always refunds 100%, even past start", () => {
    expect(computeRefundPct(null, 1, true)).toBe(100);
    expect(computeRefundPct(null, -3, true)).toBe(100);
  });

  it("a frozen ladder wins over whatever the defaults become later", () => {
    const generous = terms({
      policyId: "policy-1",
      source: "ORG",
      tiers: [{ hoursBefore: 0, refundPct: 100 }],
    });
    // 1 hour before start: platform default says 0, the buyer's frozen terms say
    // 100 — the version the booking cites governs.
    expect(computeRefundPct(generous, 1, false)).toBe(100);
    expect(PLATFORM_DEFAULT_TERMS.tiers).toEqual(PLATFORM_DEFAULT_TIERS);
  });
});

describe("validateTierLadder — the one ladder rule", () => {
  it.each([
    ["the platform ladder", PLATFORM_DEFAULT_TIERS, null],
    ["a single total rung", [{ hoursBefore: 0, refundPct: 50 }], null],
    ["an empty ladder", [], "A policy needs at least one tier"],
    [
      "too many rungs",
      Array.from({ length: MAX_POLICY_TIERS + 1 }, (_, i) => ({
        hoursBefore: MAX_POLICY_TIERS - i,
        refundPct: 0,
      })),
      `A policy may not have more than ${MAX_POLICY_TIERS} tiers`,
    ],
    [
      "a ladder that never reaches zero notice",
      [{ hoursBefore: 2, refundPct: 50 }],
      "The last tier must start at 0 hours so every cancellation is covered",
    ],
    [
      "two rungs at the same notice",
      [
        { hoursBefore: 0, refundPct: 50 },
        { hoursBefore: 0, refundPct: 10 },
      ],
      "Two tiers may not share the same notice period",
    ],
    [
      "a refund above 100%",
      [{ hoursBefore: 0, refundPct: 120 }],
      "Each tier's refund must be between 0 and 100 percent",
    ],
    [
      "three decimal places",
      [{ hoursBefore: 0, refundPct: 12.345 }],
      "A refund percentage may carry at most two decimal places",
    ],
    // #1513 review — `0.07 * 100` is 7.000000000000001 in IEEE 754, so the
    // exact-equality form of this check refused a legal two-decimal rung.
    [
      "two decimal places that float badly",
      [{ hoursBefore: 0, refundPct: 0.07 }],
      null,
    ],
    [
      "three decimal places below one percent",
      [{ hoursBefore: 0, refundPct: 0.075 }],
      "A refund percentage may carry at most two decimal places",
    ],
    [
      "fractional notice hours",
      [{ hoursBefore: 1.5, refundPct: 0 }],
      "Each tier's notice must be a whole number of hours, zero or more",
    ],
  ])("%s", (_label, tiers, expected) => {
    expect(validateTierLadder(tiers)).toBe(expected);
  });
});

describe("quoteBookingRefund — #1500 credit-funded bookings", () => {
  const base = {
    policy: null,
    hoursUntilNextSession: 3,
    slotsTotal: 1,
    sessionsRemaining: 1,
    isSubscription: false,
    isConsultantInitiated: false,
    grossPaise: 0,
    refundablePaise: 0,
  };

  it("restores the credit in full inside a partial tier", () => {
    // Three hours' notice is the 50% rung; a credit cannot be halved, so the whole
    // credit comes back and the quote says 100%.
    const quote = quoteBookingRefund({ ...base, isFreeCreditFunded: true });
    expect(quote.tierRefundPct).toBe(50);
    expect(quote.creditRestoresInFull).toBe(true);
    expect(quote.refundPct).toBe(100);
  });

  it("restores nothing inside the 0% tier", () => {
    const quote = quoteBookingRefund({
      ...base,
      hoursUntilNextSession: 1,
      isFreeCreditFunded: true,
    });
    expect(quote.tierRefundPct).toBe(0);
    expect(quote.creditRestoresInFull).toBe(false);
    expect(quote.refundPct).toBe(0);
  });

  it("leaves a money-funded booking on the tier percentage", () => {
    const quote = quoteBookingRefund({
      ...base,
      isFreeCreditFunded: false,
      grossPaise: 200_000,
      refundablePaise: 200_000,
    });
    expect(quote.creditRestoresInFull).toBe(false);
    expect(quote.refundPct).toBe(50);
    expect(quote.refundPaise).toBe(100_000);
  });
});
