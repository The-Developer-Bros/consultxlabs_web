/**
 * What a browser catch block should show a user, and what it should send us.
 *
 * Every `catch` on a client interaction in this codebase used to end with
 * `error instanceof Error ? error.message : "Unknown error"`, which puts
 * whatever text happened to be thrown in front of a consultant. Two of those
 * are actively bad:
 *
 * - A stale-deploy chunk error. We ship, Netlify swaps the bundle, and an
 *   already-open tab's next `import()` asks for a hash that no longer exists:
 *   "Loading chunk 99515 failed." The user reads a bundler internal for
 *   something a refresh fixes outright. Every dynamic import in the app can
 *   hit this — the join path is only the first because it `import()`s the
 *   Stream SDK at click time.
 * - A Next server-action failure, whose production message is "An error
 *   occurred in the Server Components render. The specific message is omitted
 *   in production builds…". It tells the user nothing and implies something is
 *   broken in a way they cannot address.
 *
 * So the two audiences are split deliberately: the toast gets a short human
 * sentence, and the original error — with its `digest` and whatever context
 * the call site knows — goes to Sentry.
 */

import { reportSentryError } from "@/lib/observability/report";

/**
 * A message WE authored, for a condition we model on purpose (maintenance, a
 * session that has ended). Safe to show verbatim, and the reason this module
 * does not simply hide every message it is handed.
 */
const USER_FACING_ERROR_NAME = "UserFacingError";

/** Throw this when the message is meant for the person who will read it. */
export function userFacingError(message: string): Error {
  const error = new Error(message);
  error.name = USER_FACING_ERROR_NAME;
  return error;
}

export function isUserFacingError(error: unknown): boolean {
  return error instanceof Error && error.name === USER_FACING_ERROR_NAME;
}

/**
 * A failed dynamic import. Spelled differently by every bundler and engine, so
 * matched by shape rather than by the one string we happened to see:
 * webpack raises a named `ChunkLoadError`, native ESM raises a plain TypeError
 * whose wording differs across Chrome, Firefox and Safari.
 */
const CHUNK_ERROR_PATTERNS = [
  /loading (css )?chunk \S+ failed/i,
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /unable to preload css/i,
];

/** Walks `cause`, so a wrapped chunk failure is still recognised as one. */
function* errorChain(error: unknown): Generator<unknown> {
  let current = error;
  // Bounded: a malformed `cause` cycle must not hang the catch block.
  for (let depth = 0; depth < 5 && current; depth += 1) {
    yield current;
    current = current instanceof Error ? current.cause : undefined;
  }
}

/** Does a page reload genuinely fix this? Only true for a stale deploy. */
export function isChunkLoadError(error: unknown): boolean {
  for (const link of errorChain(error)) {
    if (link instanceof Error && link.name === "ChunkLoadError") return true;
    const message =
      link instanceof Error
        ? link.message
        : typeof link === "string"
          ? link
          : "";
    if (CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
      return true;
    }
  }
  return false;
}

export type ClientFailureKind = "stale-deploy" | "refusal" | "unknown";

export interface ClientFailure {
  kind: ClientFailureKind;
  title: string;
  /** Never the raw error text unless we wrote it. */
  description: string;
  /** True when a reload is the actual fix, so the toast can offer one. */
  offerReload: boolean;
}

export interface DescribeClientFailureOpts {
  /** Toast title for the generic case, e.g. "Error joining meeting". */
  title: string;
}

/** Pure half: classify a caught value into what the user should read. */
export function describeClientFailure(
  error: unknown,
  { title }: DescribeClientFailureOpts,
): ClientFailure {
  if (isChunkLoadError(error)) {
    return {
      kind: "stale-deploy",
      title: "The app was updated",
      description: "This tab is running an older version. Refresh to continue.",
      offerReload: true,
    };
  }

  if (isUserFacingError(error)) {
    return {
      kind: "refusal",
      title,
      description: (error as Error).message,
      offerReload: false,
    };
  }

  return {
    kind: "unknown",
    title,
    description:
      "Something went wrong on our side. Please try again in a moment — we have been notified.",
    offerReload: false,
  };
}

export interface ReportClientFailureOpts extends DescribeClientFailureOpts {
  subsystem: string;
  op?: string;
  /** Whatever the call site knows: slot id, appointment id, event id. */
  extra?: Record<string, unknown>;
}

/**
 * Classify, report, and hand back the copy to render.
 *
 * A stale deploy is an expected consequence of shipping and a refusal is a
 * modelled outcome, so both go in at `info` with `expected: "true"` rather
 * than paging anyone. Only the unknown case is an error.
 */
export function reportClientFailure(
  error: unknown,
  { subsystem, op, extra, title }: ReportClientFailureOpts,
): ClientFailure {
  const failure = describeClientFailure(error, { title });
  const digest =
    error instanceof Error && "digest" in error
      ? (error as Error & { digest?: unknown }).digest
      : undefined;

  reportSentryError(error, {
    subsystem,
    op,
    expected: failure.kind !== "unknown",
    tags: { failureKind: failure.kind },
    extra: {
      ...extra,
      // The message stays here rather than in the toast. `digest` is the only
      // handle on a Next server-action failure, whose message is omitted in
      // production builds — losing it makes the next one undiagnosable.
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
      ...(digest !== undefined ? { digest } : {}),
    },
  });

  return failure;
}
