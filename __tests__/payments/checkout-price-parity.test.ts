/**
 * @jest-environment node
 */

/**
 * #1167 — the price the buyer reads and the price the server charges.
 *
 * The checkout pages compute their own breakdown with `app/checkout/plans/math`
 * and render it; `/api/checkout` computes the amount it actually mints an order
 * for, independently. Nothing had ever compared the two, so any drift between
 * them showed up as a buyer being charged something other than what the page
 * said.
 *
 * #1319 — this suite used to transcribe the server's order of operations,
 * because the derivation lived inside `createCheckoutSession`'s Prisma
 * transaction and could not be imported without standing up prisma, razorpay
 * and stripe. It no longer does. `deriveCheckoutAmount` is the real function
 * `calculateAmountAndValidate` calls, extracted whole into
 * `lib/payments/pricing/derive-checkout-amount.ts`, and it is what this file
 * imports. A change to the server's sequencing, its rounding, its discount cap
 * or its credit floor now fails here directly rather than passing against a
 * copy that nobody remembered to update.
 */

import { calculatePricing } from "@/app/checkout/plans/math";
import { deriveCheckoutAmount } from "@/lib/payments/pricing/derive-checkout-amount";
import { hasValidPlatformLut } from "@/lib/compliance/lut";
import { MIN_CREDIT_REDEMPTION_PAISE } from "@/lib/referrals/constants";

// The LUT gate is env-driven; these tests pin the NO-LUT default (fail-closed
// ⇒ international supplies are charged 18% on both sides). A dedicated
// lut-gate suite covers the zero-rated branch.
delete process.env.PLATFORM_LUT_NUMBER;
delete process.env.PLATFORM_LUT_VALID_TILL;

type ServerInputs = {
  /** Plan price in paise. */
  basePaise: number;
  buyerCountry: string;
  discount?:
    | { type: "PERCENTAGE"; value: number; maxDiscount?: number | null }
    | { type: "FIXED_AMOUNT"; value: number };
  creditsAvailablePaise?: number;
};

type Amounts = {
  taxPaise: number;
  creditsPaise: number;
  totalPaise: number;
  discountPaise: number;
};

/**
 * The server's real derivation, called exactly as `calculateAmountAndValidate`
 * calls it: the discount record it passes has already been re-validated
 * against the database, and the credit balance arrives through the same lazy
 * resolver the transaction uses.
 */
async function serverAmount(input: ServerInputs): Promise<Amounts> {
  const derived = await deriveCheckoutAmount({
    basePaise: input.basePaise,
    buyerCountry: input.buyerCountry,
    serviceType: "CONSULTING",
    discount: input.discount
      ? {
          discountType: input.discount.type,
          discountValue: input.discount.value,
          maxDiscount:
            input.discount.type === "PERCENTAGE"
              ? (input.discount.maxDiscount ?? null)
              : null,
        }
      : null,
    useReferralCredits: true,
    resolveAvailableCreditsPaise: () => input.creditsAvailablePaise ?? 0,
  });
  return {
    taxPaise: derived.taxAmount,
    creditsPaise: derived.creditsApplied,
    totalPaise: derived.amount,
    discountPaise: derived.discountPaise,
  };
}

/** The same booking as the checkout page computes it. */
function clientAmount(input: ServerInputs): Amounts {
  // #1230 — the client keys zero-rating off the server-decided
  // `exportZeroRated` flag (platform LUT state), which the parity harness
  // mirrors from the same env the real checkout context reads.
  const exportZeroRated = input.buyerCountry !== "IN" && hasValidPlatformLut();
  const breakdown = calculatePricing(input.basePaise, {
    isInternational: input.buyerCountry !== "IN",
    exportZeroRated,
    discountPercent:
      input.discount?.type === "PERCENTAGE" && !input.discount.maxDiscount
        ? input.discount.value / 100
        : 0,
    // The pages prefer the API's pre-computed `discountAmount` whenever the
    // validate endpoint returns one, which is how a capped percentage arrives.
    discountAmount:
      input.discount?.type === "FIXED_AMOUNT"
        ? input.discount.value
        : input.discount?.type === "PERCENTAGE" && input.discount.maxDiscount
          ? Math.min(
              Math.round((input.basePaise * input.discount.value) / 100),
              input.discount.maxDiscount,
            )
          : undefined,
    creditsApplied: input.creditsAvailablePaise ?? 0,
  });
  return {
    taxPaise: breakdown.taxAmount,
    creditsPaise: breakdown.creditsApplied,
    totalPaise: breakdown.total,
    discountPaise: breakdown.discountAmount,
  };
}

/**
 * One paise. The two sides round differently by construction — the client keeps
 * two decimal places of a paise value (`Math.round(x * 100) / 100`) while the
 * server rounds to whole paise — so equality is the wrong assertion and a
 * tolerance wider than a paise would hide a real divergence.
 */
const ONE_PAISE = 1;

