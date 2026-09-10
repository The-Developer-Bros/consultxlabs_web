/**
 * @jest-environment node
 */

/**
 * PaymentLeg sum invariant tests.
 *
 * Covers the two helpers added in the close-bundle commit:
 *   - checkPaymentLegsSumToAmount — log-only soft check for the hot
 *     checkout path; returns a mismatch payload rather than throwing.
 *   - assertPaymentLegsSumToAmount — hard-throwing sibling for tests +
 *     reconciliation jobs.
 *
 * The invariant: `sum(non-reversal, non-REFERRAL_CREDIT legs.amountPaise)
 * === Payment.amount`. LICENSE legs intentionally carry zero amount (cost
 * absorbed at contract time) and are still part of the sum. REFERRAL_CREDIT
 * legs are not: `Payment.amount` is the gateway charge and the credit has
 * already been netted out of it, so a credit-funded checkout has its CARD leg
 * alone equal to `Payment.amount` (#1347).
 */

import {
  checkPaymentLegsSumToAmount,
  assertPaymentLegsSumToAmount,
} from "@/lib/payments/payment-legs";

describe("checkPaymentLegsSumToAmount", () => {
  it("returns null when a single CARD leg matches the amount", () => {
    expect(
      checkPaymentLegsSumToAmount({
        paymentAmountPaise: 150000,
        legs: [{ source: "CARD", amountPaise: 150000 }],
      }),
    ).toBeNull();
  });

  it("returns null when a WALLET leg equals the full amount (org-sponsored, no gateway)", () => {
    expect(
      checkPaymentLegsSumToAmount({
        paymentAmountPaise: 50000,
        legs: [{ source: "WALLET", amountPaise: 50000 }],
      }),
    ).toBeNull();
  });

  it("returns null for a LICENSE leg at zero amount on a zero-amount Payment", () => {
    // LICENSE flows: cost is sunk at contract time, Payment.amount = 0,
    // leg.amountPaise = 0. The invariant still holds (0 === 0).
    expect(
      checkPaymentLegsSumToAmount({
        paymentAmountPaise: 0,
        legs: [{ source: "LICENSE", amountPaise: 0 }],
      }),
    ).toBeNull();
  });

  it("returns null when the CARD leg alone matches a credit-funded Payment.amount", () => {
    // #1347 — gateway charged 100 paise, credits covered 50, so
    // Payment.amount is the post-credit 100. The REFERRAL_CREDIT leg records
    // the platform's 50 but is excluded from the funding sum.
    expect(
      checkPaymentLegsSumToAmount({
        paymentAmountPaise: 100,
        legs: [
          { source: "CARD", amountPaise: 100 },
          { source: "REFERRAL_CREDIT", amountPaise: 50 },
        ],
      }),
    ).toBeNull();
  });

  it("still reports drift when a REFERRAL_CREDIT leg sits beside a CARD leg that misses the amount", () => {
    // Excluding the credit must not blind the check to the funding it does
    // cover: the card is short by 20 and that is real drift.
    const mismatch = checkPaymentLegsSumToAmount({
      paymentAmountPaise: 100,
      legs: [
        { source: "CARD", amountPaise: 80 },
        { source: "REFERRAL_CREDIT", amountPaise: 50 },
      ],
    });
    expect(mismatch).not.toBeNull();
    expect(mismatch?.reason).toBe("FUNDING_SUM_DRIFT");
    expect(mismatch?.legSumPaise).toBe(80);
    expect(mismatch?.deltaPaise).toBe(-20);
  });

  it("returns a mismatch payload when legs sum is less than the amount", () => {
    const mismatch = checkPaymentLegsSumToAmount({
      paymentAmountPaise: 100,
      legs: [{ source: "CARD", amountPaise: 60 }],
    });
    expect(mismatch).not.toBeNull();
    expect(mismatch?.paymentAmountPaise).toBe(100);
    expect(mismatch?.legSumPaise).toBe(60);
    expect(mismatch?.deltaPaise).toBe(-40); // signed: sum - amount
  });

  it("returns a mismatch payload when legs sum exceeds the amount", () => {
    const mismatch = checkPaymentLegsSumToAmount({
      paymentAmountPaise: 100,
      legs: [
        { source: "CARD", amountPaise: 80 },
        { source: "WALLET", amountPaise: 40 },
      ],
    });
    expect(mismatch?.deltaPaise).toBe(20);
    expect(mismatch?.legs).toHaveLength(2);
  });

  it("treats an empty leg array as sum = 0 (mismatch if amount != 0)", () => {
    const mismatch = checkPaymentLegsSumToAmount({
      paymentAmountPaise: 500,
      legs: [],
    });
    expect(mismatch?.legSumPaise).toBe(0);
    expect(mismatch?.deltaPaise).toBe(-500);
  });

  it("allows negative leg amounts (refund adjustments)", () => {
    // Refund ledger writes a negative leg without deleting the original
    // positive leg; the check must net them signed, not via abs().
    expect(
      checkPaymentLegsSumToAmount({
        paymentAmountPaise: 0,
        legs: [
          { source: "CARD", amountPaise: 100 },
          { source: "CARD", amountPaise: -100 },
        ],
      }),
    ).toBeNull();
  });
});

