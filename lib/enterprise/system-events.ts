/**
 * Recorder for platform-side operational events. Distinct from
 * `OrgAuditLog` — see SystemEvent docstring in prisma/schema.prisma.
 *
 * Use this helper from any code path that needs to capture engineering-
 * facing context (Prisma stack traces, raw HTTP responses, internal IDs)
 * without leaking that information into the org-visible audit log. The
 * org gets a clean, human-readable audit row alongside; engineering
 * queries this table.
 *
 * The helper is best-effort: a failure here must not block the calling
 * code path. We swallow + log to console so a failing system_events
 * insert doesn't take down the worker.
 */

import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import type { Prisma, SystemEventSeverity } from "@prisma/client";
import { emitTelemetryLog } from "@/lib/observability/betterstack-telemetry";

// Map the DB severity enum onto the telemetry sink's level.
function severityToTelemetryLevel(
  severity: SystemEventSeverity,
): "info" | "warn" | "error" {
  if (severity === "ERROR") return "error";
  if (severity === "WARN") return "warn";
  return "info";
}

export interface RecordSystemEventParams {
  /** Optional org scope. Platform-wide events leave this null. */
  organizationId?: string | null;
  /** Functional bucket (DATA_EXPORT / HRIS_SYNC / WEBHOOK / PAYOUT / CRON / ...). */
  category: string;
  severity?: SystemEventSeverity;
  /**
   * Engineering-grade message. Safe to include Prisma error text,
   * HTTP status codes, internal IDs. Never rendered to org users.
   */
  message: string;
  /**
   * Free-form payload — stack trace, request ID, related row IDs.
   * Stringified at write time if the caller hands a non-plain object.
   */
  context?: Record<string, unknown> | null;
  /**
   * Optional correlation ID — typically the parent job ID (e.g. the
   * `OrgDataExportJob.id` that failed). Lets engineering pull all
   * events for one invocation in a single query.
   */
  correlationId?: string | null;
  /**
   * Rethrow when the insert fails instead of swallowing it. For callers whose
   * row is the only audit trail; see the note on the function below.
   */
  strict?: boolean;
}

/**
 * Record one operational event. Best-effort by default: if the insert fails we
 * log to console and return without throwing so the caller's main
 * code path is unaffected.
 *
 * #1270 — pass `strict` when the row is an AUTHORIZATION RECORD rather than
 * telemetry. Operator access to a B2C recording has no `OrgAuditLog` to fall
 * back on, so a swallowed insert there means the read is served with no
 * persisted trail at all. Those callers need the failure, not the console line.
 */
export async function recordSystemEvent(
  params: RecordSystemEventParams,
): Promise<void> {
  const severity = params.severity ?? "INFO";
  try {
    await prisma.systemEvent.create({
      data: {
        organizationId: params.organizationId ?? null,
        category: params.category,
        severity,
        message: params.message,
        // `Record<string, unknown>` widens to Prisma's
        // `InputJsonValue` at the storage boundary. Cast is local
        // and intentional — the JSON shape is operator-defined.
        context: (params.context ?? undefined) as Prisma.InputJsonValue,
        correlationId: params.correlationId ?? null,
      },
    });
  } catch (err) {
    // The system_events insert itself failed — log and move on. An
    // outage of this table must not cascade into the calling worker.
    console.error("[recordSystemEvent] insert failed:", err);
    if (params.strict) throw err;
  }

  // Fire-and-forget telemetry sink (#776 §K). The DB row above is the source
  // of truth; this just gets the event somewhere an on-call human sees it.
  // NOT awaited — `recordSystemEvent` runs on the webhook critical path (HMAC
  // failure), so awaiting an external HTTP POST would let a stalled Better
  // Stack block/DoS the handler. No-op unless ENABLE_BETTERSTACK_TELEMETRY is
  // on; the call is internally best-effort, the `.catch` is belt-and-suspenders.
  void emitTelemetryLog({
    level: severityToTelemetryLevel(severity),
    message: params.message,
    category: params.category,
    organizationId: params.organizationId,
    correlationId: params.correlationId,
    context: params.context,
  }).catch((err) => {
    console.error("[recordSystemEvent] telemetry sink failed:", err);
  });
}

/**
 * Convenience wrapper for the common "an exception was caught"
 * pattern. Extracts the message + stack into the context payload
 * automatically.
 */
export async function recordSystemError(params: {
  organizationId?: string | null;
  category: string;
  /** Human prose summary — e.g. "Data export bundle failed". */
  summary: string;
  err: unknown;
  context?: Record<string, unknown>;
  correlationId?: string | null;
}): Promise<void> {
  const errorMessage =
    params.err instanceof Error ? params.err.message : String(params.err);
  const stack = params.err instanceof Error ? params.err.stack : undefined;

  await recordSystemEvent({
    organizationId: params.organizationId,
    category: params.category,
    severity: "ERROR",
    message: `${params.summary}: ${errorMessage}`,
    context: {
      ...(params.context ?? {}),
      errorMessage,
      ...(stack ? { stack } : {}),
    },
    correlationId: params.correlationId,
  });

  // Escalate to Sentry so engineers see it without querying the DB.
  // Best-effort: never throw. Callers of recordSystemError already swallow
  // exceptions, so a failing captureException must not change that contract.
  const errorObj =
    params.err instanceof Error ? params.err : new Error(errorMessage);
  Sentry.captureException(errorObj, {
    tags: { subsystem: "system-events", category: params.category },
    contexts: {
      systemEvent: {
        organizationId: params.organizationId ?? null,
        category: params.category,
        summary: params.summary,
        correlationId: params.correlationId ?? null,
      },
    },
  });
}

// Wave-3 hardening (#1230): ~15 call sites invoke this as
// `void recordSystemError(...)` relying on an informal never-throw contract —
// an unexpected throw (e.g. a getter blowing up inside a params spread) would
// surface as an unhandled rejection and crash the host on Node ≥15. The
// returned promise is wrapped post-hoc here so EVERY void-site is covered
// without touching each call site; awaited callers still get settled void.
export function recordSystemErrorSafe(
  params: Parameters<typeof recordSystemError>[0],
): Promise<void> {
  return recordSystemError(params).catch((err) => {
    console.error("[system-events] recordSystemError threw:", err);
  });
}
