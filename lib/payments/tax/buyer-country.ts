/**
 * Buyer Country Detection
 *
 * Server-side detection cascade for determining buyer's country at checkout.
 * Used for tax jurisdiction determination (GST vs zero-rated export).
 */

// Maps locale strings to ISO 3166-1 alpha-2 country codes

/**
 * Detect buyer country using a cascading strategy.
 *
 * Priority:
 * 1. User's profile country (highest confidence — explicitly set)
 * 2. Cloudflare cf-ipcountry header (geo-IP, available on Netlify with CF DNS)
 * 3. Accept-Language header mapping
 * 4. Fallback: "IN" (conservative — charges GST rather than missing it)
 */
export function detectBuyerCountry(params: {
  userCountry?: string | null;
  cfIpCountry?: string | null;
  acceptLanguage?: string | null;
}): string {
  // 1. User profile country (most reliable)
  if (params.userCountry && params.userCountry.length === 2) {
    return params.userCountry.toUpperCase();
  }

  // 2. Cloudflare geo-IP header
  if (
    params.cfIpCountry &&
    params.cfIpCountry !== "XX" &&
    params.cfIpCountry !== "T1"
  ) {
    return params.cfIpCountry.toUpperCase();
  }

  // 3. Accept-Language is deliberately NOT a tax signal.
  //
  // It used to be, and it decided the GST outcome in practice, because the two
  // signals above are both dead in this deployment: `User.country` is a
  // free-text onboarding field ("e.g., United States") that can never satisfy
  // the `.length === 2` check above it, and `cf-ipcountry` never arrives —
  // production is served by Netlify with no Cloudflare in front of it. So the
  // deciding input for whether Indian GST was charged was the browser's
  // language header, and `en-US` — a very common default in India — mapped to
  // "US" and zero-rated the sale as an export. Every payment ever created
  // through the real checkout path in the dev database is recorded as
  // buyerCountry="US", isInternational=true, taxAmount=0.
  //
  // A browser locale is not evidence of anything a tax authority recognises,
  // and it silently defeated the conservative fallback below. Zero-rating now
  // requires a signal someone actually asserted.
  //
  // 4. Conservative fallback — assume India (charge GST rather than miss it).
  return "IN";
}

/**
 * Extract buyer country detection params from a Request/Headers object.
 * Use this in API routes to get the params for detectBuyerCountry.
 */
export function extractBuyerCountryParams(headers: Headers): {
  cfIpCountry: string | null;
  acceptLanguage: string | null;
} {
  return {
    cfIpCountry: headers.get("cf-ipcountry"),
    acceptLanguage: headers.get("accept-language"),
  };
}
