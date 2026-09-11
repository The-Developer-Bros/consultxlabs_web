/**
 * Fail-open helper for read-only list queries on public surfaces (explore pages).
 *
 * Degrades ONLY for the transient DB-read-timeout class — the cold-query case
 * (pg connect/query budget, pool timeout) these pages must survive — and RETHROWS
 * everything else (mapper/serialization regressions, logic bugs) so real defects
 * still surface to the error boundary + Sentry rather than rendering an empty
 * section. The transient case is reported to Sentry (warning) so a recurrence of
 * the cold-query / schema-drift condition stays alertable. (#925, #929 review.)
 *
 * Fail-open applies only where the degraded result reaches the ONE request that
 * hit the failure. It is opt-in per call site via `perRequest`, and the default
 * is to rethrow — see {@link mayDegrade}.
 */
import * as Sentry from "@sentry/nextjs";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

// A transient pooler failure during `next build` would bake an empty-but-valid
// page into static HTML and serve it to everyone for a whole revalidate window.
// Failing the build instead is loud, retryable, and costs nothing but a re-run.
// The build also gets a longer retry ladder than the request path. (#932)
//
// Next sets NEXT_PHASE to this constant for the duration of a production build
// (next/dist/build/index.js), and never at request time on the deployed server.
function isProductionBuild(): boolean {
  return process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD;
}

export type FailOpenOptions = {
  /**
   * Set this ONLY where the render is genuinely per-request — a route that
   * exports `dynamic = "force-dynamic"`, or a Route Handler. Leave it unset on
   * anything with a `revalidate` export.
   */
  perRequest?: boolean;
};

// The build-phase guard was never the whole story. Since #1110 the explore
// routes are ISR, so a 200 carrying a degraded body is written to the Netlify
// durable cache and replayed to every visitor for the rest of the revalidate
// window — measured: one such render was served back at 0.3s with a climbing
// `age`, so the broken page became the FAST one and nothing looked wrong. Build
// output and the ISR cache are the same hazard: a render that is persisted and
// replayed must never carry a swallowed failure. Rethrowing instead costs the one
// unlucky visitor a 500 and writes nothing to the cache — verified: a thrown ISR
// render returns `Cache-Status: "Netlify Durable"; fwd=bypass` with no `stored`.
//
// Be precise about the consolation prize, because it does not always apply. A
// previously cached copy DOES keep serving when a revalidation throws (verified:
// `age` climbs past the window). But the two `[param]` routes return [] from
// `generateStaticParams`, so a parameter rendering for the first time has no copy
// to fall back on and its visitor simply gets the error boundary. That is the
// majority path on those routes, and it is still the better trade than poisoning
// the cache for everyone. (#1119)
function mayDegrade(options?: FailOpenOptions): boolean {
  return Boolean(options?.perRequest) && !isProductionBuild();
}

// #932 was a COLD cross-region pooler connect, so the first attempt is far more
// likely to fail than the second. The build can afford a long ladder because the
// wall-clock is paid once per deploy rather than once per visitor.
const BUILD_RETRY_DELAYS_MS = [500, 2000];

/**
 * Wraps a read so it is retried during `next build` only. Returns the reader
 * untouched at request time.
 *
 * A request-time retry was written and REVERTED inside #1123. It looked free:
 * the connect that "times out" is usually a casualty of a ~25s event-loop stall
 * on a new instance (#1120), and the attempt straight after it connected in 327ms
 * and 340ms. But the benefit only ever showed up in two diagnostic samples and
 * could not be separated from the rethrow in the page-level A/B, while the cost is
 * structural: retrying per read doubles the query count on the pages that issue
 * four of them, and `PG_POOL_MAX=1` serialises those. Against a genuinely
 * saturated pooler that pushes a render toward Netlify's function ceiling, where
 * the response is a bare platform 500 with NO error boundary and no `Cache-Status`
 * — strictly worse than the fast 500 the rethrow already gives. Do not reinstate
 * it without a per-render budget and fault-injected evidence. Tracked on #1124.
 */
export async function withBuildTimeRetry<T>(read: () => Promise<T>): Promise<T> {
  if (!isProductionBuild()) return read();

  let lastError: unknown;
  for (let attempt = 0; attempt <= BUILD_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await read();
    } catch (err) {
      lastError = err;
      // Only the transient class is worth retrying; a mapper bug fails identically
      // every time and should surface immediately.
      if (!isTransientDbError(err) || attempt === BUILD_RETRY_DELAYS_MS.length) {
        throw err;
      }
      // Visible in the CI build log, so a build that burned time retrying does
      // not look identical to one that did not. Build-only by construction — the
      // early return above means this loop never runs at request time — which is
      // why it was the one console.warn that worked even while `removeConsole`
      // was deleting the rest of them (#1122).
      console.warn(
        `[fail-open] transient DB error during build, retrying in ${BUILD_RETRY_DELAYS_MS[attempt]}ms:`,
        err instanceof Error ? err.message : String(err),
      );
      await new Promise((r) => setTimeout(r, BUILD_RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastError;
}

// Exported so non-explore read paths (e.g. the public announcements banner) can
// share the same transient-class detection and degrade rather than 500 (#929).
export function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    code === "P2024" || // pool timeout
    code === "P1008" || // operations timed out
    /timeout|timed out|connection terminated|ETIMEDOUT/i.test(msg)
  );
}

// Report a degraded read without re-raising it: a server-log line plus a Sentry
// breadcrumb — NOT a captured event. The log line only started reaching the
// deployed function log with #1122; before that this was breadcrumb-only in
// production, which is worth knowing when reading back an old incident. The
// transient pooler-timeout class is a
// known, tracked condition (cross-region latency, #932), so firing a Sentry
// warning *issue* per degradation only floods the dashboard (and multiplies as
// more read paths adopt fail-open). The breadcrumb keeps the context attached to
// any *real* error captured later in the same request. (#929, #931, #934.)
export function reportTransient(
  context: string,
  err: unknown,
  tags?: Record<string, string>,
): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(
    `[fail-open] ${context} (transient DB timeout) — degrading:`,
    message,
  );
  Sentry.addBreadcrumb({
    category: "fail-open",
    level: "warning",
    message: `${context} (transient DB timeout)`,
    data: { context, message, ...tags },
  });
}

export function emptyOnTransientDbError(
  context: string,
  options?: FailOpenOptions,
) {
  return (err: unknown): never[] => {
    if (!isTransientDbError(err)) throw err;
    if (!mayDegrade(options)) throw err;
    reportTransient(context, err);
    return [];
  };
}

/**
 * Object-shaped sibling of {@link emptyOnTransientDbError}: returns `fallback`
 * for the transient-timeout class and RETHROWS everything else. For a non-list
 * read on a `force-dynamic` route or a Route Handler whose response can still be
 * useful with a degraded value. Used by /explore/programs for the hero stats and
 * the viewer's org badges, both of which replaced hand-rolled `catch { return
 * placeholder }` blocks that swallowed every error class rather than the
 * transient one (#1125).
 */
export function fallbackOnTransientDbError<T>(
  context: string,
  fallback: T,
  options?: FailOpenOptions,
) {
  return (err: unknown): T => {
    if (!isTransientDbError(err)) throw err;
    if (!mayDegrade(options)) throw err;
    reportTransient(context, err);
    return fallback;
  };
}
