/**
 * #support-hub — client-side error presentation.
 *
 * The server's error envelope is `{ error, code, detail? }` where `error` is
 * already user-safe. This mapper prefers CODE-specific copy (richer, action-
 * oriented), falls back to the server's message, and never surfaces `detail` —
 * that's developer material: log the raw payload to the console and let Sentry
 * carry it (see lib/api/support-http.ts).
 */

const FRIENDLY_COPY: Record<string, string> = {
  UNAUTHORIZED: "Please sign in and try again.",
  INVALID_ID:
    "This session's link looks broken. Open it from your Appointments page and try again.",
  VALIDATION_FAILED: "Some details are missing or invalid. Please check and retry.",
  NOT_FOUND: "We couldn't find that anymore — it may have been removed.",
  FORBIDDEN: "You don't have access to help for this session.",
  RATE_LIMITED: "You're doing that a bit too quickly — try again in a few minutes.",
  CONFLICT: "That was just updated somewhere else. Refresh and try again.",
  INTERNAL: "Something went wrong on our side. Please try again in a moment.",
};

export interface SupportErrorPayload {
  code?: string;
  error?: string;
  detail?: unknown;
}

/** Parse a failed response into the envelope (never throws on bad JSON). */
export async function readSupportError(res: Response): Promise<SupportErrorPayload> {
  return res.json().catch(() => ({}));
}

/**
 * User-facing message for a toast. Developer workflow: the caller logs the raw
 * payload (with status) to the console BEFORE calling this.
 */
export function describeSupportError(
  payload: SupportErrorPayload | null,
  fallback = "Something went wrong. Please try again.",
): string {
  const code = payload?.code;
  if (code && FRIENDLY_COPY[code]) return FRIENDLY_COPY[code];
  // Legacy/unknown paths: the server's `error` is still user-phrased.
  return payload?.error ?? fallback;
}

/** Throw-ready helper for react-query mutationFns: friendly message out,
 *  raw payload to the console for whoever opens devtools. */
export async function throwSupportError(res: Response, context: string): Promise<never> {
  const payload = await readSupportError(res);
  console.error(`[support] ${context} failed`, res.status, payload);
  throw new Error(describeSupportError(payload));
}
