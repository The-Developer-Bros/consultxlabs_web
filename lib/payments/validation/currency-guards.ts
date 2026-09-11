/**
 * Currency Validation Guards
 *
 * Ensures currency consistency across plans, discounts, credits, and payments.
 * All prices are stored in INR paise for MVP. These guards prevent
 * cross-currency mismatches that could cause incorrect charges.
 */
import { Currency, PaymentGateway } from "@prisma/client";
import { PaymentError } from "../core/types";

// #781 §A — money rows store the Currency enum; gateways hand back free-form
// ISO strings. Throwing (rather than defaulting) on an unsupported code
// surfaces a gateway booking a currency we can't represent — callers on
// webhook paths must catch and dead-letter, not 500-loop.
export function toCurrencyEnum(raw: string | null | undefined): Currency {
  if (raw == null) return Currency.INR;
  const up = raw.trim().toUpperCase();
  // #873 — a present-but-blank gateway currency is dead-lettered, not coerced
  // to INR; only null/undefined defaults (webhook refund/dispute write path).
  if (up === "") {
    throw new Error("Unsupported currency code from gateway: <blank>");
  }
  // The Currency enum IS the settlement allowlist — deliberately narrower than
  // the display-FX codes offered by SUPPORTED_CURRENCIES (lib/currency-codes.ts),
  // which the UI can render but the platform cannot settle. A gateway code
  // outside the enum throws so the caller dead-letters it; it must never
  // silently settle.
  if ((Object.values(Currency) as string[]).includes(up)) {
    return up as Currency;
  }
  throw new Error(`Unsupported currency code from gateway: ${raw}`);
}

/**
 * The last gate before a gateway mints an order. Settlement is INR-only by
 * design (ADR 15 + #783: the ledger is INR-denominated), and every amount
 * handed to a gateway is INR paise.
 *
 * #1396 — `createRazorpayOrder` forwarded whatever currency its caller read
 * from the database. `POST /api/organizations` accepted USD/EUR/GBP into
 * `BillingAccount.currency`, so a wallet top-up of 100000 paise (₹1,000) went
 * out as `{ amount: 100000, currency: "USD" }` — which Razorpay reads as
 * $1,000.00, because non-INR amounts are denominated in the target currency's
 * own subunit. The audit row still said ₹1,000 and the capture webhook credited
 * INR paise into the INR ledger. Throwing here makes that a 500 on a misconfigured
 * account instead of a 100x charge on a real card.
 *
 * `toCurrencyEnum` normalises first, so a code we cannot even represent fails
 * the same way as a representable-but-unsettleable one: both are non-INR
 * settlement attempts and both must stop at this boundary.
 *
 * Returns the canonical `Currency.INR` so callers forward the normalised
 * code to the gateway instead of the raw (possibly padded/lowercased) input.
 */
export function assertInrSettlement(
  currency: string,
  operation: string,
  gateway?: PaymentGateway,
): Currency {
  let normalized: Currency | null = null;
  try {
    normalized = toCurrencyEnum(currency);
  } catch {
    normalized = null;
  }
  if (normalized !== Currency.INR) {
    throw new PaymentError(
      `Cannot ${operation} in ${currency}: settlement is INR-only by design (ADR 15). ` +
        "Every stored amount is INR paise and the ledger is INR-denominated, so a " +
        "non-INR order would be charged in the target currency's subunit while the " +
        "platform recorded rupees.",
      "NON_INR_SETTLEMENT",
      gateway,
    );
  }
  return normalized;
}

/**
 * Validate that a plan's price currency matches the expected charge currency.
 * For MVP: all plans must be INR.
 *
 * @throws Error if currency doesn't match
 */
export function validatePlanCurrency(
  priceCurrency: string,
  expected: string = "INR",
): void {
  if (priceCurrency !== expected) {
    throw new Error(
      `Plan currency mismatch: expected ${expected}, got ${priceCurrency}. ` +
        `Multi-currency pricing is not yet supported.`,
    );
  }
}

/**
 * Validate that a FIXED_AMOUNT discount is in the correct currency.
 * Percentage discounts are currency-agnostic and always pass.
 *
 * @returns true if valid, false if mismatch
 */
export function validateDiscountCurrency(
  discount: {
    discountType: string;
    currency?: string;
  },
  planCurrency: string,
): boolean {
  // Percentage discounts are currency-agnostic
  if (discount.discountType === "PERCENTAGE") return true;

  // FIXED_AMOUNT must match plan currency
  const discountCurrency = discount.currency || "INR";
  return discountCurrency === planCurrency;
}

/**
 * Validate that referral credits can be applied to a payment.
 * Credits must be in the same currency as the payment.
 */
export function validateCreditCurrency(
  creditCurrency: string,
  paymentCurrency: string,
): boolean {
  return creditCurrency === paymentCurrency;
}
