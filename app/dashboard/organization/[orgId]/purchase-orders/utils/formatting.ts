/**
 * Display helpers for the PurchaseOrders dashboard.
 *
 * Currency formatting differs by currency: INR uses zero-decimal output
 * (POs are large finance-team numbers; sub-rupee noise hurts scanability)
 * while forex uses two-decimal output (where sub-unit precision matters).
 */

import type { PoCurrency, PoStatus } from "./types";

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function fmtMoney(paise: number, currency: PoCurrency): string {
  const value = paise / 100;
  if (currency === "INR") {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 0,
    }).format(value);
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

export const STATUS_BADGE_CLASSNAME: Record<PoStatus, string> = {
  ACTIVE: "bg-green-50 text-green-800 border-green-300",
  CLOSED: "bg-zinc-100 text-zinc-700 border-zinc-300",
  CANCELLED: "bg-red-50 text-red-700 border-red-300",
};
