/**
 * Shared Sentry capture helper — every call site in the codebase used to
 * repeat "normalize to Error, stamp subsystem/op/expected tags, pick a level"
 * inline (~80 sites, see PR #1062). Extracted once so that shape lives here.
 */

import * as Sentry from "@sentry/nextjs";
import type { SeverityLevel } from "@sentry/nextjs";

export interface ReportOpts {
  subsystem: string;
  op?: string;
  /** true = a modelled outcome (an ANSWER, not a fault). Defaults to false. */
  expected?: boolean;
  /** Overrides the level derived from `expected`. */
  level?: SeverityLevel;
  extra?: Record<string, unknown>;
  /** Merged over the derived subsystem/op/expected tags — can override any of them. */
  tags?: Record<string, string>;
  contexts?: Record<string, Record<string, unknown>>;
}

function buildSentryCaptureContext(opts: ReportOpts) {
  const expected = opts.expected ?? false;
  // expected:true defaults to "info"; expected:false leaves level unset so
  // Sentry's own default ("error") applies. An explicit opts.level always wins.
  const level = opts.level ?? (expected ? "info" : undefined);
  return {
    tags: {
      subsystem: opts.subsystem,
      ...(opts.op ? { op: opts.op } : {}),
      expected: String(expected),
      ...opts.tags,
    },
    ...(level ? { level } : {}),
    ...(opts.extra ? { extra: opts.extra } : {}),
    ...(opts.contexts ? { contexts: opts.contexts } : {}),
  };
}

// FAMILIARISE_WEB-36: a thrown plain object (Razorpay's `{ statusCode, error }`)
// stringified to "[object Object]"; prefer its own description/message/code.
function normaliseError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    const nested = obj.error as Record<string, unknown> | undefined;
    const statusCode = obj.statusCode;
    const detail =
      nested?.description ??
      obj.description ??
      nested?.message ??
      obj.message ??
      nested?.code ??
      obj.code;
    if (typeof detail === "string" || typeof detail === "number") {
      const withStatus =
        statusCode !== undefined
          ? `${detail} (statusCode: ${statusCode})`
          : String(detail);
      return new Error(withStatus);
    }
    try {
      return new Error(JSON.stringify(obj).slice(0, 500));
    } catch {
      return new Error(Object.prototype.toString.call(obj));
    }
  }
  return new Error(String(error));
}

/** Report a caught fault or modelled outcome. Normalises non-Error throws. */
export function reportSentryError(error: unknown, opts: ReportOpts): void {
  const normalised = normaliseError(error);
  Sentry.captureException(normalised, {
    ...buildSentryCaptureContext(opts),
    extra: { ...(opts.extra ?? {}), thrown: error },
  });
}

/** Sibling of `reportSentryError` for sites with no exception object to attach — idempotency short-circuits, race-losses, malformed-input rejections. */
export function reportSentryMessage(message: string, opts: ReportOpts): void {
  Sentry.captureMessage(message, buildSentryCaptureContext(opts));
}