describe("assertPaymentLegsSumToAmount", () => {
  it("does not throw on a matching sum", () => {
    expect(() =>
      assertPaymentLegsSumToAmount({
        paymentAmountPaise: 100,
        legs: [{ source: "CARD", amountPaise: 100 }],
      }),
    ).not.toThrow();
  });

  it("throws with a descriptive message on mismatch", () => {
    expect(() =>
      assertPaymentLegsSumToAmount({
        paymentAmountPaise: 100,
        legs: [{ source: "CARD", amountPaise: 50 }],
      }),
    ).toThrow(/PaymentLeg sum invariant violated/);
  });

  it("error message includes the delta for ops visibility", () => {
    try {
      assertPaymentLegsSumToAmount({
        paymentAmountPaise: 100,
        legs: [{ source: "WALLET", amountPaise: 60 }],
      });
      throw new Error("expected assertion to throw");
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      expect(err.message).toContain("delta -40");
    }
  });
});

/**
 * E2E-audit fix — zero-value LICENSE legs are exempt from the sum test.
 *
 * A LICENSE-funded booking is absorbed at the contract level: the funding leg
 * is deliberately ₹0 while `Payment.amount` stays at the full list price, so
 * `Σlegs === amount` is structurally false for EVERY one of them. Before the
 * exemption, each license booking emitted a mismatch warning at checkout and a
 * guaranteed `PAYMENT_LEG_SUM_MISMATCH` finding on the nightly reconcile —
 * by-design noise that buried the real WALLET / INVOICE drift the check exists
 * to surface.
 *
 * The exemption is narrow on purpose: it applies only when the original legs
 * are ENTIRELY zero-value LICENSE legs. A license leg that carries money, or
 * sits next to any other funding source, is checked normally.
 */
