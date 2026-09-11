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
export function errorMessageFromBody(
  raw: unknown,
  fallback: string,
): string {
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
  const raw = await res.json().catch(() => null);
  if (!res.ok) {
    const parsedErr = apiErrorSchema.safeParse(raw);
    const envelope = parsedErr.success ? parsedErr.data : {};
    // When the server didn't include an `error` field (typically a 5xx
    // with empty/HTML body), append the HTTP status so the toast at
    // least pinpoints "the server crashed" vs "validation failed". This
    // is what made the old fallback "Failed to create organization"
    // actively misleading — every cause produced the same string.
    const message = envelope.error ?? `${fallbackError} (HTTP ${res.status})`;
    throw new ApiResponseError(message, {
      status: res.status,
      code: envelope.code,
      detail: envelope.detail,
    });
  }
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
    throw new Error(
      `Server response did not match expected shape (${issues})`,
    );
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
