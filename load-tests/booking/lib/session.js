// Authentication for the load gate.
//
// The harness reuses the race-condition suite's approach — a Better Auth
// session cookie obtained from `POST /api/auth/sign-in/email` and replayed on
// every subsequent request — rather than an API token, because this codebase
// has no machine-token rail: `requireApiAuth` and `getSession` both read the
// Better Auth session, so a cookie is the only credential the write routes
// accept. See tests/typescript/race-conditions/utilities/api-client.ts.
//
// Two constraints shape everything here:
//
//   1. The sign-in limiter is 10 requests per 15 minutes per IP (Upstash-backed,
//      configured in middleware.ts because Better Auth's own limiter is
//      per-process and useless on Netlify). A k6 run comes from ONE IP, so the
//      harness may mint at most a handful of cookies and MUST do it once in
//      setup(), never per VU.
//   2. Better Auth checks Origin against BETTER_AUTH_TRUSTED_ORIGINS, which
//      holds the production URL in every Netlify context. Signing in against a
//      deploy preview with the preview's own Origin answers 403 INVALID_ORIGIN,
//      so AUTH_ORIGIN is sent instead of BASE_URL.
//
// Supplying BUYER_COOKIES / ORG_ADMIN_COOKIES skips sign-in entirely and is the
// recommended input for a real gate run.

import http from "k6/http";
import {
  AUTH_ORIGIN,
  BASE_URL,
  BUYER_COOKIES,
  BUYER_EMAILS,
  BUYER_PASSWORD,
  CONSULTANT_COOKIES,
  ORG_ADMIN_COOKIES,
  ORG_ADMIN_EMAILS,
} from "./config.js";

const SESSION_COOKIE_NAME = "better-auth.session_token";

/** Sign in once and return the full cookie header value for that session. */
function signIn(email, password) {
  const res = http.post(
    `${BASE_URL}/api/auth/sign-in/email`,
    JSON.stringify({ email, password }),
    {
      headers: { "Content-Type": "application/json", Origin: AUTH_ORIGIN },
      tags: { path: "auth_sign_in" },
    },
  );
  if (res.status !== 200) {
    throw new Error(
      `sign-in for ${email} answered ${res.status}: ${String(res.body).slice(0, 300)}`,
    );
  }
  // Better Auth may set a companion `.session_data` cookie when the cookie
  // cache is on, and dropping it costs a database round trip per request, so
  // every cookie on the response is replayed rather than just the token.
  const pairs = [];
  for (const name of Object.keys(res.cookies)) {
    const value = res.cookies[name]?.[0]?.value;
    if (value) pairs.push(`${name}=${value}`);
  }
  if (!pairs.some((pair) => pair.startsWith(`${SESSION_COOKIE_NAME}=`))) {
    throw new Error(
      `sign-in for ${email} returned no ${SESSION_COOKIE_NAME} cookie`,
    );
  }
  return pairs.join("; ");
}

/**
 * Build one credential pool. Pre-minted cookies win; emails are only signed in
 * when no cookie was supplied, and the count is capped so a run cannot exhaust
 * the 10-per-15-minutes budget and leave the next attempt locked out.
 */
function buildPool(label, cookies, emails, password, maxLogins) {
  if (cookies.length > 0) {
    console.log(
      `${label}: using ${cookies.length} pre-minted session cookie(s)`,
    );
    return cookies;
  }
  if (emails.length === 0) {
    return [];
  }
  const usable = emails.slice(0, maxLogins);
  if (usable.length < emails.length) {
    console.warn(
      `${label}: ${emails.length} emails supplied but only ${maxLogins} will be signed in — the auth limiter is 10 per 15 minutes per IP. Supply pre-minted cookies to use them all.`,
    );
  }
  const pool = usable.map((email) => signIn(email, password));
  console.log(`${label}: signed in ${pool.length} account(s)`);
  return pool;
}

/**
 * Called from setup(). Returns the credential pools every VU shares. The two
 * pools are budgeted separately out of the same limiter allowance: at most four
 * buyer logins and at most four org-admin logins, leaving two attempts of
 * headroom for a retry.
 */
export function establishSessions() {
  const buyers = buildPool(
    "buyers",
    BUYER_COOKIES,
    BUYER_EMAILS,
    BUYER_PASSWORD,
    4,
  );
  const orgAdmins = buildPool(
    "org admins",
    ORG_ADMIN_COOKIES,
    ORG_ADMIN_EMAILS,
    BUYER_PASSWORD,
    4,
  );
  if (buyers.length === 0) {
    throw new Error(
      "No buyer credentials — set BUYER_COOKIES (preferred) or BUYER_EMAILS.",
    );
  }
  // Cookie-only: the sign-in allowance is already committed to the two pools
  // above, so there is no e-mail fallback to mint a consultant with.
  if (CONSULTANT_COOKIES.length > 0) {
    console.log(
      `consultants: using ${CONSULTANT_COOKIES.length} pre-minted session cookie(s)`,
    );
  }
  return { buyers, orgAdmins, consultants: CONSULTANT_COOKIES };
}

/**
 * Pick a credential for this virtual user. Spreading VUs across the pool
 * matters for more than realism: the checkout limiter keys on the user id at 5
 * per minute, and the consultee booking lock is per account, so a single
 * identity would measure those two guards instead of the booking path.
 */
export function pick(pool, index) {
  if (!pool || pool.length === 0) return null;
  return pool[index % pool.length];
}
