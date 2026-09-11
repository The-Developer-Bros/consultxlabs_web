import * as Sentry from "@sentry/nextjs";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

import { moneyResultExtensions } from "./prisma-extensions";

// A saturated Supavisor (txn pooler :6543) made pg hang 5–9.6s on connect
// (EAUTHTIMEOUT), surfacing to users as "the edge function timed out". The two
// budgets below fail fast instead. Both env-gated (positive ms wins, else default).
//
// These budgets do NOT bound worst-case latency, and the "3 + 6 = 9s under the
// function ceiling" arithmetic this file used to claim has now sent two
// investigations down the wrong path. Both are `setTimeout`s inside pg
// (pg-pool/index.js:219 for the queue wait, pg/lib/client.js:148 for the socket),
// so neither can fire while the event loop is blocked. Measured on deploy preview
// 1123: on a newly created function instance the loop stalls for 24.9–25.3s, the
// 3s connect budget fires at ~26s, and the retry immediately after connects in
// 327–340ms. The database was never the slow part. Nothing configurable here
// changes that number — see #1120 and #1124. The one lever that reliably helps is
// not invoking the function at all, because an ISR cache hit pays no stall.
const pgTimeoutMs = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
// `next build` statically prerenders DB-backed pages (e.g. /explore/programs),
// which connect through this same saturated pooler — but at build there is no
// user and no function ceiling, so the 3s runtime fail-fast wrongly aborts the
// prerender ("timeout exceeded when trying to connect" → build exit 2). The
// build phase gets a generous connect budget; runtime keeps the fast fail-fast.
// Env override (PG_CONNECT_TIMEOUT_MS) still wins in either phase.
const IS_NEXT_BUILD = process.env.NEXT_PHASE === "phase-production-build";
// ~3s at runtime (well under the function ceiling, above a normal cold connect);
// ~30s at build (room for a cold/saturated pooler — pre-#912 had no timeout).
const PG_CONNECT_TIMEOUT_MS = pgTimeoutMs(
  "PG_CONNECT_TIMEOUT_MS",
  IS_NEXT_BUILD ? 30000 : 3000,
);
// ~6s query budget. query_timeout is CLIENT-SIDE and is the only
// one that bounds a query *through* the txn pooler — Supavisor silently ignores
// the statement_timeout startup param (verified: SHOW statement_timeout stays at
// the 2min server default). statement_timeout is set ~1s BELOW query_timeout
// below as defense-in-depth for direct session-mode connects (DIRECT_URL :5432):
// the server then aborts first with a clean error that keeps the pooled
// connection synchronized/reusable, instead of node-postgres tearing it down on
// a client-side query_timeout.
const PG_QUERY_TIMEOUT_MS = pgTimeoutMs("PG_QUERY_TIMEOUT_MS", 6000);

const adapter = new PrismaPg({
  // Use pooled connection (DATABASE_URL) for runtime queries to avoid connection exhaustion
  // DIRECT_URL is only for migrations (handled by prisma.config.ts)
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: PG_CONNECT_TIMEOUT_MS,
  query_timeout: PG_QUERY_TIMEOUT_MS,
  // ~1s below query_timeout so the server cancels first on the direct session-mode
  // path (clean error, connection stays poolable); ignored on the txn pooler. Scales
  // down for sub-2s budgets so statement_timeout stays strictly below it (#917 review).
  statement_timeout:
    PG_QUERY_TIMEOUT_MS > 1000
      ? PG_QUERY_TIMEOUT_MS - 1000
      : Math.max(1, Math.floor(PG_QUERY_TIMEOUT_MS * 0.8)),
  // pg.Pool defaults to 10 clients PER function instance; at Netlify's 125
  // concurrent invocations that can dwarf Supavisor's client cap. Set
  // PG_POOL_MAX=1 (or 2) in serverless deploy env; unset = pg default for
  // long-lived local dev/jobs.
  ...(Number(process.env.PG_POOL_MAX) > 0
    ? { max: Number(process.env.PG_POOL_MAX) }
    : {}),
});

// Slow-query threshold (ms). A query exceeding this is logged via the
// query-event hook below so hot-path regressions surface in any environment.
const SLOW_QUERY_MS = pgTimeoutMs("PRISMA_SLOW_QUERY_MS", 500);

// #908 — the allocation write transaction. Heavy read/search/validate now runs
// OUTSIDE this txn (under the per-consultant lock), so the txn is writes-only:
// a longer maxWait can't pile up (lock + rate-limiter bound concurrency) and a
// much smaller timeout suffices than the old 120s catch-all. Env-gated so the
// serverless deploy can tune them without a code change.
export const ALLOCATION_TX_MAX_WAIT_MS = pgTimeoutMs(
  "ALLOCATION_TX_MAX_WAIT_MS",
  8000,
);
export const ALLOCATION_TX_TIMEOUT_MS = pgTimeoutMs(
  "ALLOCATION_TX_TIMEOUT_MS",
  30000,
);

function makeClient() {
  // Emit the `query` event everywhere so the slow-query hook fires in prod too;
  // keep the verbose error/warn → stdout fan-out gated to development.
  const base = new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? [
            { level: "query", emit: "event" },
            { level: "error", emit: "stdout" },
            { level: "warn", emit: "stdout" },
          ]
        : [{ level: "query", emit: "event" }, "error"],
  });

  // One line per instance boot, so the budgets this file computes are READABLE
  // from `netlify logs` instead of inferred from source. #1120 and #1124 both
  // burned time arguing about which values were live; this settles it. It is a
  // console.warn on purpose — `warn` is excluded from removeConsole (#1122), and
  // Sentry.logger would send it to Sentry rather than to the function log, which
  // is where someone reading a 30s invocation is actually looking.
  console.warn(
    `[Prisma:INIT] connect=${PG_CONNECT_TIMEOUT_MS}ms query=${PG_QUERY_TIMEOUT_MS}ms ` +
      `poolMax=${process.env.PG_POOL_MAX ?? "default"} slowQuery=${SLOW_QUERY_MS}ms ` +
      `buildPhase=${IS_NEXT_BUILD}`,
  );

  // #696 / nav-perf Phase 3 — warn on queries over the threshold so missing
  // indexes and N+1s are visible without full query logging. Sentry.logger, not
  // console: a slow query is an alertable trend, and the "lib/ convention" this
  // comment used to cite (lib/redis.ts, lib/maintenance-cron.ts) was console.warn
  // that production silently deleted anyway. See #1122.
  base.$on("query", (e) => {
    if (e.duration > SLOW_QUERY_MS) {
      Sentry.logger.warn(
        Sentry.logger
          .fmt`[Prisma:SLOW_QUERY] ${e.duration}ms (threshold ${SLOW_QUERY_MS}ms)`,
      );
    }
  });

  return base.$extends({ result: moneyResultExtensions });
}

// Helper signatures must accept the extended client — a bare PrismaClient
// re-introduces bigint money types (#780). Tx is derived from $transaction's
// callback param (not a hand-rolled Omit) so the itx client matches by type
// identity — a structural re-compare of two extended-client types blows
// TypeScript's "excessive stack depth" limit.
export type Db = ReturnType<typeof makeClient>;
export type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];
export type PrismaLike = Db | Tx;

const globalForPrisma = globalThis as unknown as {
  prisma: Db | undefined;
};

const prisma = globalForPrisma.prisma ?? makeClient();

export default prisma;

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