const FIXTURES: Array<{ name: string; input: ServerInputs }> = [
  {
    name: "base price, domestic",
    input: { basePaise: 500000, buyerCountry: "IN" },
  },
  {
    name: "base price with a fractional GST result",
    input: { basePaise: 123457, buyerCountry: "IN" },
  },
  {
    name: "base price, international without LUT (fail-closed IGST)",
    input: { basePaise: 500000, buyerCountry: "US" },
  },
  {
    name: "percentage discount, domestic",
    input: {
      basePaise: 500000,
      buyerCountry: "IN",
      discount: { type: "PERCENTAGE", value: 15 },
    },
  },
  {
    name: "percentage discount hitting its maxDiscount cap",
    input: {
      basePaise: 500000,
      buyerCountry: "IN",
      discount: { type: "PERCENTAGE", value: 50, maxDiscount: 100000 },
    },
  },
  {
    name: "fixed-amount discount, domestic",
    input: {
      basePaise: 500000,
      buyerCountry: "IN",
      discount: { type: "FIXED_AMOUNT", value: 75000 },
    },
  },
  {
    name: "fixed-amount discount larger than the price",
    input: {
      basePaise: 40000,
      buyerCountry: "IN",
      discount: { type: "FIXED_AMOUNT", value: 90000 },
    },
  },
  {
    name: "credits applied above the redemption floor",
    input: {
      basePaise: 500000,
      buyerCountry: "IN",
      creditsAvailablePaise: 100000,
    },
  },
  {
    name: "credits covering the whole tax-inclusive total",
    input: {
      basePaise: 500000,
      buyerCountry: "IN",
      creditsAvailablePaise: 10000000,
    },
  },
  {
    name: "discount and credits together",
    input: {
      basePaise: 800000,
      buyerCountry: "IN",
      discount: { type: "PERCENTAGE", value: 10 },
      creditsAvailablePaise: 150000,
    },
  },
  // #1319 — the international arm gets the same coverage as the domestic one.
  // Every one of these runs fail-closed (no platform LUT in this environment),
  // so the buyer is charged 18% IGST and the two sides must agree on it.
  {
    name: "international, percentage discount",
    input: {
      basePaise: 500000,
      buyerCountry: "US",
      discount: { type: "PERCENTAGE", value: 15 },
    },
  },
  {
    name: "international, capped percentage discount",
    input: {
      basePaise: 900000,
      buyerCountry: "GB",
      discount: { type: "PERCENTAGE", value: 40, maxDiscount: 120000 },
    },
  },
  {
    name: "international, fixed-amount discount",
    input: {
      basePaise: 640000,
      buyerCountry: "AE",
      discount: { type: "FIXED_AMOUNT", value: 99999 },
    },
  },
  {
    name: "international, credits above the redemption floor",
    input: {
      basePaise: 700000,
      buyerCountry: "SG",
      creditsAvailablePaise: 250000,
    },
  },
  {
    name: "international, discount and credits together",
    input: {
      basePaise: 850000,
      buyerCountry: "DE",
      discount: { type: "PERCENTAGE", value: 20 },
      creditsAvailablePaise: 175000,
    },
  },
  {
    name: "international, base that taxes to a fraction of a paise",
    input: { basePaise: 123457, buyerCountry: "CA" },
  },
];

describe("checkout price parity — page math vs server derivation", () => {
  it.each(FIXTURES)("$name: totals agree", async ({ input }) => {
    const client = clientAmount(input);
    const server = await serverAmount(input);
    expect(Math.abs(client.totalPaise - server.totalPaise)).toBeLessThanOrEqual(
      ONE_PAISE,
    );
  });

  it.each(FIXTURES)("$name: tax agrees", async ({ input }) => {
    const client = clientAmount(input);
    const server = await serverAmount(input);
    expect(Math.abs(client.taxPaise - server.taxPaise)).toBeLessThanOrEqual(
      ONE_PAISE,
    );
  });

  it.each(FIXTURES)("$name: the discount taken agrees", async ({ input }) => {
    const client = clientAmount(input);
    const server = await serverAmount(input);
    expect(
      Math.abs(client.discountPaise - server.discountPaise),
    ).toBeLessThanOrEqual(ONE_PAISE);
  });

  it.each(FIXTURES)("$name: credits applied agree", async ({ input }) => {
    const client = clientAmount(input);
    const server = await serverAmount(input);
    expect(
      Math.abs(client.creditsPaise - server.creditsPaise),
    ).toBeLessThanOrEqual(ONE_PAISE);
  });
});

