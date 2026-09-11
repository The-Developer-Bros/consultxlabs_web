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
  VALIDATION_FAILED:
    "Some details are missing or invalid. Please check and retry.",
  NOT_FOUND: "We couldn't find that anymore — it may have been removed.",
  FORBIDDEN:
    "That option isn't available for your role on this session. You can raise a concern or a billing question about it.",
  RATE_LIMITED:
    "You're doing that a bit too quickly — try again in a few minutes.",
  CONFLICT: "That was just updated somewhere else. Refresh and try again.",
  INTERNAL: "Something went wrong on our side. Please try again in a moment.",
};

export interface SupportErrorPayload {
  code?: string;
  error?: string;
  detail?: unknown;
}

/** Parse a failed response into the envelope (never throws on bad JSON). */
export async function readSupportError(
  res: Response,
): Promise<SupportErrorPayload> {
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
export class SupportRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
  }
  /** A refusal the server will repeat verbatim: retrying cannot help. */
  get isDefinite(): boolean {
    return this.status === 403 || this.status === 404 || this.status === 400;
  }
}

export async function throwSupportError(
  res: Response,
  context: string,
): Promise<never> {
  const payload = await readSupportError(res);
  console.error(`[support] ${context} failed`, res.status, payload);
  throw new SupportRequestError(
    describeSupportError(payload),
    res.status,
    payload.code,
  );
}
