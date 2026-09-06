/**
 * Locale lookup for currency formatting.
 * Uses the most natural locale for each currency so numbers are grouped
 * correctly (e.g., ₹1,00,000 for INR vs $100,000 for USD).
 * Falls back to "en-IN" for unlisted currencies since 90%+ of our
 * users are Indian — Intl handles the currency symbol regardless of locale.
 */
export const CURRENCY_LOCALE_MAP: Record<string, string> = {
  INR: "en-IN",
  USD: "en-US",
  EUR: "de-DE",
  GBP: "en-GB",
  AUD: "en-AU",
  CAD: "en-CA",
  SGD: "en-SG",
  AED: "ar-AE",
  JPY: "ja-JP",
  BRL: "pt-BR",
  CNY: "zh-CN",
  KRW: "ko-KR",
};

/**
 * ISO 4217 zero-decimal currencies.
 * These currencies have no fractional subunits — the stored amount IS
 * the major unit (e.g., ¥100 is stored as 100, not 10000).
 * Stripe and Razorpay follow this convention.
 *
 * @see https://docs.stripe.com/currencies#zero-decimal
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

/**
 * ISO 4217 three-decimal currencies.
 * These currencies have 1000 subunits per major unit
 * (e.g., 1 KWD = 1000 fils, stored as 1000).
 * @see https://en.wikipedia.org/wiki/ISO_4217#Active_codes_(List_One)
 */
const THREE_DECIMAL_CURRENCIES = new Set([
  "BHD", // Bahraini dinar
  "IQD", // Iraqi dinar
  "JOD", // Jordanian dinar
  "KWD", // Kuwaiti dinar
  "LYD", // Libyan dinar
  "OMR", // Omani rial
  "TND", // Tunisian dinar
]);

/**
 * Get the divisor to convert from smallest currency unit to major unit.
 * Most currencies: 100 (cents → dollars, paise → rupees)
 * Zero-decimal:    1   (yen is yen)
 * Three-decimal:   1000 (fils → dinars)
 */
function getCurrencyDivisor(currency: string): number {
  const upper = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(upper)) return 1;
  if (THREE_DECIMAL_CURRENCIES.has(upper)) return 1000;
  return 100;
}

/**
 * Format an amount stored in the smallest currency unit for display.
 * Automatically handles currency-specific subunit conversion using
 * ISO 4217 decimal rules (zero-decimal, two-decimal, three-decimal).
 *
 * @param amountInSmallestUnit - Amount in smallest unit (e.g., 50000 paise = ₹500.00, 1000 cents = $10.00, 500 yen = ¥500)
 * @param currency             - ISO 4217 currency code (required)
 *
 * @example
 * formatCurrencyAmount(50000, "INR") // "₹500.00"
 * formatCurrencyAmount(1000, "USD")  // "$10.00"
 * formatCurrencyAmount(500, "JPY")   // "¥500"
 * formatCurrencyAmount(1500, "KWD")  // "KD 1.500"
 */
export function formatCurrencyAmount(
  amountInSmallestUnit: number,
  currency: string,
): string {
  const { format, divisor } = currencyFormatter(currency);
  return format.format(amountInSmallestUnit / divisor);
}

/** The one place the subunit and locale rules for a currency are resolved. */
function currencyFormatter(currency: string): {
  format: Intl.NumberFormat;
  divisor: number;
} {
  const upper = currency.toUpperCase();
  const locale = CURRENCY_LOCALE_MAP[upper] || "en-IN";
  const fractionDigits = ZERO_DECIMAL_CURRENCIES.has(upper)
    ? 0
    : THREE_DECIMAL_CURRENCIES.has(upper)
      ? 3
      : 2;

  return {
    format: new Intl.NumberFormat(locale, {
      style: "currency",
      currency: upper,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }),
    divisor: getCurrencyDivisor(upper),
  };
}

/**
 * The same figure as `formatCurrencyAmount` with the symbol or code removed:
 * `55,679.48` rather than `₹55,679.48`.
 *
 * For surfaces that already print the currency themselves and would otherwise
 * say it twice — four Novu templates render `{{currency}} {{amount}}` and
 * cannot be edited today (#536). Built by dropping the currency part from the
 * currency formatter's own output rather than by configuring a second
 * formatter, so the grouping, locale and subunit rules cannot drift from the
 * symbol-bearing version.
 *
 * @example
 * formatCurrencyAmountBare(5567948, "INR") // "55,679.48"
 * formatCurrencyAmountBare(1500, "KWD")    // "1.500"
 */
export function formatCurrencyAmountBare(
  amountInSmallestUnit: number,
  currency: string,
): string {
  const { format, divisor } = currencyFormatter(currency);
  return format
    .formatToParts(amountInSmallestUnit / divisor)
    .filter((part) => part.type !== "currency")
    .map((part) => part.value)
    .join("")
    .trim();
}

// #1396 — a deprecated major-unit formatter lived here, taking rupees rather
// than paise. Every money column in this schema is in the smallest unit, so it
// had no correct caller left and each accidental one displayed a figure a
// hundred times too large. Deleted rather than left deprecated; use
// `formatCurrencyAmount` above, which is the paise-taking formatter, and
// convert at the boundary if raw user input in major units ever appears.

/**
 * Extract initials from a person's name.
 * Single-word names return the first two characters; multi-word names
 * return the first character of the first and last words.
 *
 * @example
 * getInitials("John Doe")   // "JD"
 * getInitials("Alice")      // "AL"
 * getInitials("")           // "?"
 */
export function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Format an ISO date string as a short, human-readable ETA.
 * Used in maintenance banners and the maintenance page.
 *
 * @param isoString - ISO 8601 date string (e.g., "2026-02-27T14:00:00Z")
 * @returns Formatted string like "Feb 27, 2:00 PM" or the raw string on parse failure
 */
export function formatEta(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return isoString;
  }
}
