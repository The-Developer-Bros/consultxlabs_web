/**
 * Safe JSON parsing for the slot-availability grid.
 *
 * Hotfix context: `GET /api/slots/availability-with-allocation/[consultantId]`
 * is O(window width) CPU (`processAvailabilitySlots`). A wide window (full
 * 1/6/12-month scheduling period) exceeds the ~26s Netlify function ceiling,
 * and the platform substitutes a `text/plain` body such as
 * "the edge function timed out". Every caller used to do blind
 * `await response.json()` twice, so that plain-text body threw
 * `SyntaxError: Unexpected token 'h', "the edge fu..." is not valid JSON`,
 * surfaced to users as "Error fetching slots".
 *
 * This helper reads the body as text first, then JSON-parses defensively and
 * maps platform timeouts / non-JSON bodies to a retryable, user-friendly
 * error instead of the raw SyntaxError. No schema change, no money-path touch.
 */

/** Max window the grid endpoint will compute. Mirrors the server clamp. */
export const MAX_AVAILABILITY_WINDOW_DAYS = 31;

/** Friendly copy shown when the grid times out at the platform edge. */
export const SLOT_GRID_TIMEOUT_MESSAGE =
  "Slots are taking too long to load. Please retry or pick another day.";

/** Error code for timeout / non-JSON grid responses. */
export const SLOT_GRID_TIMEOUT_CODE = "SLOT_GRID_TIMEOUT";

/** Error code for windows wider than MAX_AVAILABILITY_WINDOW_DAYS. */
export const SLOT_GRID_WINDOW_TOO_LARGE_CODE = "WINDOW_TOO_LARGE";

function isPlatformTimeoutText(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    t.startsWith("the edge fu") ||
    t.includes("edge function timed out") ||
    t.includes("function timed out") ||
    t === "timeout" ||
    t.includes("gateway timeout")
  );
}

/**
 * Read a fetch Response as JSON without ever throwing the raw
 * `Unexpected token 'h'...` SyntaxError at the caller.
 *
 * - 204/304 (no body) resolve to `null` so callers keep their 304 fast-path.
 * - JSON bodies (even error JSON on !ok) resolve to the parsed value.
 * - Plain-text platform timeouts reject with SLOT_GRID_TIMEOUT_MESSAGE.
 * - Other non-JSON bodies reject with `fallbackMessage`.
 */
export async function readJsonSafe<T = unknown>(
  res: Response,
  fallbackMessage = "Failed to fetch availability slots",
): Promise<T> {
  if (res.status === 204 || res.status === 304) {
    return null as T;
  }
  const text = await res.text();
  if (!text) {
    throw Object.assign(new Error(fallbackMessage), {
      code: res.ok ? "EMPTY_RESPONSE" : SLOT_GRID_TIMEOUT_CODE,
      httpStatus: res.status,
      retryable: !res.ok,
    });
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    if (!res.ok && isPlatformTimeoutText(text)) {
      throw Object.assign(new Error(SLOT_GRID_TIMEOUT_MESSAGE), {
        code: SLOT_GRID_TIMEOUT_CODE,
        httpStatus: res.status,
        retryable: true,
      });
    }
    // Success-status non-JSON is a contract break; failure-status non-JSON
    // (429 HTML, 502/504 gateway text) is retryable.
    throw Object.assign(
      new Error(
        !res.ok && (res.status === 429 || res.status >= 500)
          ? SLOT_GRID_TIMEOUT_MESSAGE
          : fallbackMessage,
      ),
      {
        code: SLOT_GRID_TIMEOUT_CODE,
        httpStatus: res.status,
        retryable: !res.ok,
      },
    );
  }
}

/**
 * Read the `{ data }` / `{ error }` envelope the slot routes return.
 * On !ok with JSON `{ error }`, throws that message (preserving httpStatus).
 * On non-JSON (platform timeout), throws the friendly retry message.
 */
export async function readSlotGridEnvelope<T = unknown>(
  res: Response,
  fallbackMessage = "Failed to fetch availability slots",
): Promise<T> {
  const body = await readJsonSafe<{ data?: T; error?: string }>(
    res,
    fallbackMessage,
  );
  if (!res.ok) {
    throw Object.assign(
      new Error(
        (body && body.error) ||
          (res.status === 429 || res.status >= 500
            ? SLOT_GRID_TIMEOUT_MESSAGE
            : fallbackMessage),
      ),
      { httpStatus: res.status, retryable: res.status === 429 || res.status >= 500 },
    );
  }
  return (body?.data ?? body) as T;
}

/** True when an error is the friendly retryable timeout (not a bug). */
export function isSlotGridTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === SLOT_GRID_TIMEOUT_CODE) return true;
  return (
    typeof e.message === "string" &&
    (e.message.includes("the edge fu") ||
      e.message.includes("edge function timed out") ||
      e.message.startsWith("Unexpected token 'h'"))
  );
}

/** Map any fetch failure to user-facing copy (timeout → retry message). */
export function toFriendlySlotError(
  error: unknown,
  fallback = "Failed to fetch availability slots",
): string {
  if (error instanceof Error) {
    if (isSlotGridTimeout(error)) return SLOT_GRID_TIMEOUT_MESSAGE;
    // A SyntaxError that slipped through (old code path) still reads as timeout.
    if (
      error.name === "SyntaxError" &&
      error.message.includes("is not valid JSON")
    ) {
      return SLOT_GRID_TIMEOUT_MESSAGE;
    }
    return error.message || fallback;
  }
  return fallback;
}
