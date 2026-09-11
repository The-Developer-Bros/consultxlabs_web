/**
 * Marks a thrown error as a modelled outcome rather than a fault.
 *
 * `reportSentryError` tags its own captures, but an error that escapes a server
 * action or a route handler is captured by Next's `onRequestError` hook, which
 * takes no per-call options. The marker therefore rides on the error object and
 * `sentry.shared.config.ts` stamps `expected:true` in `beforeSend`, so a guard
 * that fired by design lands at warning instead of paging (FAMILIARISE_WEB-10).
 *
 * Deliberately dependency-free: the Sentry config imports it during init, and a
 * non-enumerable symbol keeps the marker out of JSON serialisation and out of
 * anything that spreads the error.
 */

const EXPECTED_ERROR = Symbol.for("familiarise.observability.expectedError");

export function markExpected<E extends Error>(error: E): E {
  Object.defineProperty(error, EXPECTED_ERROR, {
    value: true,
    enumerable: false,
  });
  return error;
}

export function isExpectedError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as Record<symbol, unknown>)[EXPECTED_ERROR] === true
  );
}