describe("checkPaymentLegsSumToAmount — zero-value LICENSE exemption", () => {
  it("exempts a zero LICENSE leg against a full-price Payment", () => {
    expect(
      checkPaymentLegsSumToAmount({
        paymentAmountPaise: 500000,
        legs: [{ source: "LICENSE", amountPaise: 0 }],
      }),
    ).toBeNull();
  });

  it("does NOT exempt a license booking that also accrued an overage charge", () => {
    // A LICENSED_SEAT program past its cap on the CHARGE_ORG path carries a
    // real OVERAGE_INVOICE_ACCRUAL leg beside the zero LICENSE leg. That
    // money must reconcile against Payment.amount like any other accrual —
    // the exemption is for the wholly-absorbed case only.
    const mismatch = checkPaymentLegsSumToAmount({
      paymentAmountPaise: 500000,
      legs: [
        { source: "LICENSE", amountPaise: 0 },
        { source: "OVERAGE_INVOICE_ACCRUAL", amountPaise: 250000 },
      ],
    });
    expect(mismatch).not.toBeNull();
    expect(mismatch!.legSumPaise).toBe(250000);
  });

  it("rejects a zero accrual reversal on a license booking", () => {
    // #1347 — zero is rejected on BOTH sides: the checker and
    // `assert_payment_legs_ok` agree a reversal must be strictly negative, so
    // a zero one is an orphan counter-entry rather than a benign no-op. The
    // sum carve still suppresses the sum comparison; it never reaches here.
    const mismatch = checkPaymentLegsSumToAmount({
      paymentAmountPaise: 500000,
      legs: [
        { source: "LICENSE", amountPaise: 0 },
        { source: "INVOICE_ACCRUAL_REVERSAL", amountPaise: 0 },
      ],
    });
    expect(mismatch?.reason).toBe("REVERSAL_PAIR_VIOLATION");
  });

  it("does NOT exempt a LICENSE leg that carries a non-zero amount", () => {
    // Money on a license leg is real drift, not the by-design zero case.
    const mismatch = checkPaymentLegsSumToAmount({
      paymentAmountPaise: 500000,
      legs: [{ source: "LICENSE", amountPaise: 100000 }],
    });
    expect(mismatch).not.toBeNull();
    expect(mismatch!.legSumPaise).toBe(100000);
  });

  it("does NOT exempt when a zero LICENSE leg sits beside another funding source", () => {
    // A WALLET leg that under-covers the amount is exactly the drift this
    // check exists for; the neighbouring zero LICENSE leg must not mask it.
    const mismatch = checkPaymentLegsSumToAmount({
      paymentAmountPaise: 500000,
      legs: [
        { source: "LICENSE", amountPaise: 0 },
        { source: "WALLET", amountPaise: 400000 },
      ],
    });
    expect(mismatch).not.toBeNull();
    expect(mismatch!.legSumPaise).toBe(400000);
  });

  it("keeps reporting a leg-less Payment as a mismatch", () => {
    // The exemption requires at least one original leg — "no legs at all" is
    // still a real failure to journal the money.
    const mismatch = checkPaymentLegsSumToAmount({
      paymentAmountPaise: 500000,
      legs: [],
    });
    expect(mismatch).not.toBeNull();
    expect(mismatch!.legSumPaise).toBe(0);
  });
});

/**
 * #786 — partial-refund reversal pairs.
 *
 * A refund appends a negative `*_REVERSAL` sibling rather than mutating the
 * original leg, so the originals keep summing to `Payment.amount` and the
 * reversal is judged against its own pair: it must be negative and must never
 * exceed the originals it reverses. `assert_payment_legs_ok` enforces the same
 * two rules in the database, including on a licence-only payment, so the
 * checker has to reach them there too — otherwise a leg the checker waved
 * through would still be rejected at COMMIT (#1347).
 */
describe("checkPaymentLegsSumToAmount — reversal pairs", () => {
  it("accepts a partial reversal that stays inside its original sibling", () => {
    expect(
      checkPaymentLegsSumToAmount({
        paymentAmountPaise: 500000,
        legs: [
          { source: "INVOICE_ACCRUAL", amountPaise: 500000 },
          { source: "INVOICE_ACCRUAL_REVERSAL", amountPaise: -200000 },
        ],
      }),
    ).toBeNull();
  });

  it("rejects a partial reversal larger than the accrual it reverses", () => {
    const mismatch = checkPaymentLegsSumToAmount({
      paymentAmountPaise: 500000,
      legs: [
        { source: "INVOICE_ACCRUAL", amountPaise: 500000 },
        { source: "INVOICE_ACCRUAL_REVERSAL", amountPaise: -600000 },
      ],
    });
    expect(mismatch?.reason).toBe("REVERSAL_PAIR_VIOLATION");
  });

  it("rejects a positive reversal leg", () => {
    // A reversal is a counter-entry; a positive one would credit the org twice.
    const mismatch = checkPaymentLegsSumToAmount({
      paymentAmountPaise: 500000,
      legs: [
        { source: "INVOICE_ACCRUAL", amountPaise: 500000 },
        { source: "INVOICE_ACCRUAL_REVERSAL", amountPaise: 200000 },
      ],
    });
    expect(mismatch?.reason).toBe("REVERSAL_PAIR_VIOLATION");
  });

  it("still checks the pair on a licence-only payment the sum carve exempts", () => {
    // The zero-LICENSE carve skips the SUM comparison only. A reversal with no
    // original sibling is corrupt whichever way the sum is read, and the
    // trigger raises on it, so the checker must agree rather than return early.
    const mismatch = checkPaymentLegsSumToAmount({
      paymentAmountPaise: 500000,
      legs: [
        { source: "LICENSE", amountPaise: 0 },
        { source: "INVOICE_ACCRUAL_REVERSAL", amountPaise: -200000 },
      ],
    });
    expect(mismatch?.reason).toBe("REVERSAL_PAIR_VIOLATION");
  });
});
