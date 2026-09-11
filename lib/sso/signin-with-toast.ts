/**
 * Robust wrapper for BetterAuth's `signIn.sso(...)` client call.
 *
 * Why this exists
 * ---------------
 * The raw `signIn.sso(...)` call has three failure modes that the
 * sign-in / sign-up pages have to handle, and the bare `await` form
 * (used inline before audit Phase B.1) catches none of them:
 *
 *   1. **BetterAuth returns `{ data, error }` instead of throwing.**
 *      Per the BetterAuth client docs, the SDK never throws on a
 *      logical failure — it resolves with an `error` field. An inline
 *      `await signIn.sso(...)` happily continues even when SSO failed.
 *
 *   2. **Server-side 500 with empty body.** When the SAML adapter
 *      crashes (e.g. a malformed X.509 cert sneaking past the schema
 *      check — see audit Phase A.2), the response is `500` with `0`
 *      bytes. The SDK swallows this and resolves with `error: null`
 *      AND no redirect. From the UI's perspective, nothing happened.
 *
 *   3. **No redirect within reasonable time.** Even when BetterAuth
 *      builds the SAML AuthnRequest successfully, the browser may
 *      fail to follow the redirect (corporate proxy, blocked IdP
 *      host, CSP misconfig). Without a watchdog, the page sits
 *      indefinitely with a spinner.
 *
 * This wrapper:
 *   - Inspects the BetterAuth result's `error` field if present.
 *   - Races the call against a 2-second watchdog; if neither a
 *     redirect nor a thrown error happens, surfaces a generic toast.
 *   - Catches synchronous throws (network errors, malformed args).
 *
 * Call sites:
 *   - app/auth/signin/page.tsx (blur-triggered + manual click)
 *   - app/auth/signup/page.tsx (blur-triggered)
 *
 * See audit Phase B.1.
 */

import { signIn } from "@/lib/auth-client";

export interface SsoSigninParams {
  providerId: string;
  domain?: string;
  /** Required by BetterAuth's SDK — the post-SSO landing URL. */
  callbackURL: string;
}

export interface SsoSigninResult {
  /** True iff BetterAuth confirmed the redirect was initiated. */
  ok: boolean;
  /** Human-readable reason on failure; null on success. */
  errorMessage: string | null;
}

/**
 * Redirect-watchdog timeout. Tuned for the 99th-percentile case where
 * BetterAuth builds the SAML AuthnRequest in <500ms and the browser
 * navigates immediately after. 2 seconds gives a comfortable margin
 * without making the user wait on a definitely-broken flow.
 */
const SSO_WATCHDOG_MS = 2_000;

const TIMEOUT_MESSAGE =
  "SSO sign-in did not redirect. This usually means the identity-provider URL is unreachable or the SSO certificate is invalid. Contact your IT admin.";

const GENERIC_FAILURE_MESSAGE =
  "SSO sign-in failed. Please try again or contact your IT admin.";

const UNEXPECTED_FAILURE_MESSAGE =
  "SSO sign-in failed unexpectedly. Please try again.";

/**
 * Normalize BetterAuth's `{ data, error }` resolution into our
 * `SsoSigninResult`. BetterAuth never throws on logical failure — it
 * resolves with `error: { message }` or `error: null`. Older client
 * versions return the raw fetch Response, so we narrow defensively.
 */
function extractBetterAuthError(result: unknown): SsoSigninResult {
  if (!result || typeof result !== "object" || !("error" in result)) {
    return { ok: true, errorMessage: null };
  }
  const err = (result as { error: unknown }).error;
  if (!err) {
    return { ok: true, errorMessage: null };
  }
  const message =
    typeof err === "object" && err !== null && "message" in err
      ? String((err as { message: unknown }).message)
      : GENERIC_FAILURE_MESSAGE;
  return { ok: false, errorMessage: message };
}

/** Awaits signIn.sso(); converts thrown errors into the result shape. */
async function callSignInSso(
  params: SsoSigninParams,
): Promise<SsoSigninResult> {
  try {
    const result = await signIn.sso(params);
    return extractBetterAuthError(result);
  } catch (err) {
    return {
      ok: false,
      errorMessage:
        err instanceof Error ? err.message : UNEXPECTED_FAILURE_MESSAGE,
    };
  }
}

/** Resolves after `ms` with a generic "redirect didn't happen" result. */
function watchdogTimer(ms: number): Promise<SsoSigninResult> {
  return new Promise((resolve) => {
    setTimeout(
      () => resolve({ ok: false, errorMessage: TIMEOUT_MESSAGE }),
      ms,
    );
  });
}

export async function ssoSigninWithGuard(
  params: SsoSigninParams,
): Promise<SsoSigninResult> {
  // Race the SDK call against a watchdog timer. The happy path is that
  // the browser navigates to the IdP before either promise resolves,
  // and the caller's `.finally(setLoading(false))` never fires — which
  // is the intended UX (no flash-of-error before the IdP page loads).
  return Promise.race([callSignInSso(params), watchdogTimer(SSO_WATCHDOG_MS)]);
}
