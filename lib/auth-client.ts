import { createAuthClient } from "better-auth/react";
import { customSessionClient } from "better-auth/client/plugins";
import { ssoClient } from "@better-auth/sso/client";
import type { auth } from "@/lib/auth";
import { forgetAuthState } from "@/lib/auth-broadcast";

export const authClient = createAuthClient({
  // Empty string would be a truthy-enough config that breaks URL resolution;
  // coerce to undefined so BetterAuth falls back to the same-origin /api/auth.
  baseURL: process.env.NEXT_PUBLIC_APP_URL || undefined,
  // ssoClient exposes authClient.signIn.sso(), which generates the OIDC PKCE
  // code_verifier/code_challenge pair and persists the verifier so the
  // callback can validate it. A raw POST to /api/auth/sign-in/sso would
  // skip PKCE entirely and break Auth0 / Okta OIDC / Azure AD OIDC flows.
  plugins: [customSessionClient<typeof auth>(), ssoClient()],
});

export const { signIn, signUp, useSession, getSession, sendVerificationEmail } =
  authClient;

/**
 * `signOut` is wrapped so the navbar's remembered auth state (name + avatar in
 * localStorage) can never outlive the session on a shared device. Every
 * sign-out call site in the app imports this binding rather than
 * `authClient.signOut`, so clearing here covers all of them — including the
 * paths that hard-navigate away before any effect could run. Clearing before
 * the request also fails safe: if the request errors the next resolved session
 * simply rewrites the cache.
 *
 * Asserted rather than annotated because BetterAuth's `signOut` is generic in
 * its fetch options; a spread wrapper erases that generic and the contextual
 * annotation then fails to match. The runtime behaviour is a straight
 * pass-through, so the assertion is the honest description.
 */
export const signOut = ((...args: Parameters<typeof authClient.signOut>) => {
  forgetAuthState();
  return authClient.signOut(...args);
}) as typeof authClient.signOut;
