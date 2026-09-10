# Multi-Currency Architecture

## Strategy: India-First, Accept International, Settle in INR

Every price in this platform is stored as an integer count of INR paise, and every charge is taken in INR. An international buyer may switch the site into a foreign currency, in which case the prices they read are estimates converted client-side from those INR paise; the order the gateway mints is still an INR order and their card issuer performs the conversion at its own rate. This is a display feature, not a pricing feature, and the rest of this document is mostly about keeping that distinction visible to the person paying.

Settlement being INR-only is enforced, not merely assumed. `assertInrSettlement` in `lib/payments/validation/currency-guards.ts` runs as the first statement of both `createRazorpayOrder` and `createStripeCheckoutSession` and throws a `PaymentError` with code `NON_INR_SETTLEMENT` on anything else. The three administrative surfaces that used to accept a currency choice — organisation creation, the billing-account patch, and purchase-order creation — now validate against `z.literal("INR")`. The `Currency` enum stays on those columns, for the reasons recorded in [ADR 15](../../enterprise/70-design-decisions/15-currency-as-enum-with-display-fields.md), but no API will write a value other than INR into them.

### Gateway Selection

| Buyer Country | Gateway  | Method                                       | Fee                     | Settlement |
| ------------- | -------- | -------------------------------------------- | ----------------------- | ---------- |
| India         | Razorpay | Domestic (UPI, cards, netbanking)            | 2% + GST (~2.36%)       | INR, T+2   |
| International | Razorpay | The same INR order, paid by an overseas card | ~3% + GST               | INR, T+7   |
| Fallback      | Stripe   | Checkout Sessions                            | ~6.3% (4.3% + 2% forex) | INR, T+5-7 |

