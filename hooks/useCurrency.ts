"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { reportSentryError } from "@/lib/observability/report";
import { CURRENCY_LOCALE_MAP } from "@/utils/formatting";
import {
  SUPPORTED_CURRENCIES,
  type SupportedCurrency,
} from "@/lib/currency-codes";

const STORAGE_KEY = "preferred-currency";
const DEFAULT_CURRENCY = "INR";

// #1396 — the list itself moved to lib/currency-codes.ts so schemas/checkout.ts
// can allowlist `displayCurrency` against the same codes without importing a
// React module. Re-exported here because every existing consumer imports it
// from the hook.
export { SUPPORTED_CURRENCIES };
export type { SupportedCurrency };

// ---------- shared external store (cross-component reactivity) ----------

let listeners: (() => void)[] = [];

function emitChange() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function getSnapshot(): string {
  if (typeof window === "undefined") return DEFAULT_CURRENCY;
  return localStorage.getItem(STORAGE_KEY) || DEFAULT_CURRENCY;
}

function getServerSnapshot(): string {
  return DEFAULT_CURRENCY;
}

// ---------- setter (wrapped by the hook's setCurrency) ----------

function setPreferredCurrency(code: string) {
  localStorage.setItem(STORAGE_KEY, code);
  emitChange();
}

// ---------- hook ----------

interface CurrencyData {
  rate: number;
  currency: string;
  symbol: string;
}

export function useCurrency() {
  const queryClient = useQueryClient();
  const selectedCurrency = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const isINR = selectedCurrency === "INR";

  const { data, isLoading } = useQuery<CurrencyData>({
    queryKey: ["currency-rate", selectedCurrency],
    queryFn: async () => {
      try {
        const res = await fetch(
          `/api/currency?to=${encodeURIComponent(selectedCurrency)}`,
        );
        if (!res.ok) throw new Error("Failed to fetch currency rate");
        return await res.json();
      } catch (error) {
        // React Query retries this (retry: 2) and formatPrice already has an
        // honest INR fallback while rate is null — captured for visibility
        // into retry volume, not because the degrade itself needs fixing.
        reportSentryError(error, { subsystem: "client", expected: true });
        throw error;
      }
    },
    enabled: !isINR,
    staleTime: 60 * 60 * 1000, // 1 hour
    gcTime: 2 * 60 * 60 * 1000,
    retry: 2,
  });

  // No rate yet (still loading, or the provider failed after retries). Falling
  // back to 1 meant multiplying by nothing and then stamping a foreign symbol
  // on the result: a ₹5,000 session rendered as "$5,000" — about 83x its real
  // price — on every fresh page view until the fetch landed, and permanently if
  // it never did. `rate === null` lets formatPrice show the true INR figure
  // instead, which is honest at any moment rather than wrong for a while.
  const rate: number | null = isINR ? 1 : (data?.rate ?? null);

  // #1396 — `currency` and `symbol` used to keep naming the selected currency
  // even while `rate` was null and formatPrice was already rendering rupees, so
  // the navbar advertised "$ USD" over prices denominated in INR. The whole
  // triple degrades together now: no rate means no foreign labelling anywhere.
  const degradedToINR = isINR || rate === null;
  const currency = degradedToINR ? "INR" : (data?.currency ?? selectedCurrency);
  const symbol = degradedToINR
    ? "\u20B9"
    : (data?.symbol ??
      SUPPORTED_CURRENCIES.find((c) => c.code === selectedCurrency)?.symbol ??
      selectedCurrency);

  // True exactly when the figures on screen are a converted estimate rather
  // than the amount the gateway will charge. Checkout uses it to say so; the
  // navbar uses it to attribute the rate provider. It is deliberately false
  // during the degrade, because rupees shown as rupees are not an estimate.
  const isEstimate = !isINR && rate !== null;

  const convert = useCallback(
    (amountINR: number): number => {
      if (isINR || rate === null) return amountINR;
      return Math.round(amountINR * rate * 100) / 100;
    },
    [rate, isINR],
  );

  const formatPrice = useCallback(
    (amountInPaise: number): string => {
      // Convert from paise (smallest unit) to major unit for display
      const amountInMajor = amountInPaise / 100;
      const converted = convert(amountInMajor);
      // `currency` is already "INR" whenever `rate` is null, so the amount is
      // rendered in the currency it is actually denominated in.
      const displayCurrency = currency;
      // Use currency-appropriate locale for correct grouping (e.g. ₹1,00,000 vs $100,000)
      const locale =
        CURRENCY_LOCALE_MAP[displayCurrency.toUpperCase()] ||
        (typeof navigator !== "undefined" ? navigator.language : "en-IN");
      try {
        return new Intl.NumberFormat(locale, {
          style: "currency",
          currency: displayCurrency,
          minimumFractionDigits: 0,
          maximumFractionDigits: 0,
        }).format(converted);
      } catch (error) {
        // Intl accepts any well-formed three-letter code, so a merely unknown
        // currency renders rather than throws \u2014 reaching here means the code is
        // structurally malformed, which only happens when a tampered
        // localStorage value is echoed back by /api/currency. Report it; the
        // fallback below still renders an honest number.
        reportSentryError(error, {
          subsystem: "client",
          extra: { displayCurrency },
        });
        return `${symbol}${Math.round(converted).toLocaleString()}`;
      }
    },
    [convert, currency, symbol],
  );

  const setCurrency = useCallback(
    (code: string) => {
      setPreferredCurrency(code);
      // Invalidate so a new fetch fires if needed
      queryClient.invalidateQueries({ queryKey: ["currency-rate"] });
    },
    [queryClient],
  );

  return {
    currency,
    symbol,
    rate,
    isEstimate,
    convert,
    formatPrice,
    setCurrency,
    isLoading: !isINR && isLoading,
  };
}
