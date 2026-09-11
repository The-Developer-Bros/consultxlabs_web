---
title: Upstash rate limiting over BetterAuth's built-in limiter
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-06-05
---

# ADR 07 — BetterAuth's limiter off; Upstash sliding windows on the sensitive routes

## Context

The platform needs to rate-limit a set of abuse-prone routes: auth
endpoints against brute force, checkout against fraud, SCIM and webhook
config against runaway scripts, expensive data-export jobs against cost
abuse, and several org-scoped writes against single-tenant floods.
BetterAuth ships a built-in rate limiter, so the path of least resistance
is to turn it on and lean on it for the auth surface. The deployment
target is Netlify, which runs the app as serverless functions — each
cold-start lambda is a fresh process with its own memory. That deployment
fact is the hinge of the whole decision.

## Decision

BetterAuth's built-in limiter is disabled (`lib/auth.ts` carries
`rateLimit: { enabled: false }`) and rate limiting is done with Upstash
Redis sliding windows defined in `lib/rate-limit.ts`. Every limiter is
built through the shared `makeLimiter(count, window, prefix)` helper,
which wires the shared Upstash `redis` client into
`Ratelimit.slidingWindow(...)` under a distinct `rl:` key prefix —
`authLimiter` (10 per 15 min on IP), `checkoutLimiter` (5 per min on
user), `scimLimiter` (60 per min on token hash), `orgWebhookLimiter` (5
per min on `org:`), `orgDataExportLimiter` (1 per 24h on `org:`), and the
rest. Limits are enforced in two layers: edge middleware
(`middleware.ts`'s `RATE_LIMIT_RULES`) for cheap-keyed public/auth routes
so a flood is killed before a lambda spins up, and
`applyRateLimit(limiter, key)` inside the handler for authed org-scoped
writes whose key (`org:${orgId}`, `scim:${tokenHash}`) only becomes known
after the route resolves. `applyRateLimit` returns a 429 with
`X-RateLimit-Remaining` on exceed and **fails open** if Redis is
unreachable, so a Redis outage degrades to "no rate limit" rather than
"site down" (see
[rate-limiting](../20-iam-and-security/04-rate-limiting.md)).

The real reason BetterAuth's limiter is off, verified against both the doc
(§1) and the comment block above `rateLimit: { enabled: false }` in
`lib/auth.ts`, is that **BetterAuth's limiter is in-memory per Node
process**. On Netlify each cold-start lambda gets its own counter, so an
attacker can race past a per-process gate simply by rotating through
enough fresh lambdas — the limit never becomes globally coherent. A
coherent limit has to live in shared state, which is what Upstash Redis
provides.

## Alternatives considered

We considered leaving BetterAuth's built-in limiter on for the auth
surface and adding Upstash only where BetterAuth doesn't reach. It lost on
correctness first — the in-memory counter is per-lambda and trivially
defeated by lambda rotation under Netlify's serverless model, so on the
auth routes it provides false assurance rather than protection. It lost a
second time on operability: running both limiters at once means the same
brute-force flow can trip *two different* 429s depending on which lambda
served the request, an incident-response trap where the operator cannot
tell which limiter fired or why the counts don't reconcile. One coherent
limiter beats two that disagree, so BetterAuth's is turned fully off
rather than layered.

We considered a single global Upstash limiter instead of the eight-plus
named per-surface limiters. It lost because the surfaces have genuinely
different threat shapes and different keys: auth is 10/15min on IP (brute
force), webhook config is 5/min on `org:` (config thrash), data-export is
1/24h on `org:` (an expensive job). A single bucket can't express that
spread without either throttling logins too loosely or reads too tightly,
and because the keys differ (IP vs `org:` vs `tokenHash`) one shared
keyspace would force every tenant through the same bucket — so one noisy
org behind a corporate NAT could starve everyone. Many narrow limiters,
each with its own `rl:` prefix, is the price of not having that
cross-tenant blast radius.

## Consequences

The real cost is per-route discipline: every new authed-write route has to
pick the right limiter (or define one), choose the correct layer (edge vs
handler), choose a non-colliding `rl:` prefix, and document it in the
coverage matrix — and it is easy to forget, leaving a route silently
unlimited. The fail-open posture is a second, deliberate cost: when Redis
is down, `applyRateLimit` allows the request, so a Redis outage is also a
rate-limit outage. We accept that because "site stays up, limits
temporarily off" beats "Redis hiccup takes the site down," but it means
Redis availability is part of the security posture, not just performance.

There is also a standing footgun the disable creates: because BetterAuth's
limiter is off, any route not covered by an edge rule or an
`applyRateLimit` call has no limit at all — `POST
/api/auth/reset-password` is the documented example, gated only by the
single-use reset token, not by a request limiter.

Revisit this decision if the platform ever moves off serverless to a
long-lived process model where an in-process limiter *would* be globally
coherent, or if Redis availability becomes a liability worth trading the
fail-open behaviour against. Re-enabling BetterAuth's limiter requires
auditing every overlap against the Upstash limiters first, or the
double-429 incident-response trap returns.
