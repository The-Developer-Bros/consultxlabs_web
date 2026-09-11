/**
 * Better Stack Telemetry — structured log ingest.
 *
 * Distinct from `lib/betterstack.ts`, which talks to the Uptime/Incident
 * Management API. This module ships operational events to the Better Stack
 * *Telemetry* (logs) pipeline so a failed reconcile, a stuck payout, a
 * webhook-queue backlog, or an HMAC failure can page someone — the
 * `recordSystemEvent` table alone is cold storage nobody watches (#776 §K).
 *
 * Ingest is the standard HTTP source endpoint: POST a JSON event (or array)
 * with `Authorization: Bearer <BETTERSTACK_SOURCE_TOKEN>`. The ingesting host
 * is source-specific, so it's configured via `BETTERSTACK_INGEST_URL`.
 *
 * Best-effort by contract: this must never throw into the caller. It mirrors
 * the swallow-and-console pattern of `recordSystemEvent` so an ingest outage
 * can't cascade into a worker. Gated by `ENABLE_BETTERSTACK_TELEMETRY` so it
 * stays inert (zero network calls) until a source token is provisioned.
 */

import * as Sentry from "@sentry/nextjs";
import { ENABLE_BETTERSTACK_TELEMETRY } from "@/lib/feature-flags";

type TelemetryLevel = "info" | "warn" | "error";

export interface TelemetryLog {
  level: TelemetryLevel;
  message: string;
  /** Functional bucket — mirrors SystemEvent.category (PAYOUT/RECONCILE/...). */
  category?: string;
  organizationId?: string | null;
  correlationId?: string | null;
  /** Arbitrary structured fields — flattened into the event. */
  context?: Record<string, unknown> | null;
}

/**
 * Ship one event to Better Stack Telemetry. No-op (and no network) when the
 * flag is off or the source token is unset. Never throws.
 */
export async function emitTelemetryLog(log: TelemetryLog): Promise<void> {
  if (!ENABLE_BETTERSTACK_TELEMETRY) return;

  const token = process.env.BETTERSTACK_SOURCE_TOKEN;
  const url = process.env.BETTERSTACK_INGEST_URL;
  if (!token || !url) {
    // Flag on but unconfigured — warn once-ish and move on. Don't spam.
    console.warn(
      "[BetterStack Telemetry] ENABLE_BETTERSTACK_TELEMETRY set but BETTERSTACK_SOURCE_TOKEN/BETTERSTACK_INGEST_URL missing; skipping",
    );
    return;
  }

  try {
    // `dt` is Better Stack's reserved timestamp field; the rest are free-form.
    const payload = {
      dt: new Date().toISOString(),
      level: log.level,
      message: log.message,
      ...(log.category ? { category: log.category } : {}),
      ...(log.organizationId ? { organization_id: log.organizationId } : {}),
      ...(log.correlationId ? { correlation_id: log.correlationId } : {}),
      ...(log.context ?? {}),
    };

    // Hard timeout so a stalled ingest connection can never hang/leak — even
    // though callers fire-and-forget, an unbounded fetch would pin a socket.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // Ingest is best-effort; the DB SystemEvent row is the source of truth.
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "betterstack" }, level: "warning" });
    console.error("[BetterStack Telemetry] ingest failed:", err);
  }
}
