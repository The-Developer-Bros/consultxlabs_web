/**
 * Maintenance Mode — Edge-compatible reader
 *
 * This module is safe for Next.js middleware (Edge Runtime).
 * Uses direct fetch to Upstash Redis REST API (no SDK import needed).
 * No Prisma, no Node.js-only APIs.
 *
 * For write operations (setMaintenanceState), use lib/maintenance.ts instead.
 */

import { NextRequest } from "next/server";

import { REDIS_KEYS } from "./maintenance-keys";

// REDIS_KEYS is platform-scoped (single phase/config read per request, 30s-cached
// below). Per-org windows ("maintenance:phase:org:<orgId>") are NOT implemented —
// prior orgMaintenanceKeys()/platformMaintenanceKeys() scaffolding was removed
// (#776) as dead code. If they ship, add the org-scoped read here (org key first,
// fall back to platform) and a matching writer in the admin maintenance route.

// Routes exempt from maintenance mode
const EXEMPT_PREFIXES = [
  "/api/webhooks/",
  "/api/health",
  "/api/auth/",
  "/api/admin/maintenance",
  "/maintenance",
  "/_next/",
  "/favicon",
];

export interface MaintenanceState {
  phase: "OFF" | "DEGRADED" | "OFFLINE";
  reason: string | null;
  estimatedEnd: string | null;
  bypassSecret: string | null;
}

const OFF_STATE: MaintenanceState = {
  phase: "OFF",
  reason: null,
  estimatedEnd: null,
  bypassSecret: null,
};

// In-memory cache to avoid Redis round-trips on every request.
// Edge isolates share module scope within an instance lifetime.
let cachedState: MaintenanceState | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds

// Per-request fail-open budget for the edge Upstash read. Document loads + /api/*
// pay this (RSC/prefetch sub-navigations use getMaintenanceStateCachedOnly and
// never read live), and it falls back to OFF on timeout — so a slow Upstash gives
// up fast rather than adding latency to live traffic. 200ms: well under a frame.
const REDIS_FETCH_TIMEOUT_MS = (() => {
  const v = Number(process.env.REDIS_FETCH_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 200;
})();

/**
 * Direct Upstash REST call — edge-safe, no SDK needed.
 */
async function redisGet(key: string): Promise<string | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(REDIS_FETCH_TIMEOUT_MS),
  });

  if (!res.ok) return null;
  const data = await res.json();
  return data.result ?? null;
}

/**
 * Read current maintenance state from Redis (edge-safe).
 * Fail-open: returns OFF if Redis is unreachable or not configured.
 */
export async function getMaintenanceState(): Promise<MaintenanceState> {
  const now = Date.now();
  if (cachedState && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedState;
  }

  try {
    const [phase, configRaw] = await Promise.all([
      redisGet(REDIS_KEYS.PHASE),
      redisGet(REDIS_KEYS.CONFIG),
    ]);

    if (!phase || phase === "OFF") {
      cachedState = OFF_STATE;
      cacheTimestamp = now;
      return OFF_STATE;
    }

    let config: Partial<MaintenanceState> = {};
    if (configRaw) {
      try {
        config = JSON.parse(configRaw);
      } catch {
        // Malformed config — treat as no config
      }
    }

    const state: MaintenanceState = {
      phase: phase as MaintenanceState["phase"],
      reason: config.reason ?? null,
      estimatedEnd: config.estimatedEnd ?? null,
      bypassSecret: config.bypassSecret ?? null,
    };
    cachedState = state;
    cacheTimestamp = now;
    return state;
  } catch {
    // Fail-open: cache OFF to avoid repeated failing calls
    cachedState = OFF_STATE;
    cacheTimestamp = now;
    return OFF_STATE;
  }
}

/**
 * Non-blocking maintenance read for the hot sub-navigation path (Next RSC +
 * prefetch fetches). Returns the in-memory cached state if fresh, else OFF —
 * NEVER a live Upstash round-trip. Without this, the blocking read in
 * getMaintenanceState() runs before the RSC response can stream, so a soft
 * navigation sits blank until it resolves (the gap before loading.tsx appears).
 * A full document load still does the live read, so a maintenance window is
 * always enforced within one document navigation / the 30s cache window.
 *
 * When the cache is stale we kick off a refresh (so the NEXT sub-navigation sees
 * fresh state) and return the last-known state rather than OFF — otherwise a
 * session that only soft-navigates would bypass an active window indefinitely
 * once the TTL lapses (#927). Two edge-runtime caveats (#929 review):
 *  - an unawaited promise is not guaranteed to run after the response is sent, so
 *    the caller passes `event.waitUntil` to keep the refresh alive;
 *  - a single `isRefreshing` guard collapses concurrent stale sub-navigations into
 *    one Upstash read instead of a thundering herd.
 */
let isRefreshing = false;

export function getMaintenanceStateCachedOnly(
  waitUntil?: (promise: Promise<unknown>) => void,
): MaintenanceState {
  if (cachedState && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedState;
  }
  if (!isRefreshing) {
    isRefreshing = true;
    const refresh = getMaintenanceState()
      .catch(() => {})
      .finally(() => {
        isRefreshing = false;
      });
    waitUntil?.(refresh);
  }
  return cachedState ?? OFF_STATE;
}