The settlement column deserves one clarification, because an earlier revision of this table put the international row at T+1. That figure belongs to the MoneySaver Export Account, not to this flow. Razorpay settles an ordinary international card payment in INR on a [T+7 working-day cycle](https://razorpay.com/docs/payments/international-payments/faqs/), against T+2 for a domestic one, which is also what our own [gateway evaluation](../gateways/gateway-evaluation-mar-2026.md) recorded.

An earlier revision of this table quoted Razorpay's International Bank Transfer product at 1% with zero forex markup and automatic eFIRC. That was a description of a product this codebase has never used. IBT is the MoneySaver Export Account, a virtual-account bank-transfer rail with [no Orders API behind it](https://razorpay.com/docs/payments/international-payments/international-bank-transfer/), so no checkout could have routed through it. The international row above is what the router actually does, and it costs roughly two points more than the figure that used to appear here.

### Why Razorpay for Everything

Razorpay remains the primary rail for three reasons that survive the correction above. It is still materially cheaper than Stripe for international cards, at roughly 3% against Stripe's 6.3% all-in. It holds an RBI PA-CB licence granted in December 2025, which authorises it for cross-border collection. And it accepts UPI, which is the bulk of domestic volume and something a Stripe-based competitor cannot offer on this rail. That last reason should not be overstated: UPI carries zero MDR because the RBI mandates it, but Razorpay still charges its standard 2% platform fee plus GST on a UPI collection, so the method is cheap for the buyer rather than free for us.

## Currency Flow

```
[Consultant sets price in INR paise]
    ↓
[Consultee optionally switches display currency; prices are converted client-side for reading only]
    ↓
[Checkout: buyer country detected → tax determined → gateway auto-routed]
    ↓
[Order minted in INR; assertInrSettlement refuses anything else]
    ↓
[Payment recorded with buyerCountry + isInternational flags, plus the display currency and rate snapshot for audit]
    ↓
[Earnings created in INR → hold period → TDS calculated → payout in INR]
```

## Buyer Country Detection

The server runs a two-signal cascade at checkout, with a conservative fallback:

1. `User.country`, when it is a two-letter ISO code — the highest-confidence signal, because someone asserted it.
2. The `cf-ipcountry` header, when a Cloudflare edge is in front of the deployment.
3. Fallback to `"IN"`, which charges GST rather than risking a missed collection.

`Accept-Language` was removed from this cascade and must not be reintroduced. It was once the third step, and in this deployment it was effectively the only step that ever fired, because `User.country` is a free-text onboarding field that cannot satisfy the two-letter check and production runs on Netlify with no Cloudflare in front of it. A browser default of `en-US`, which is common in India, therefore zero-rated domestic sales as exports. A browser locale is not evidence a tax authority recognises. The reasoning is recorded in full at `lib/payments/tax/buyer-country.ts` and pinned by `__tests__/payments/currency-and-tax-gates.test.ts`.

## Exchange Rate Handling

Rates come from ExchangeRate-API's Open Access endpoint, which supports INR as a base currency and needs no API key. The endpoint is read from `EXCHANGE_RATE_API_URL` and defaults to `https://open.er-api.com/v6/latest/INR`, so moving to a paid host or a different provider does not require a code change.

Caching happens in two places, and only one of them matters. `lib/currency.ts` holds the last response in a module-level variable for one hour, which means the cache belongs to a single serverless instance: Netlify runs many instances, there is no shared store on this path, and the admin invalidation endpoint at `/api/admin/exchange-rates` can only ever flush the one instance that happens to serve the flush request. The cache that actually spares the provider is the CDN, which `/api/currency` enables with `Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400`. That route is also rate-limited to thirty requests per minute per IP, because the provider answers abuse with a 429 that locks the caller out for roughly twenty minutes, and a single scripted client could otherwise take FX display down for everyone.

Staleness is bounded. A response older than twenty-four hours is never served, even when the provider is failing: `getExchangeRates` throws instead, `/api/currency` answers 500, the client query exhausts its retries, and `rate` settles at `null`. That null is the important case, and it is handled deliberately rather than papered over. When there is no rate, `useCurrency` reports `currency` as INR, `symbol` as `₹`, and `isEstimate` as `false`, so the whole display degrades together and the site shows honest rupees rather than rupee amounts wearing a foreign symbol. A missing estimate is better than a stale one presented as current.

## Disclosure and Attribution

An earlier revision of this document claimed the app displayed "Final amount may vary based on current exchange rate". No such string existed anywhere in the codebase, on any checkout page or beside any price. What exists now is `app/checkout/components/FxEstimateNote.tsx`, rendered directly under the Total on all four checkout pages. It appears only while `isEstimate` is true — that is, only when a non-INR currency is selected and a rate is actually available — and it names the INR figure the gateway will take: "Estimated in USD. You will be charged ₹5,000.00 in INR by the payment gateway; your card issuer's rate applies."

The same component carries the provider attribution, as does the navbar beside the currency switcher. ExchangeRate-API's Open Access tier [requires visible attribution](https://www.exchangerate-api.com/docs/free) wherever its rates are shown, so this is a licence term rather than a courtesy; the link text and target live in `lib/currency-codes.ts` as `RATE_PROVIDER_NAME` and `RATE_PROVIDER_URL` so that every surface that renders a converted figure uses the same one.

Two fields on `Payment` record what the buyer saw. `displayCurrencyAtCheckout` holds the currency code the checkout page was rendered in, and it is now validated against the shared allowlist in `lib/currency-codes.ts` rather than accepted as any three-letter string; the value originates in `localStorage` and `Intl.NumberFormat` will happily render an invented code, so an unvalidated field meant arbitrary text persisting onto a money row. `exchangeRateAtCheckout` holds the INR-to-display rate at the moment of the order. Both are audit-only. No stored amount is ever derived from either.

## Key Files

| File                                         | Purpose                                                              |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `lib/payments/tax/buyer-country.ts`          | Buyer country detection cascade                                      |
| `lib/payments/tax/tax-engine.ts`             | Tax determination (GST vs zero-rated)                                |
| `lib/payments/gateway-router.ts`             | Auto-routing to Razorpay/Stripe                                      |
| `lib/payments/validation/currency-guards.ts` | `toCurrencyEnum`, `validatePlanCurrency`, `assertInrSettlement`      |
| `lib/currency.ts`                            | Server-side rate fetch, per-instance cache, staleness bound          |
| `lib/currency-codes.ts`                      | Shared display-currency allowlist and provider attribution strings   |
| `hooks/useCurrency.ts`                       | Client-side display hook, including `isEstimate` and the INR degrade |
| `app/api/currency/route.ts`                  | Public rate endpoint, CDN-cached and IP rate-limited                 |
| `app/checkout/components/FxEstimateNote.tsx` | The checkout disclosure and its attribution                          |

## Future Phases

- **Phase 2**: Multi-currency pricing (consultants set prices in their currency)
- **Phase 3**: International consultant payouts via Wise
- **Phase 4**: EU VAT OSS + AU GST collection
