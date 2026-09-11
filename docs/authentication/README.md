# Authentication

| Field | Value |
|---|---|
| Status | Stable |
| Audience | All engineers |
| Last reviewed | 2026-04-26 |
| Sibling folder | [`docs/authorization/`](../authorization/) for "what can this user do" |

## 1. Background

This folder documents the **authentication** subsystem — every code
path that answers "who is this user?". Authorization (what they can
*do* once we know who they are) lives in the sibling folder above.

The subsystem is built on [BetterAuth](https://better-auth.com), a
TypeScript-first auth library. We use it because:

- It's framework-agnostic (Next.js Edge / Node, plain Express, etc).
- The plugin model lets us add SSO, organizations, and custom session
  shape without forking the library.
- Sessions are server-side rows we own (Postgres `Session` table) —
  no JWT envelope, no signing-key rotation, no opaque-token refresh
  dance. Revocation is `DELETE FROM Session WHERE …`.

## 2. Scope

| In scope | Out of scope |
|---|---|
| BetterAuth setup + plugin chain | What roles can do — see [`authorization/`](../authorization/) |
| Session model + lifecycle | Profile editing UX |
| OAuth providers (when active) | Payment / KYC identity (separate concern) |
| Enterprise SSO (SAML + OIDC) | Mobile push-token auth (not in scope yet) |
| Middleware request lifecycle | API routing for non-auth surfaces |
| Auth-related rate limiting | Per-feature rate limits — handler-side |

## 3. Where to start

Read the children in this order:

| # | Path | Reading time |
|---|---|---|
| 1 | [`betterauth/README.md`](./betterauth/README.md) | 5 min |
| 2 | [`betterauth/01-architecture.md`](./betterauth/01-architecture.md) | 15 min |
| 3 | [`betterauth/02-middleware.md`](./betterauth/02-middleware.md) | 10 min |
| 4 | [`betterauth/03-sessions-and-hooks.md`](./betterauth/03-sessions-and-hooks.md) | 10 min |
| 5 | [`betterauth/04-rate-limiting.md`](./betterauth/04-rate-limiting.md) | 10 min |
| 6 | [`betterauth/sso/README.md`](./betterauth/sso/README.md) | 15 min |
| 7 | [`betterauth/oauth/README.md`](./betterauth/oauth/README.md) | 5 min |
| 8 | [`betterauth/05-testing.md`](./betterauth/05-testing.md) | 10 min |
| 9 | [`betterauth/06-ci-deployment.md`](./betterauth/06-ci-deployment.md) | 10 min |

Total: ~90 minutes for full onboarding. The first four are mandatory
before touching any auth code.

## 4. Companion docs

- [`docs/enterprise/20-iam-and-security/01-sso-and-authentication.md`](../enterprise/20-iam-and-security/01-sso-and-authentication.md)
  — enterprise admin's view of SSO config (allowedEmailDomains,
  IdP recipes for Okta/Auth0). Configuration-side; this folder is
  implementation-side. Keep them in lock-step but don't duplicate.
- `docs/enterprise/playbooks/sso-testing.md` *(planned; not in repo yet)*
  — four ways to exercise SSO locally
  (mocksaml.com / saml-idp / Keycloak / real dev tenants). Read after
  this folder if you need to test.

## 5. Related docs

- [`docs/authorization/`](../authorization/) — the sibling folder for
  authz helpers (`requireApiAuth`, `requireOrgAccess`, role hierarchy).
- [`docs/api/`](../api/) — general API conventions.
- [`docs/infrastructure/`](../infrastructure/) — Redis, Docker,
  deployment topology that auth depends on.
