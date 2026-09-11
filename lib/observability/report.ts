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

/** Report a caught fault or modelled outcome. Normalises non-Error throws. */
export function reportSentryError(error: unknown, opts: ReportOpts): void {
  Sentry.captureException(
    error instanceof Error ? error : new Error(String(error)),
    buildSentryCaptureContext(opts),
  );
}

/** Sibling of `reportSentryError` for sites with no exception object to attach — idempotency short-circuits, race-losses, malformed-input rejections. */
export function reportSentryMessage(message: string, opts: ReportOpts): void {
  Sentry.captureMessage(message, buildSentryCaptureContext(opts));
}
