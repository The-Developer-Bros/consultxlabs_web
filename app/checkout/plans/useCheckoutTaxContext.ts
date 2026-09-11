"use client";

import { useEffect, useState } from "react";

type CheckoutTaxContext = {
  buyerCountry: string;
  isInternational: boolean;
  /** Server-decided (#1230): international AND a valid platform LUT exists. */
  exportZeroRated: boolean;
  /** #1365 — remembered GST billing state, used to pre-fill the picker. */
  billingStateCode: string | null;
};

const DEFAULT_CONTEXT: CheckoutTaxContext = {
  buyerCountry: "IN",
  isInternational: false,
  exportZeroRated: false,
  billingStateCode: null,
};

export function useCheckoutTaxContext() {
  const [taxContext, setTaxContext] =
    useState<CheckoutTaxContext>(DEFAULT_CONTEXT);

  useEffect(() => {
    let cancelled = false;

    async function loadTaxContext() {
      try {
        const response = await fetch("/api/checkout/context", {
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error("Failed to fetch checkout tax context");
        }

        const data = (await response.json()) as CheckoutTaxContext;
        if (!cancelled) {
          setTaxContext(data);
        }
      } catch {
        if (!cancelled) {
          setTaxContext(DEFAULT_CONTEXT);
        }
      }
    }

    loadTaxContext();

    return () => {
      cancelled = true;
    };
  }, []);

  return taxContext;
}
