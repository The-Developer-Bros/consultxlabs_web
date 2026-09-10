/**
 * The display-currency allowlist, in a module with no React dependency so both
 * the client hook (`hooks/useCurrency.ts`) and the server-side checkout schema
 * (`schemas/checkout.ts`) can share one list.
 *
 * These are DISPLAY currencies only. Settlement is INR-only by design (ADR 15):
 * every stored amount is INR paise, the ledger is INR-denominated, and
 * `assertInrSettlement` refuses anything else at the gateway boundary. A code
 * appearing here means the navbar can render a price estimate in it, never that
 * the platform can charge in it.
 *
 * #1396 — `displayCurrency` on the checkout body used to be any three-letter
 * string taken from localStorage, and `Intl.NumberFormat` happily renders a
 * made-up code ("XYZ 1,234.50"), so arbitrary values persisted into
 * `Payment.displayCurrencyAtCheckout`. Keeping the list in one place is what
 * lets the schema reject them without the two definitions drifting apart.
 */

export const SUPPORTED_CURRENCY_CODES = [
  "INR",
  "USD",
  "EUR",
  "GBP",
  "AUD",
  "CAD",
  "SGD",
  "AED",
  "JPY",
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCY_CODES)[number];

/**
 * The navbar dropdown's rows. `satisfies` ties every `code` back to
 * `SUPPORTED_CURRENCY_CODES`, so adding a row without adding its code (or the
 * reverse) is a type error rather than a silent divergence.
 */
export const SUPPORTED_CURRENCIES = [
  { code: "INR", symbol: "₹", label: "INR (₹)" },
  { code: "USD", symbol: "$", label: "USD ($)" },
  { code: "EUR", symbol: "€", label: "EUR (€)" },
  { code: "GBP", symbol: "£", label: "GBP (£)" },
  { code: "AUD", symbol: "A$", label: "AUD (A$)" },
  { code: "CAD", symbol: "C$", label: "CAD (C$)" },
  { code: "SGD", symbol: "S$", label: "SGD (S$)" },
  { code: "AED", symbol: "AED", label: "AED" },
  { code: "JPY", symbol: "¥", label: "JPY (¥)" },
] as const satisfies readonly {
  code: SupportedCurrency;
  symbol: string;
  label: string;
}[];

/**
 * The attribution ExchangeRate-API's Open Access tier requires wherever a rate
 * of theirs is shown. See https://www.exchangerate-api.com/docs/free — it is a
 * licence term, not a courtesy, so every surface that renders a converted
 * figure carries it.
 */
export const RATE_PROVIDER_NAME = "Exchange Rate API";
export const RATE_PROVIDER_URL = "https://www.exchangerate-api.com";

/**
 * Narrow an arbitrary string to a supported display currency, or to `undefined`
 * when it is not one.
 *
 * #1396 — the checkout body's `displayCurrency` originates in `localStorage` by
 * way of `useCurrency`, so its static type is `string` however carefully the
 * hook is written. Dropping an unrecognised code is deliberate: the field is
 * audit-only display metadata on the Payment row, and refusing to check out
 * because a tampered preference key holds junk would be a worse outcome than
 * recording nothing. The server schema rejects the same junk independently, so
 * this is a normaliser, not the security boundary.
 */
export function toSupportedCurrency(
  raw: string | null | undefined,
): SupportedCurrency | undefined {
  if (!raw) return undefined;
  const up = raw.trim().toUpperCase();
  return (SUPPORTED_CURRENCY_CODES as readonly string[]).includes(up)
    ? (up as SupportedCurrency)
    : undefined;
}
