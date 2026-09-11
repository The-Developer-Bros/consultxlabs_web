/**
 * Shared helpers for client-side `fetch` calls into our own API routes.
 *
 * Every server route returns one of two shapes:
 *
 *   200/201 →  { data: ... } | { <named-payload>: ... }
 *   4xx/5xx →  { error: string, detail?: unknown }
 *
 * The helpers below give the dashboard + wizard a single way to:
 *
 *  1. Parse the success body through a Zod schema (so drift between
 *     server response and client expectations becomes a runtime error
 *     during dev rather than an `as` cast that silently breaks UI).
 *  2. Lift `error` out of an arbitrary failure body without sprinkling
 *     `(body as any).error` everywhere.
 *
 * We deliberately keep this dependency-free besides Zod — no axios, no
 * react-query, no toast plumbing — so it can be imported by a server
 * action, a worker, or a plain `useEffect` without dragging the world.
 */

import { z } from "zod";

/**
 * The error envelope every API route returns on a non-2xx response.
 * `detail` is whatever Zod's `.flatten()` produced (or other structured
 * info); we keep it `unknown` here because each surface chooses its own
 * way to render the field-level errors.
 */
export const apiErrorSchema = z.object({
  error: z.string().optional(),
  code: z.string().optional(),
  detail: z.unknown().optional(),
});

/**
 * Lift a human-readable error message out of an arbitrary response body.
 * Falls back to `fallback` when the body doesn't match `apiErrorSchema`
 * or when the `error` field is absent — both happen when the server
 * crashes before the route handler can serialise its own error envelope.
 */
export function errorMessageFromBody(raw: unknown, fallback: string): string {
  const parsed = apiErrorSchema.safeParse(raw);
  return parsed.success && parsed.data.error ? parsed.data.error : fallback;
}

/**
 * Error thrown by {@link parseJsonResponse} when a request returns a
 * non-2xx response. Carries the HTTP status, optional machine-readable
 * `code`, and the raw `detail` envelope so callers can branch on
 * `instanceof ApiResponseError` instead of stringly-typed parsing.
 *
 * Modeled as a real class (not an interface + ad-hoc cast) so call
 * sites get full type narrowing inside `catch` blocks via `instanceof`.
 */
export class ApiResponseError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly detail?: unknown;

  constructor(
    message: string,
    init: { status: number; code?: string; detail?: unknown },
  ) {
    super(message);
    this.name = "ApiResponseError";
    this.status = init.status;
    this.code = init.code;
    this.detail = init.detail;
  }
}

/** Does this response actually claim to be JSON? */
function isJsonResponse(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").includes("json");
}

/**
 * Read a response body as JSON without ever letting markup reach `JSON.parse`,
 * and throw {@link ApiResponseError} — which carries the status — for anything
 * that is not a 2xx JSON body.
 *
 * The failure this closes: a Netlify function crash, a function timeout and a
 * middleware redirect to the sign-in page all answer with `<!DOCTYPE html>`,
 * and the redirect answers with it at status 200. A bare `res.json()` turned
 * that into `SyntaxError: Unexpected token '<'`, which the appointments page
 * then put in a toast and sent to Sentry in place of the status anyone could
 * have acted on (FAMILIARISE_WEB-1C).
 *
 * Returns the raw parsed body; callers that want a schema use
 * {@link parseJsonResponse}, which is built on this.
 */
// Distinguishes "the body parsed to a literal `null`" from "JSON.parse threw"
// — collapsing both to `null` let malformed JSON resolve as a successful
// empty response instead of throwing.
const JSON_PARSE_FAILED = Symbol("json-parse-failed");

export async function requireJsonResponse(
  res: Response,
  fallbackError = "Request failed",
): Promise<unknown> {
  const raw = isJsonResponse(res)
    ? await res.json().catch(() => JSON_PARSE_FAILED)
    : null;

  if (!res.ok) {
    const parsedErr =
      raw === JSON_PARSE_FAILED
        ? apiErrorSchema.safeParse(undefined)
        : apiErrorSchema.safeParse(raw);
    const envelope = parsedErr.success ? parsedErr.data : {};
    // Without an `error` field (a 5xx with an empty or HTML body) the status is
    // the only thing that distinguishes "the server crashed" from "validation
    // failed", so it goes in the message the user reads.
    throw new ApiResponseError(
      envelope.error ?? `${fallbackError} (HTTP ${res.status})`,
      { status: res.status, code: envelope.code, detail: envelope.detail },
    );
  }

  if (raw === JSON_PARSE_FAILED) {
    // A 2xx response that claims to be JSON but isn't valid JSON — a
    // truncated or corrupted body. Never resolve this as a successful
    // `null` payload; the caller needs the status to react correctly.
    throw new ApiResponseError(
      `${fallbackError} (HTTP ${res.status}, malformed JSON response)`,
      { status: res.status },
    );
  }

  if (raw === null && !isJsonResponse(res)) {
    // A 2xx that is not JSON is a redirect `fetch` followed for us, or a proxy
    // page wearing a success status. Neither is an answer this caller can use.
    throw new ApiResponseError(
      `${fallbackError} (HTTP ${res.status}, non-JSON response)`,
      { status: res.status },
    );
  }

  return raw;
}

/**
 * Parse a successful JSON response through a Zod schema. Throws a typed
 * error when the network call failed (`!res.ok`) using `errorMessageFromBody`,
 * and a separate Zod-formatted error when the body parsed but didn't
 * match the schema (server contract drift).
 *
 * Usage:
 *   const data = await parseJsonResponse(res, listResponseSchema);
 *
 * The generic captures the schema itself (not just `T`), so `.default()`
 * and `.transform()` modifiers flow through to the inferred output type
 * — the consumer sees `string[]` instead of `string[] | undefined` for
 * a defaulted array field, etc. If you parameterise on `z.ZodType<T>`
 * the output type widens back to the input shape and you have to `??`
 * everywhere.
 */
export async function parseJsonResponse<S extends z.ZodTypeAny>(
  res: Response,
  schema: S,
  fallbackError = "Request failed",
): Promise<z.infer<S>> {
  const raw = await requireJsonResponse(res, fallbackError);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Surfacing the issues in the error message keeps the failure mode
    // visible during dev. In production this still throws, so the
    // existing tanstack-query onError / try-catch flow renders the
    // user-facing toast — we don't want to silently fall back to the
    // raw body and let the UI render undefined.
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`Server response did not match expected shape (${issues})`);
  }
  return parsed.data;
}

/**
 * Outbound-payload guard: validate the body we're about to POST/PATCH
 * before serialising it. Throws synchronously on validation failure so
 * the call site can show an inline form error without ever opening
 * a network connection.
 *
 * The thrown Error's message lists the first few field-level issues —
 * good enough for a toast, and pre-empts the round-trip 400 the server
 * would have returned anyway.
 */
export function validateOutboundPayload<S extends z.ZodTypeAny>(
  schema: S,
  payload: unknown,
): z.infer<S> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid request payload (${issues})`);
  }
  return parsed.data;
}
