// Server-side currency conversion service using ExchangeRate-API
// (open.er-api.com) — supports INR as base natively, needs no API key, and
// refreshes once daily. Rates are DISPLAY-only: settlement is INR (ADR 15) and
// no stored amount is ever derived from one of these numbers.
//
// #1396 — the provider's Open Access tier requires visible attribution
// wherever its rates are shown ("Rates By Exchange Rate API",
// https://www.exchangerate-api.com/docs/free). RATE_PROVIDER_NAME /
// RATE_PROVIDER_URL in lib/currency-codes.ts carry it to the navbar and the
// checkout estimate note.

// The endpoint is configurable so a provider change (or a paid-tier host) does
// not need a code deploy; the default is the free Open Access endpoint we use
// today.
const EXCHANGE_RATE_API_URL =
  process.env.EXCHANGE_RATE_API_URL ?? "https://open.er-api.com/v6/latest/INR";

const CACHE_TTL = 60 * 60 * 1000; // 1 hour (reduced from 24h)

// #1396 — the fallback below used to serve the last successful response for
// as long as the instance lived, with no age check at all. A provider outage or
// a 429 lockout (this API's is roughly twenty minutes) therefore pinned prices
// to a rate that could be arbitrarily old while the UI kept presenting it as
// current. Past this bound we throw instead: /api/currency answers 500, the
// client query exhausts its retries, `rate` stays null, and useCurrency falls
// back to showing honest INR. A missing estimate is better than a stale one.
const MAX_STALE_AGE = 24 * 60 * 60 * 1000; // 24 hours

// #1414 — an unbounded fetch let a stalled provider hold /api/currency (and the
// admin refresh) open for as long as the platform's own function ceiling
// allowed. The checkout rate lookup runs before acquireCheckoutLock, so it
// spends no lock budget, but it still delays the buyer. Five seconds is well
// past this endpoint's normal latency and well inside every caller's ceiling.
const FETCH_TIMEOUT_MS = 5_000;

// Deliberately module-level, so the cache is per serverless instance rather
// than shared. Netlify runs many instances and there is no shared store in this
// path, which means the hit rate is whatever a warm instance gives us and the
// admin flush below can only ever clear the one instance that served the
// request. The CDN cache on /api/currency (s-maxage) is what actually spares
// the provider; this is a second-line, best-effort layer.
let cachedRates: Record<string, number> | null = null;
let cachedAt = 0;

function servableStaleRates(): Record<string, number> | null {
  if (!cachedRates) return null;
  return Date.now() - cachedAt < MAX_STALE_AGE ? cachedRates : null;
}

/**
 * Returns INR→X rates for all supported currencies.
 * Fetched directly from ExchangeRate-API with INR as base.
 *
 * @throws when the provider fails and no cached response younger than
 *         MAX_STALE_AGE is available.
 */
export async function getExchangeRates(): Promise<Record<string, number>> {
  const now = Date.now();
  if (cachedRates && now - cachedAt < CACHE_TTL) {
    return cachedRates;
  }

  let res: Response;
  try {
    res = await fetch(EXCHANGE_RATE_API_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    // A timeout or a network failure is the same situation as a 5xx: serve the
    // cached copy while it is still young enough to be honest, else throw and
    // let the caller degrade to INR.
    const stale = servableStaleRates();
    if (stale) return stale;
    throw error;
  }

  if (!res.ok) {
    const stale = servableStaleRates();
    if (stale) return stale;
    throw new Error(`Failed to fetch exchange rates: ${res.status}`);
  }

  // #1414 — only `fetch` was inside a fallback. A 200 carrying malformed JSON
  // threw out of `res.json()` past every `servableStaleRates()` branch, so
  // /api/currency answered 500 while a perfectly young cache sat right here;
  // a 200 with no `rates` object published `undefined` as the rate table.
  // Parse and validate under the same degradation rule as the transport.
  let data: { result?: string; rates?: unknown };
  try {
    data = await res.json();
  } catch (error) {
    const stale = servableStaleRates();
    if (stale) return stale;
    throw error;
  }

  const rates = data?.rates;
  const ratesAreUsable =
    typeof rates === "object" &&
    rates !== null &&
    Object.keys(rates).length > 0;
  if (data?.result !== "success" || !ratesAreUsable) {
    const stale = servableStaleRates();
    if (stale) return stale;
    throw new Error("Exchange rate API returned an error");
  }

  cachedRates = rates as Record<string, number>;
  cachedAt = now;
  return cachedRates;
}

/**
 * Force-invalidates the in-memory exchange rate cache.
 * Called by POST /api/admin/exchange-rates (admin-only).
 */
export function invalidateExchangeRateCache(): void {
  cachedRates = null;
  cachedAt = 0;
}

/**
 * Returns cache metadata for admin monitoring.
 */
export function getExchangeRateCacheInfo(): {
  cachedAt: number | null;
  ageMs: number | null;
} {
  if (!cachedRates) return { cachedAt: null, ageMs: null };
  return { cachedAt, ageMs: Date.now() - cachedAt };
}
