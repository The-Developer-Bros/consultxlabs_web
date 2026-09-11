// Tagged HTTP helpers.
//
// Every request carries a `path` tag so the summary can report latency and
// outcome counts per write path rather than as one undifferentiated blob, and
// every mutating request carries a unique idempotency credential:
//
//   - checkout reads `clientIdempotencyKey` from the BODY (#828). A duplicate
//     replays the first attempt's response instead of minting a second order,
//     so a load test that reused one key would measure the replay cache.
//   - the allocate routes read the `Idempotency-Key` HEADER (#837).
//
// Both are sent on every request regardless of which the route consults, so a
// script pointed at the wrong path still cannot double-apply.

import http from "k6/http";
import { AUTH_ORIGIN, BASE_URL } from "./config.js";

/**
 * One identifier per run, so keys from two runs against the same database can
 * never collide and a run's rows are greppable after the fact.
 */
export const RUN_ID = `lg${Date.now().toString(36)}`;

let counter = 0;

/** Unique per request, 8–128 chars, matching the checkout schema's bounds. */
export function idempotencyKey(prefix) {
  counter += 1;
  return `${RUN_ID}-${prefix}-${__VU}-${__ITER}-${counter}`;
}

function headersFor(cookie, key) {
  const headers = {
    "Content-Type": "application/json",
    // The same trusted-origin problem the sign-in has: a preview's own origin
    // is not on the trusted list, and some Better Auth paths check it.
    Origin: AUTH_ORIGIN,
    "Idempotency-Key": key,
  };
  if (cookie) headers.Cookie = cookie;
  return headers;
}

export function post(path, body, { cookie, tag, key }) {
  const idem = key || idempotencyKey(tag || "post");
  return http.post(`${BASE_URL}${path}`, JSON.stringify(body), {
    headers: headersFor(cookie, idem),
    tags: { path: tag || path },
    // Well under the ~26s Netlify function ceiling would hide the exact failure
    // this gate exists to catch, so the client waits longer than the platform
    // will and lets the 504 arrive as a 504.
    timeout: "60s",
  });
}

export function patch(path, body, { cookie, tag, key }) {
  const idem = key || idempotencyKey(tag || "patch");
  return http.patch(`${BASE_URL}${path}`, JSON.stringify(body), {
    headers: headersFor(cookie, idem),
    tags: { path: tag || path },
    timeout: "60s",
  });
}

export function del(path, { cookie, tag }) {
  return http.del(`${BASE_URL}${path}`, null, {
    headers: headersFor(cookie, idempotencyKey(tag || "delete")),
    tags: { path: tag || path },
    timeout: "60s",
  });
}

export function get(path, { cookie, tag } = {}) {
  const headers = { Origin: AUTH_ORIGIN };
  if (cookie) headers.Cookie = cookie;
  return http.get(`${BASE_URL}${path}`, {
    headers,
    tags: { path: tag || path },
    timeout: "60s",
  });
}

/** Parse a JSON body without throwing on an HTML error page. */
export function json(res) {
  try {
    return res.json();
  } catch {
    return null;
  }
}

/** Pick a deterministic-but-spread element for this VU/iteration. */
export function rotate(items, offset) {
  if (!items || items.length === 0) return null;
  return items[Math.abs(offset) % items.length];
}
