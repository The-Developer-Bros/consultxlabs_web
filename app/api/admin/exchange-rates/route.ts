/**
 * Admin: Exchange Rate Cache Management
 *
 * GET  — Returns current cache status (age, staleness)
 * POST — Force-invalidates the in-memory cache, triggering a fresh fetch on next use
 *
 * Useful when FX markets move significantly within the 1-hour cache window.
 *
 * #1396 — read both verbs as instance-local, not global. The cache they act on
 * is a module-level variable in lib/currency.ts, so it belongs to whichever
 * serverless instance happened to serve this request. GET therefore reports one
 * instance's age, and POST cannot flush production: every other warm instance
 * keeps its own copy until that copy expires on its own, and the CDN cache in
 * front of /api/currency is untouched by either call. Treat this as a
 * development and diagnosis aid. The real staleness bound is MAX_STALE_AGE in
 * lib/currency.ts, which refuses to serve anything older than a day.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/auth-helpers";
import {
  invalidateExchangeRateCache,
  getExchangeRateCacheInfo,
  getExchangeRates,
} from "@/lib/currency";

// Local wrapper for the existing "in auth" call sites
async function requireAdmin() {
  const result = await requireAdminAuth();
  if (result.error) return { error: result.error };
  return { userId: result.session.user.id };
}

export async function GET() {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  const info = getExchangeRateCacheInfo();
  return NextResponse.json({
    cached: info.cachedAt !== null,
    cachedAt: info.cachedAt ? new Date(info.cachedAt).toISOString() : null,
    ageMs: info.ageMs,
    ageMinutes: info.ageMs !== null ? Math.round(info.ageMs / 60000) : null,
  });
}

export async function POST() {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  try {
    invalidateExchangeRateCache();

    // Eagerly fetch fresh rates so the next request is fast
    const rates = await getExchangeRates();
    const currencyCount = Object.keys(rates).length;

    return NextResponse.json({
      success: true,
      message: "Exchange rate cache invalidated and refreshed",
      currencyCount,
      refreshedAt: new Date().toISOString(),
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "admin" } });
    console.error("Error refreshing exchange rate cache:", error);
    return NextResponse.json(
      { success: false, message: "Failed to refresh exchange rate cache" },
      { status: 500 },
    );
  }
}
