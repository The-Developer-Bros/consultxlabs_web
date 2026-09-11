import { NextResponse } from "next/server";

/**
 * Shared input bounds for consumer-facing mutation routes (#831).
 *
 * Every user-typed string must carry a `.max()` — unbounded text is a
 * 10MB-payload DoS surface (Postgres TOAST bloat + log amplification).
 * One constant block so the numbers stay uniform across schemas.
 */
export const MAX_TITLE_LENGTH = 200;
export const MAX_TEXT_LENGTH = 2_000;
export const MAX_SHORT_FIELD_LENGTH = 50;

/** Default request-body ceiling for JSON mutation routes. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Reject oversized request bodies before parsing (#831).
 * Returns a 413 NextResponse when content-length exceeds the cap, else null.
 * Content-length is attacker-suppliable but Netlify enforces it on the
 * function payload, so a lying header still cannot smuggle a larger body.
 */
export function assertBodySize(
  req: { headers: { get(name: string): string | null } },
  maxBytes: number = MAX_BODY_BYTES,
): NextResponse | null {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(len) && len > maxBytes) {
    return NextResponse.json(
      { error: "Request body too large" },
      { status: 413 },
    );
  }
  return null;
}