// Matches paths ending with a file extension (e.g. .js, .css, .png, .woff2).
// More precise than pathname.includes(".") which false-positives on /api/v2.0/foo.
// Exported so middleware.ts reuses the exact same rule for its static-asset skip
// (single source of truth — #776).
export const HAS_FILE_EXTENSION = /\.\w{2,10}$/;

/**
 * Check if a route is exempt from maintenance mode.
 */
export function isMaintenanceExempt(pathname: string): boolean {
  if (HAS_FILE_EXTENSION.test(pathname)) return true;
  return EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// Transactional write routes to block during DEGRADED maintenance.
// Read-only methods (GET, HEAD, OPTIONS) are always allowed.
// Every pattern matches by PREFIX: naming a route also blocks everything
// nested under it. A single '*' stands for exactly one path segment.
const WRITE_BLOCKED_IN_DEGRADED = [
  "/api/checkout",
  "/api/appointments/*/cancel",
  // Prefix semantics cover /respond and /withdraw, which the old endsWith
  // matcher left writable for the whole life of the write-block.
  "/api/appointments/*/reschedule",
  "/api/appointments/*/documents",
  "/api/appointments/*/feedback",
  "/api/appointments/*/support",
  "/api/bookings/consultations",
  "/api/bookings/subscriptions",
  "/api/bookings/webinars",
  "/api/bookings/classes",
  "/api/bookings/*/allocate",
  "/api/trials",
  "/api/plans/*/materials",
  "/api/stream/meetings", // Block new video call creation
  "/api/form/onboarding/*", // Block new user registration/onboarding
  "/api/verification/documents", // Block verification document uploads
  "/api/verification/submit", // Block verification submission
  "/api/verification/resubmit", // Block verification resubmission
  "/api/slots/request-for-approval", // Block new approval-rail bookings
  // Weekly, custom and per-id availability writes; the sibling
  // /api/slots/availability-with-allocation is a different prefix and is GET.
  "/api/slots/availability",
  "/api/waitlist", // Block newsletter signups
  "/api/referrals", // Block referral code creation
  "/api/collaborators", // Block collaborator management
  "/api/payments/disputes", // Block dispute handling mutations
  "/api/admin/payouts", // Block admin payout mutations
  // Org money rails. Nothing under /api/organizations was blocked before, so
  // an org could top up a wallet, issue an invoice or move a payout while the
  // deployment was half-applied. Prefix semantics mean `programs` also covers
  // programs/*/assignments and programs/*/auto-enroll, and `contracts` covers
  // contracts/*/supersede.
  "/api/organizations/*/billing-account/wallet/top-ups",
  "/api/organizations/*/billing-account/invoices",
  "/api/organizations/*/billing-account/purchase-orders",
  "/api/organizations/*/programs",
  "/api/organizations/*/contracts",
  "/api/organizations/*/rate-cards",
  "/api/organizations/*/payouts",
  "/api/organizations/*/payout-account",
  // Seat changes meter the licences the checkout entitlement resolver reads.
  "/api/organizations/*/members",
  "/api/organizations/*/invitations",
];

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Match one pattern against a path, PREFIX-wise.
 *
 * The wildcard used to be matched as `startsWith(prefix) && endsWith(suffix)`,
 * which pinned the match to the END of the path: the appointments reschedule pattern
 * blocked `/reschedule` and nothing under it, so `/reschedule/respond` and
 * `/reschedule/withdraw` — the two routes that actually move a booking — wrote
 * straight through DEGRADED. Naming a route now blocks its whole subtree, which
 * is what every entry in the list above was always read as meaning.
 *
 * The wildcard still stands for exactly one non-empty segment, so
 * the bookings allocate pattern cannot be satisfied by `/api/bookings/allocate`.
 */
function matchesBlockedPattern(pathname: string, pattern: string): boolean {
  const star = pattern.indexOf("*");
  if (star === -1) {
    return pathname === pattern || pathname.startsWith(pattern + "/");
  }

  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!pathname.startsWith(prefix)) return false;

  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  const segment = slash === -1 ? rest : rest.slice(0, slash);
  if (segment.length === 0) return false;

  const tail = slash === -1 ? "" : rest.slice(slash);
  return tail === suffix || tail.startsWith(suffix + "/");
}

/**
 * Returns true if the route+method combination should be blocked in DEGRADED mode.
 * Prevents transactional writes (bookings, payments, cancellations) during
 * partial maintenance while still allowing users to browse and read data.
 */
export function isWriteBlockedInDegraded(
  pathname: string,
  method: string,
): boolean {
  if (READ_ONLY_METHODS.has(method.toUpperCase())) return false;

  return WRITE_BLOCKED_IN_DEGRADED.some((pattern) =>
    matchesBlockedPattern(pathname, pattern),
  );
}

/**
 * Validate maintenance bypass via header or cookie.
 */
export function validateBypass(
  request: NextRequest,
  storedSecret: string | null,
): boolean {
  if (!storedSecret) {
    const envSecret = process.env.MAINTENANCE_BYPASS_SECRET;
    if (!envSecret) return false;

    const headerVal = request.headers.get("x-maintenance-bypass");
    const cookieVal = request.cookies.get("maintenance_bypass")?.value;
    return headerVal === envSecret || cookieVal === envSecret;
  }

  const headerVal = request.headers.get("x-maintenance-bypass");
  const cookieVal = request.cookies.get("maintenance_bypass")?.value;
  return headerVal === storedSecret || cookieVal === storedSecret;
}
