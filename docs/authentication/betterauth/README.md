# Authentication — BetterAuth

This folder is the new-developer onboarding surface for everything
authentication-related. Read top-to-bottom; the files build on each
other.

| Order | File | What it covers |
|---|---|---|
| 1 | [`01-architecture.md`](./01-architecture.md) | BetterAuth setup, plugin chain, session model, no-JWT rationale, database hooks, customSession hot path. |
| 2 | [`02-middleware.md`](./02-middleware.md) | Request lifecycle: Edge Runtime, route classification, cookie-only auth check, maintenance mode integration. |
| 3 | [`03-sessions-and-hooks.md`](./03-sessions-and-hooks.md) | Session lifecycle, the three database hooks, membership bridge, auth-guard vs auth-helper distinction. |
| 4 | [`04-rate-limiting.md`](./04-rate-limiting.md) | Edge + handler rate limiters, all 15 buckets, fail-open posture, localhost bypass, how to add a new limiter. |
| 5 | [`05-testing.md`](./05-testing.md) | SSO unit tests, `verify-sso-invariants.sh` static checks, how to write new auth tests. |
| 6 | [`06-ci-deployment.md`](./06-ci-deployment.md) | GitHub Actions CI pipeline, SSO cert expiry cron, Docker dev/prod, Netlify, env vars, secret rotation. |
| 7 | [`sso/README.md`](./sso/README.md) | Enterprise SSO in depth — SAML/OIDC, enforcement layers, domain claims, provider schemas, PKCE, cert rotation. |
| 8 | [`oauth/README.md`](./oauth/README.md) | OAuth providers (Google, GitHub, Facebook), account linking, how to add a new provider. |
| 9 | [`08-redirects-and-navigation.md`](./08-redirects-and-navigation.md) | **The anti-flicker contract**: auth redirect rules (`replace` not `push`, idempotency refs, force-fresh destination checks, `safeSameOriginPath`, server-side dashboard entry redirects). Read before touching any redirect. |

Authorization (role hierarchy, capability gates, `requireOrgAccess`) lives in [`docs/authorization/`](../../authorization/README.md).

## Companion docs (already in repo, don't duplicate)

- [`docs/enterprise/20-iam-and-security/01-sso-and-authentication.md`](../../enterprise/20-iam-and-security/01-sso-and-authentication.md) — enterprise admin's view of SSO config (allowedEmailDomains, enforceSSO, IdP recipes for Okta/Auth0).
- `docs/enterprise/playbooks/sso-testing.md` *(planned; not in repo yet)* — four ways to exercise the SAML/OIDC flow locally (mocksaml.com, saml-idp, Keycloak, real Auth0/Okta dev tenants).

This folder focuses on **the implementation**: what the code does, why
it does it that way, and the foot-guns. The enterprise docs above focus
on **how to configure** SSO for a tenant. Keep them in lock-step but
don't repeat content.

## TL;DR for the impatient

1. **No JWT.** Sessions are server-side rows in a Postgres `Session`
   table; the client carries an opaque cookie. We get revocation,
   audit, and rotation for free at the cost of a cookie-cached DB read
   per session validation. See [`01-architecture.md`](./01-architecture.md).
2. **Middleware is cookie-only.** `middleware.ts` runs in the Edge
   Runtime, can't import BetterAuth's Node-only deps, and only checks
   for a session cookie. Real validation happens in the API route via
   `requireApiAuth()`. See [`02-middleware.md`](./02-middleware.md).
3. **Role hierarchy (org-side):** `OWNER > MAINTAINER > MANAGER > EXPERT > SUPPORT > LEARNER`. Platform-side: `ADMIN > STAFF > everyone-else`. Use the typed helpers in `lib/auth-helpers.ts`; never inline-compare roles. See [`docs/authorization/`](../../authorization/README.md).
4. **Two membership tables.** BetterAuth's untyped `Member` (free-form
   string role, kept for invite-token compatibility) and our typed
   `Membership` (the source of truth for role/status/profile links).
   `customSession` reconciles them on every authenticated request; the
   `betterAuthMemberId` field bridges the two. See
   [`03-sessions-and-hooks.md`](./03-sessions-and-hooks.md).
5. **SSO enforcement is server-side.** `session.create.before` rejects
   credential/OAuth signins from enforced domains at the source (closes
   #673). There is no read-time enforcement: a `ssoEnforcementFailed`
   flag existed in `customSession` but never had a consumer and was
   removed in #1242 — re-introduce it only WITH its consumer, per the
   spec in [#1241](https://github.com/Practitionist/familiarise_web/issues/1241).
   See [`sso/README.md`](./sso/README.md).
6. **Rate limits fail open.** If Redis is unreachable,
   `applyRateLimit()` returns `null` and the request proceeds. Better
   to ship a request during an Upstash outage than to 429 every login.
   See [`04-rate-limiting.md`](./04-rate-limiting.md).

## Quick orientation by problem

> "I'm writing a new API route that needs auth."
>
> Use `requireApiAuth()`, `requireOrgAccess(orgId, "MAINTAINER")`, or
> `requireAdminAuth()` from `lib/auth-helpers.ts`. Never roll your own
> session check — they handle the 401/403/404/409 envelope correctly.
> See [`docs/authorization/`](../../authorization/README.md).

> "Should this endpoint be rate-limited?"
>
> If it's POST + abuseable (auth, sign-up, password-reset, invite-accept,
> SSO domain-check) yes. If it's a public read that hits Postgres
> (search, availability, eligibility) yes. Otherwise probably no.
> Wire in `middleware.ts`. See [`04-rate-limiting.md`](./04-rate-limiting.md).

> "Why is my SSO test failing?"
>
> Run `scripts/verify-sso-invariants.sh` first — it catches eight
> common regressions statically (missing PKCE, re-added callbackUrl,
> orphan provider userId, etc.). If green, see
> `docs/enterprise/playbooks/sso-testing.md`.

> "How do I add a new BetterAuth plugin?"
>
> Plugins go in `lib/auth.ts`'s `plugins: [...]` array. `nextCookies()`
> must stay last. Anything that touches the session shape needs a
> matching client-side mirror in `lib/auth-client.ts`. See
> [`01-architecture.md`](./01-architecture.md).

> "Why doesn't middleware redirect me to the dashboard if I'm logged in?"
>
> Cookie presence ≠ session validity. Stale cookies (DB session GC'd)
> would cause an infinite loop: middleware → /dashboard →
> requireOnboarded → /auth/signin → /dashboard. The signin page itself
> uses `useSession()` to redirect authenticated users client-side. See
> the comment at `middleware.ts:286-289`.

If something in the code disagrees with these docs, the code is the
source of truth — file an issue and the docs get patched.
