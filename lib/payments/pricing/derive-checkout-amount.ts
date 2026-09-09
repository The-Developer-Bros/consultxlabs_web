/**
 * Checkout amount derivation — the single order of operations.
 *
 * The amount a buyer is charged is the product of four stages applied in a
 * fixed order: the plan's list price, then the discount, then tax on the
 * discounted base, then referral credits against the tax-inclusive total.
 * That sequence used to live inline inside `calculateAmountAndValidate`'s
 * Prisma transaction, which meant nothing outside a live database could
 * observe it and the parity suite had to transcribe it by hand (#1319). It
 * lives here now so the server, and any test that wants to compare the server
 * against what the checkout page renders, read the same code.
 *
 * Everything in this module is a pure function of its arguments. The one
 * concession is `resolveAvailableCreditsPaise`: the caller supplies it and it
 * is invoked only when the order actually clears the redemption floor, which
 * is what keeps the credit balance read out of the transaction's read set on
 * orders that could never spend a credit anyway.
 */

import {
  determineTax,
  type ServiceType,
  type TaxDetermination,
} from "@/lib/payments/tax/tax-engine";
import { MIN_CREDIT_REDEMPTION_PAISE } from "@/lib/referrals/constants";

/** The fields of a validated `DiscountCode` that move the price. */
export interface CheckoutDiscountInput {
  discountType: "PERCENTAGE" | "FIXED_AMOUNT";
  /** Whole percent for PERCENTAGE, paise for FIXED_AMOUNT. */
  discountValue: number;
  /** Paise ceiling on a PERCENTAGE discount; null means uncapped. */
  maxDiscount?: number | null;
}

export interface DeriveCheckoutAmountInput {
  /** Plan list price in paise, before anything is applied to it. */
  basePaise: number;
  /** ISO-3166 alpha-2 of the buyer; decides the tax jurisdiction. */
  buyerCountry: string;
  serviceType?: ServiceType;
  /** Already re-validated against the database by the caller, or null. */
  discount?: CheckoutDiscountInput | null;
  /** Whether the buyer asked to spend referral credits on this order. */
  useReferralCredits?: boolean;
  /**
   * Redeemable credit balance in paise. Called at most once, and only when the
   * tax-inclusive total clears `MIN_CREDIT_REDEMPTION_PAISE`.
   */
  resolveAvailableCreditsPaise?: () => number | Promise<number>;
}

export interface DerivedCheckoutAmount {
  /** List price before discount, tax or credits — the consultant's earnings base. */
  originalAmount: number;
  /** Paise actually taken off the list price. */
  discountPaise: number;
  /** List price minus the discount, the base tax is charged on. */
  discountedAmount: number;
  taxAmount: number;
  taxRate: number;
  isZeroRated: boolean;
  /** Discounted base plus tax — what credits are applied against. */
  taxedAmount: number;
  creditsApplied: number;
  /** What the buyer is charged. */
  amount: number;
  isInternational: boolean;
  tax: TaxDetermination;
}

/**
 * Paise taken off `basePaise` by `discount`.
 *
 * A FIXED_AMOUNT discount never drives the price below zero; a PERCENTAGE one
 * cannot, because the value is constrained to 1–100 below.
 */
export function computeDiscountPaise(
  basePaise: number,
  discount: CheckoutDiscountInput | null | undefined,
): number {
  if (!discount) return 0;

  // A negative value or cap would RAISE the price above the list price.
  if (
    discount.discountValue < 0 ||
    (discount.maxDiscount !== null &&
      discount.maxDiscount !== undefined &&
      discount.maxDiscount < 0)
  ) {
    throw new Error(
      `Invalid discount code: negative value or cap (${discount.discountValue}, ${discount.maxDiscount ?? "no cap"})`,
    );
  }

  if (discount.discountType === "PERCENTAGE") {
    // Data-integrity check on the stored code, not on user input.
    if (discount.discountValue < 1 || discount.discountValue > 100) {
      throw new Error(
        `Invalid discount code: percentage value must be between 1 and 100, got ${discount.discountValue}`,
      );
    }
    // Multiply first: the integer product divides exactly to a half-paise
    // boundary, where `value / 100` as a float can land on either side.
    const raw = Math.round((basePaise * discount.discountValue) / 100);
    const cap = discount.maxDiscount;
    return cap !== null && cap !== undefined && raw > cap ? cap : raw;
  }

  if (discount.discountType === "FIXED_AMOUNT") {
    return Math.min(basePaise, discount.discountValue);
  }

  return 0;
}

/**
 * Whether an order of `taxedAmount` paise may spend referral credits.
 *
 * #880 — credits redeem only at or above the floor, so a credit can never
 * exceed the value of the booking it discounts.
 */
export function isCreditRedemptionEligible(taxedAmount: number): boolean {
  return taxedAmount >= MIN_CREDIT_REDEMPTION_PAISE;
}

/**
 * The full derivation. Async only because the credit balance is resolved by a
 * caller-supplied callback; with a plain number (or nothing) it settles
 * synchronously and reads as the pure calculation it is.
 */
export async function deriveCheckoutAmount(
  input: DeriveCheckoutAmountInput,
): Promise<DerivedCheckoutAmount> {
  const originalAmount = input.basePaise;

  const discountPaise = computeDiscountPaise(originalAmount, input.discount);
  const discountedAmount = originalAmount - discountPaise;

  const isInternational = input.buyerCountry !== "IN";
  const tax = determineTax({
    baseAmountPaise: discountedAmount,
    buyerCountry: input.buyerCountry,
    serviceType: input.serviceType ?? "CONSULTING",
  });
  const taxedAmount = discountedAmount + tax.taxAmount;

  let creditsApplied = 0;
  if (
    input.useReferralCredits === true &&
    isCreditRedemptionEligible(taxedAmount) &&
    input.resolveAvailableCreditsPaise
  ) {
    const totalAvailable = await input.resolveAvailableCreditsPaise();
    if (totalAvailable > 0) {
      creditsApplied = Math.min(totalAvailable, taxedAmount);
    }
  }

  return {
    originalAmount,
    discountPaise,
    discountedAmount,
    taxAmount: tax.taxAmount,
    taxRate: tax.taxRate,
    isZeroRated: tax.isZeroRated,
    taxedAmount,
    creditsApplied,
    amount: taxedAmount - creditsApplied,
    isInternational,
    tax,
  };
}
