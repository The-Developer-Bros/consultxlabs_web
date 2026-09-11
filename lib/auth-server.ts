import { cache } from "react";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

/**
 * Render-memoized session read. Nested layouts that call requireOnboarded /
 * requireAuth in the same RSC render share one Better Auth getSession call
 * instead of re-running customSession enrichment for each guard. This is the
 * dedupe that actually cuts dashboard TTFB — the Better Auth cookie cache is
 * not, because customSession re-runs its Prisma work on every call anyway.
 *
 * Keyed by disableCookieCache so a force-fresh read never serves a cached
 * cookie-cache result (and vice versa) within the same request.
 *
 * Two limits worth knowing. React.cache memoizes only during an RSC render, so
 * Route Handlers and Server Actions get a throwaway cache per call and still
 * pay per getSession. And the memo holds the promise, so if the first read
 * rejects every later guard in that render re-throws the same rejection rather
 * than retrying independently (documented: react.dev/reference/react/cache).
 *
 * Undeclared dependency, deliberately recorded: package.json pins react
 * ^18.3.1, and react@18.3.1 does NOT export `cache` — `Object.keys(require(
 * "react")).includes("cache")` is false. This resolves only because Next
 * aliases `react` to its own vendored React 19 inside the RSC layer. It works
 * (the build is green and 5 pages plus lib/data already rely on it), but it
 * rests on a bundler alias rather than on the declared dep. If that alias ever
 * stops applying, this silently degrades to no memoization — correct results,
 * N times the queries, and no test would catch it. Revisit when React 19
 * lands properly; Next 15's App Router targets it.
 */
type SessionReader = (
  disableCookieCache: boolean,
) => ReturnType<typeof auth.api.getSession>;

const readSession: SessionReader = async (disableCookieCache) =>
  auth.api.getSession({
    headers: await headers(),
    ...(disableCookieCache && { query: { disableCookieCache: true } }),
  });

/**
 * #1275 — built on FIRST CALL, not at module scope, and only when `cache` is
 * actually a function.
 *
 * The docblock above warned that losing Next's React alias would silently
 * degrade this to no memoization. The reality was worse: `cache(...)` at module
 * scope THREW, and it threw in every process that is not the RSC layer. Eight
 * scheduled jobs import this file transitively and every one of them died
 * during module evaluation, before a line of their own code ran:
 *
 *   $ npx tsx -e "import('./jobs/payments/reconcile-payment-status.ts')"
 *   IMPORT FAILS: (0 , import_react.cache) is not a function
 *
 * Those eight are the payments and payouts reconciliation layer, plus
 * `sweep-stuck-webhook-events` — which is the durability backstop the Stream
 * webhook route explicitly delegates to. None had ever completed a run.
 *
 * Deferring the call fixes the import; tolerating an absent `cache` fixes the
 * job. Memoization is meaningless in a one-shot cron process anyway — there is
 * one request — so the unmemoized reader is the correct behaviour there, not a
 * degraded one. Inside a render nothing changes: the memo is built on the first
 * guard's call and every later guard in that render shares it.
 */
let memoizedReader: SessionReader | undefined;

function sessionReader(): SessionReader {
  memoizedReader ??=
    typeof cache === "function" ? cache(readSession) : readSession;
  return memoizedReader;
}

export async function getSession(disableCookieCache = false) {
  return sessionReader()(disableCookieCache);
}
