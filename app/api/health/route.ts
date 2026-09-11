import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

import { getMaintenanceState } from "@/lib/maintenance";
import { getStreamStatus } from "@/lib/stream/health";
import prisma from "@/lib/prisma";
import redis, { isMockRedis } from "@/lib/redis";

type BetterStackHealth = {
  configured: boolean;
  reachable: boolean | null;
  monitors?: { name: string; status: string }[];
};

const BETTERSTACK_CACHE_TTL_MS = 60_000;
// Module-level cache: instance-local in serverless (each cold start resets).
// Acceptable here — just prevents redundant BetterStack API calls within a warm instance.
let betterStackCache: { at: number; value: BetterStackHealth } | null = null;

async function checkBetterStack(): Promise<{
  configured: boolean;
  reachable: boolean | null;
  monitors?: { name: string; status: string }[];
}> {
  const now = Date.now();
  if (
    betterStackCache &&
    now - betterStackCache.at < BETTERSTACK_CACHE_TTL_MS
  ) {
    return betterStackCache.value;
  }

  const apiKey = process.env.BETTERSTACK_API_KEY;
  if (!apiKey) {
    const value = { configured: false, reachable: null };
    betterStackCache = { at: now, value };
    return value;
  }

  try {
    const res = await fetch("https://uptime.betterstack.com/api/v2/monitors", {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const value = { configured: true, reachable: false };
      betterStackCache = { at: now, value };
      return value;
    }

    const data = await res.json();
    const monitors = (data?.data ?? []).map(
      (m: { attributes: { url: string; status: string } }) => ({
        name: m.attributes.url,
        status: m.attributes.status,
      }),
    );

    const value = { configured: true, reachable: true, monitors };
    betterStackCache = { at: now, value };
    return value;
  } catch {
    const value = { configured: true, reachable: false };
    betterStackCache = { at: now, value };
    return value;
  }
}

// #1169/#866 — cron dead-man threshold. Every locked job run refreshes
// `cron:heartbeat:last` (lib/cron/with-cron-lock.ts); the dispatcher is
// scheduled every minute and GitHub's throttling delivers it at worst about
// every 2.75h measured, so >6h of total silence means the scheduled fleet has
// stopped — the failure the Actions-API heartbeat cannot report about itself.
const CRON_HEARTBEAT_STALE_MS = 6 * 60 * 60 * 1000;

type CronHeartbeat = {
  configured: boolean;
  lastRunAt: string | null;
  /**
   * `null` until the fleet has written its first heartbeat, or when the stored
   * timestamp will not parse. `"unknown"` when the probe itself failed, which
   * is a different fact and used to be reported as the same one: the Redis-error
   * path returned a byte-identical `{configured:true, lastRunAt:null,
   * stale:null}` to the never-run-yet path, so a monitor could not tell a fleet
   * that has never started from a heartbeat we simply could not read.
   */
  stale: boolean | "unknown" | null;
  /** True only on the probe-failed path, so an alert rule can key on it. */
  probeError?: boolean;
};

async function checkCronHeartbeat(): Promise<CronHeartbeat> {
  if (isMockRedis()) return { configured: false, lastRunAt: null, stale: null };
  try {
    const lastRunAt = await redis.get<string>("cron:heartbeat:last");
    if (!lastRunAt) return { configured: true, lastRunAt: null, stale: null };
    const age = Date.now() - Date.parse(lastRunAt);
    return {
      configured: true,
      lastRunAt,
      stale: Number.isFinite(age) ? age > CRON_HEARTBEAT_STALE_MS : null,
    };
  } catch (err) {
    Sentry.logger.warn("Cron heartbeat probe failed", {
      tags: { subsystem: "api" },
      extra: { message: err instanceof Error ? err.message : String(err) },
    });
    return {
      configured: true,
      lastRunAt: null,
      stale: "unknown",
      probeError: true,
    };
  }
}

export async function GET(request: Request) {
  const includeBetterStack =
    new URL(request.url).searchParams.get("includeBetterStack") === "1";

  let database: "connected" | "unreachable" = "connected";
  try {
    let timeoutId: ReturnType<typeof setTimeout>;
    await Promise.race([
      // ORM connectivity probe (no raw SQL) — a cheap LIMIT 1 read proves the
      // connection is alive; null (empty table) still means "connected".
      prisma.user
        .findFirst({ select: { id: true } })
        .finally(() => clearTimeout(timeoutId)),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("DB timeout")), 5000);
      }),
    ]);
  } catch (err) {
    Sentry.logger.warn("DB health probe failed", {
      tags: { subsystem: "api" },
      extra: { message: err instanceof Error ? err.message : String(err) },
    });
    database = "unreachable";
  }

  const [maintenanceState, stream, betterstack, cron] = await Promise.all([
    getMaintenanceState(),
    // #473 — the last unmet acceptance criterion on that issue. The breaker
    // existed but nothing surfaced its state, so a Stream outage was invisible
    // until users reported it.
    getStreamStatus(),
    includeBetterStack
      ? checkBetterStack()
      : Promise.resolve({
          configured: Boolean(process.env.BETTERSTACK_API_KEY),
          reachable: null,
        }),
    checkCronHeartbeat(),
  ]);

  // Stream being down degrades chat and video but leaves booking, payments and
  // every read path working, so it is reported without failing the check.
  const status = database === "unreachable" ? "degraded" : "healthy";

  return NextResponse.json({
    status,
    database,
    maintenance: {
      phase: maintenanceState.phase,
      reason: maintenanceState.reason,
      estimatedEnd: maintenanceState.estimatedEnd,
    },
    stream,
    betterstack,
    cron,
    timestamp: new Date().toISOString(),
  });
}
