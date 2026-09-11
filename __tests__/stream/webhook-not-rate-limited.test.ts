/**
 * @jest-environment node
 */

/**
 * #1134 P1-11 — the Stream webhook endpoint must not be edge rate-limited.
 *
 * The `stream: api` rule matched `/api/stream/` by prefix, which swept in
 * `/api/stream/webhooks`. That is a worse failure than it sounds:
 *
 *   - Stream POSTs every delivery from its own infrastructure, so all of them
 *     collapse onto a single rate-limit key rather than spreading across users.
 *   - Bursts are the NORMAL shape. A 200-attendee webinar emits 200
 *     `call.session_participant_joined` events at once.
 *   - A 429 is not a deferral here. Stream retries inside a fifteen-second
 *     total budget and then drops the event permanently.
 *
 * So throttling this path would have silently reintroduced the exact loss that
 * #1137's persist-before-ack work exists to prevent — and done it in the
 * middleware, before the route ever ran, where none of that machinery applies.
 *
 * Excluding it is safe because the endpoint is not open: it verifies an HMAC
 * signature against the API secret and 401s anything unsigned before doing any
 * work. The signature is the gate; the limiter never was.
 *
 * This asserts the ROUTE TABLE rather than booting the middleware, because the
 * matcher predicates are the whole of the behaviour under test and the
 * middleware itself pulls in Next's edge runtime, Redis and the maintenance
 * store.
 */

import { readFileSync } from "fs";
import { join } from "path";

const middleware = readFileSync(
  join(process.cwd(), "middleware.ts"),
  "utf8",
);

/** The `stream: api` rule's match predicate, lifted from the source. */
function streamApiMatches(pathname: string): boolean {
  return (
    pathname.startsWith("/api/stream/") &&
    !pathname.startsWith("/api/stream/webhooks")
  );
}

describe("the stream: api rate-limit rule", () => {
  it("does NOT match the webhook endpoint", () => {
    expect(streamApiMatches("/api/stream/webhooks")).toBe(false);
  });

  it("still matches the ordinary authenticated Stream routes", () => {
    for (const p of [
      "/api/stream/channels/search-appointments",
      "/api/stream/recordings/start",
      "/api/stream/search-consultees",
      "/api/stream/debug",
    ]) {
      expect(streamApiMatches(p)).toBe(true);
    }
  });

  it("is wired that way in middleware.ts, not just in this test", () => {
    // The predicate above is a copy. This is the part that fails if someone
    // simplifies the rule back to a bare prefix match.
    expect(middleware).toContain('!p.startsWith("/api/stream/webhooks")');
  });

  it("does not claim the join rule is keyed per user", () => {
    // `applyEdgeRateLimits` falls back to the client IP when a rule supplies no
    // `key`, and the join rule supplies none. The comment used to assert
    // per-user keying, which the code cannot do — this middleware is
    // cookie-presence only, with no DB hit and no JWT parsing.
    expect(middleware).not.toContain("keyed per user by the shared");
    expect(middleware).toContain("Keyed by IP, NOT by user");
  });
});