describe("checkout price parity — the edges that actually move money", () => {
  it("zero-rates an international buyer on both sides (valid platform LUT)", async () => {
    // #1230 — zero-rating now requires a current-FY LUT; this pin covers the
    // WITH-LUT half of the gate (the no-LUT half is the fail-closed default
    // asserted by the international fixtures above). Clock frozen inside the
    // fixture window (CR #1234).
    process.env.PLATFORM_LUT_NUMBER = "LUT/2627";
    process.env.PLATFORM_LUT_VALID_TILL = "2027-03-31";
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2027-03-31T12:00:00Z"));
    const input: ServerInputs = { basePaise: 500000, buyerCountry: "DE" };
    expect((await serverAmount(input)).taxPaise).toBe(0);
    expect(clientAmount(input).taxPaise).toBe(0);
    jest.useRealTimers();
    delete process.env.PLATFORM_LUT_NUMBER;
    delete process.env.PLATFORM_LUT_VALID_TILL;
  });

  it("charges 18% GST on the DISCOUNTED base, not the list price", async () => {
    const input: ServerInputs = {
      basePaise: 100000,
      buyerCountry: "IN",
      discount: { type: "FIXED_AMOUNT", value: 20000 },
    };
    // 18% of ₹800, not of ₹1000.
    expect((await serverAmount(input)).taxPaise).toBe(14400);
    expect(clientAmount(input).taxPaise).toBe(14400);
  });

  it("charges 18% IGST on the DISCOUNTED base for a fail-closed export", async () => {
    // #1230 — an export without a LUT is taxable, and the tax base is still the
    // discounted price. This is the international mirror of the case above.
    const input: ServerInputs = {
      basePaise: 100000,
      buyerCountry: "US",
      discount: { type: "FIXED_AMOUNT", value: 20000 },
    };
    expect((await serverAmount(input)).taxPaise).toBe(14400);
    expect(clientAmount(input).taxPaise).toBe(14400);
  });

  it("never lets a discount drive the total below zero", async () => {
    const input: ServerInputs = {
      basePaise: 40000,
      buyerCountry: "IN",
      discount: { type: "FIXED_AMOUNT", value: 90000 },
    };
    expect((await serverAmount(input)).totalPaise).toBe(0);
    expect(clientAmount(input).totalPaise).toBe(0);
  });

  it("never applies more credit than the total owed", async () => {
    const input: ServerInputs = {
      basePaise: 500000,
      buyerCountry: "IN",
      creditsAvailablePaise: 99_999_999,
    };
    expect((await serverAmount(input)).totalPaise).toBe(0);
    expect(clientAmount(input).totalPaise).toBe(0);
  });

  it("leaves the earnings base at the list price, not the charged price", async () => {
    // Discounts and credits are platform-funded; the consultant accrues on the
    // plan's list price, so the derivation has to keep that number distinct.
    const derived = await deriveCheckoutAmount({
      basePaise: 500000,
      buyerCountry: "IN",
      discount: { discountType: "PERCENTAGE", discountValue: 10 },
      useReferralCredits: true,
      resolveAvailableCreditsPaise: () => 100000,
    });
    expect(derived.originalAmount).toBe(500000);
    expect(derived.discountPaise).toBe(50000);
    expect(derived.discountedAmount).toBe(450000);
    expect(derived.taxAmount).toBe(81000);
    expect(derived.taxedAmount).toBe(531000);
    expect(derived.creditsApplied).toBe(100000);
    expect(derived.amount).toBe(431000);
  });

  it("never reads the credit balance for an order under the floor", async () => {
    // The lazy resolver is what keeps the balance out of the checkout
    // transaction's read set when the order could not spend a credit anyway.
    const resolve = jest.fn(() => 20000);
    await deriveCheckoutAmount({
      basePaise: 30000, // ₹300 + 18% = ₹354, below the floor
      buyerCountry: "IN",
      useReferralCredits: true,
      resolveAvailableCreditsPaise: resolve,
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  /**
   * A known, live divergence rather than a wish. `MIN_CREDIT_REDEMPTION_PAISE`
   * is enforced only on the server, so on an order under ₹500 the page shows a
   * credit that the charge will not honour — the one case in this suite where
   * the two sides disagree by more than rounding. Asserted so the gap is
   * recorded and its eventual fix (teaching the pages the floor) turns this
   * test red instead of passing silently.
   */
  it("DIVERGES: the pages ignore the ₹500 credit-redemption floor", async () => {
    const input: ServerInputs = {
      basePaise: 30000, // ₹300 + 18% = ₹354, below the floor
      buyerCountry: "IN",
      creditsAvailablePaise: 20000,
    };
    const server = await serverAmount(input);
    const client = clientAmount(input);

    expect(server.totalPaise).toBeLessThan(MIN_CREDIT_REDEMPTION_PAISE);
    expect(server.creditsPaise).toBe(0);
    expect(client.creditsPaise).toBe(20000);
    expect(client.totalPaise).toBe(server.totalPaise - 20000);
  });

  it("rejects a stored percentage outside 1–100 rather than pricing it", async () => {
    await expect(
      deriveCheckoutAmount({
        basePaise: 500000,
        buyerCountry: "IN",
        discount: { discountType: "PERCENTAGE", discountValue: 150 },
      }),
    ).rejects.toThrow(/between 1 and 100/);
  });
});
