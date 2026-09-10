import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getExchangeRates } from "@/lib/currency";
import {
  SUPPORTED_CURRENCIES,
  SUPPORTED_CURRENCY_CODES,
} from "@/lib/currency-codes";
import { applyRateLimit, currencyLimiter, getClientIp } from "@/lib/rate-limit";

// #1396 — this replaces the `CURRENCY_SYMBOLS` Proxy in lib/currency.ts, which
// claimed to hold every ISO 4217 code by answering `has` with `true` and
// deriving the symbol through Intl on every property read. The route only ever
// needs a symbol for a currency the navbar can actually select, so a plain map
// over that same list says what is true and an unknown code falls back to the
// code itself, which is what Intl would have produced anyway.
const CURRENCY_SYMBOL_BY_CODE: Record<string, string> = Object.fromEntries(
  SUPPORTED_CURRENCIES.map((c) => [c.code, c.symbol]),
);

function symbolFor(code: string): string {
  return CURRENCY_SYMBOL_BY_CODE[code] ?? code;
}

// #1396 — the response is a public, per-currency mid-market rate that is
// identical for every caller, and the upstream provider refreshes it once a
// day. Serving it from the CDN for an hour, and allowing a day-old copy to be
// served while a new one is fetched, is what actually protects the provider
// quota: the module-level cache in lib/currency.ts is per serverless instance
// and gives no cross-instance hit rate at all.
const CACHE_CONTROL = "public, s-maxage=3600, stale-while-revalidate=86400";

// #1414 — `to` arrives from localStorage by way of useCurrency, so it is
// attacker-controlled. The provider answers with roughly 160 codes, and reading
// `rates[to]` straight off that object returned a real rate for currencies the
// navbar never offers and `symbolFor` has no symbol for. Allowlisting here is
// the same list the switcher renders and the checkout schema accepts, so the
// three cannot drift; an unsupported code 400s without the raw value being
// echoed back.
const querySchema = z.object({
  to: z.enum(SUPPORTED_CURRENCY_CODES).default("INR"),
});

export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(currencyLimiter, getClientIp(request));
  if (limited) return limited;

  try {
    const parsed = querySchema.safeParse({
      to: request.nextUrl.searchParams.get("to") || undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Unsupported currency" },
        { status: 400 },
      );
    }
    const { to } = parsed.data;

    // If target is INR, no conversion needed
    if (to === "INR") {
      return NextResponse.json(
        { rate: 1, currency: "INR", symbol: symbolFor("INR") },
        { headers: { "Cache-Control": CACHE_CONTROL } },
      );
    }

    const rates = await getExchangeRates();
    const rate = rates[to];

    // Allowlisted but absent upstream: the provider dropped a code we offer.
    // Treated as a provider failure, not a client error, so useCurrency
    // degrades to honest INR rather than showing a converted figure.
    if (rate === undefined) {
      return NextResponse.json(
        { error: "Failed to fetch exchange rates" },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        rate,
        currency: to,
        symbol: symbolFor(to),
      },
      { headers: { "Cache-Control": CACHE_CONTROL } },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "currency" } },
    );
    console.error("Currency API error:", error);
    // #1396 — reaching here now also covers "the provider is down and the
    // cached rates are older than a day". Answering 500 is deliberate: the
    // client query exhausts its retries, `rate` stays null, and useCurrency
    // renders honest INR rather than a stale conversion presented as current.
    return NextResponse.json(
      { error: "Failed to fetch exchange rates" },
      { status: 500 },
    );
  }
}
