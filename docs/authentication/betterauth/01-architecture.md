# Architecture

| Field | Value |
|---|---|
| Status | Stable |
| Audience | All engineers |
| Last reviewed | 2026-04-26 |
| Source files | `lib/auth.ts`, `lib/auth-client.ts`, `lib/auth-server.ts`, `lib/auth-guard.ts` |

## 1. Background

BetterAuth is the authentication library powering sign-in, sign-up, session management, OAuth, and enterprise SSO. It was chosen because:

- **No JWT.** Sessions are server-side Postgres rows in the `Session` table. Revocation is a `DELETE`, not a blocklist. No signing-key rotation. No opaque-token refresh dance.
- **Plugin model.** SSO, organizations, and custom session shape are composable plugins — no library fork required.
- **Framework-agnostic.** Works in both Next.js Edge Runtime (middleware) and Node Runtime (API routes, server components).

## 2. Scope

| In scope | Out of scope |
|---|---|
| BetterAuth config and plugin chain | Authorization helpers — see `docs/authorization/` |
| Session lifecycle and cookie strategy | Rate limiting — see `04-rate-limiting.md` |
| Database hooks (user create, session create, account create) | SSO-specific enforcement — see `sso/` |
| Server/client auth entry points | OAuth provider-specific config — see `oauth/` |

## 3. Design

### 3.1 Plugin Chain

Plugins are registered in [`lib/auth.ts`](../../../lib/auth.ts#L319-L530) in this order:

```
organization() → sso() → customSession() → nextCookies()
```

> [!WARNING]
> `nextCookies()` **must be the last plugin**. Moving it breaks cookie handling in Next.js App Router.

| Plugin | What it does |
|---|---|
| `organization()` | BetterAuth's org plugin. Creates `Member` rows. `creatorRole: "OWNER"`, `organizationLimit: 5`. |
| `sso()` | `@better-auth/sso` — mounts SAML + OIDC endpoints under `/api/auth/sso/*`. Auto-provisions the `ssoProvider` table. |
| `customSession()` | Enriches every session read with user fields, org memberships, and SSO enforcement status. This is the **hot path** — every authenticated request runs it. |
| `nextCookies()` | Wires BetterAuth's cookie lifecycle into Next.js `headers()` / `cookies()`. |

### 3.2 Session Model

```
┌─────────────┐       ┌─────────────────┐
│   Browser    │──────▶│  Session Cookie  │   (opaque, HTTP-only)
└─────────────┘       └────────┬────────┘
                               │
                   ┌───────────▼───────────┐
                   │  Postgres `Session`   │   (server-side row)
                   │  - id, userId, token  │
                   │  - expiresAt          │
                   │  - updatedAt          │
                   └───────────────────────┘
```

**Cookie cache:** Enabled via `cookieCache` — a compact serialization of session data cached in the cookie itself for 5 minutes. This avoids a DB hit on every request while keeping the staleness window small.

```typescript
session: {
  expiresIn: 30 * 24 * 60 * 60,  // 30 days
  updateAge: 24 * 60 * 60,        // touch DB once per day
  cookieCache: {
    enabled: true,
    maxAge: 5 * 60,                // 5 min cache in cookie
    strategy: "compact",
  },
}
```

> [!IMPORTANT]
> When you need the freshest session data (e.g., checking `onboardingCompleted` right after the user finishes onboarding), call `getSession(true)` — the `true` parameter sets `disableCookieCache` and forces a DB read. See [`lib/auth-server.ts`](../../../lib/auth-server.ts).

### 3.3 Password Hashing

Passwords are hashed with `bcrypt` at cost factor 12. BetterAuth's default hasher is overridden via `emailAndPassword.password.hash` / `.verify` so the algorithm stays explicit and auditable.

### 3.4 Social Providers

Three OAuth providers are registered in `socialProviders`: **Google**, **GitHub**, **Facebook**. All three are also listed in `trustedProviders` for account linking. See [`oauth/README.md`](./oauth/README.md) for details.

### 3.5 User Additional Fields

The `user.additionalFields` config extends BetterAuth's `User` model with platform-specific columns:

| Field | Type | Purpose |
|---|---|---|
| `role` | `string` | Platform role (`ADMIN`, `STAFF`, `CONSULTANT`, `CONSULTEE`, `ORG_WORKSPACE`) |
| `onboardingCompleted` | `boolean` | Gate for post-signup onboarding flow |
| `phone`, `timezone`, `address` | `string` | Profile data |
| `consultantProfileId`, `consulteeProfileId`, `staffProfileId`, `adminProfileId`, `orgWorkspaceProfileId` | `string` | FK links to role-specific profile tables |

Fields marked `input: false` cannot be set by the client during sign-up — they're written server-side by hooks or onboarding flows.

## 4. Reference

### 4.1 Entry Points

| File | Role | Runtime |
|---|---|---|
| [`lib/auth.ts`](../../../lib/auth.ts) | BetterAuth config + export `auth` | Node |
| [`lib/auth-server.ts`](../../../lib/auth-server.ts) | `getSession()` wrapper — used by server components and API routes | Node |
| [`lib/auth-client.ts`](../../../lib/auth-client.ts) | `authClient` + `useSession`, `signIn`, `signOut` — used by React components | Browser |
| [`lib/auth-guard.ts`](../../../lib/auth-guard.ts) | Page-level guards: `requireAuth`, `requireOnboarded`, `requireUserRole`, `requireNotOnboarded` | Node (server components) |
| [`lib/auth-providers.ts`](../../../lib/auth-providers.ts) | Centralized OAuth provider UI config (labels, button classes) | Shared |

### 4.2 Database Hooks

Three hooks fire at key lifecycle events:

| Hook | When | What it does |
|---|---|---|
| `user.create.after` | After a new user signs up | Creates `CookiePreference` + `NotificationPreference`. Sends welcome email (fire-and-forget). Syncs Novu subscriber. |
| `session.create.before` | Before issuing a session cookie | **SSO enforcement gate.** Calls `shouldRejectSession()` — rejects credential/OAuth signins from enforced domains. See [`sso/`](./sso/README.md). |
| `account.create.after` | After linking a non-credential account | Sends "account linked" notification email (fire-and-forget). |

> [!NOTE]
> `ConsulteeProfile` is **not** auto-created in the user hook. It is lazy-created on first consumer action via `ensureConsulteeProfile` in `lib/profiles/ensure-consultee-profile.ts`. This prevents org-operators and consultants from carrying a dangling consumer profile.

### 4.3 customSession Hot Path

Every authenticated request reads `customSession()`. It does three things:

1. **SSO membership sync:** Finds `Member` rows (BetterAuth's untyped table) that lack a sibling `Membership` row (our typed table). Creates the missing `Membership` with the org's `defaultRoleForAutoJoin` (defaults to `LEARNER`).

2. **Org membership payload:** Loads all ACTIVE memberships for the user — org name, slug, logo, capabilities (`canSponsor`, `canHost`), funding source, wallet balance. This powers the `OrgSwitcher` and checkout without an extra roundtrip.

3. **SSO enforcement flag:** Checks if the user's email domain is enforced and whether they have an account linked via a registered SSO provider. Sets `ssoEnforcementFailed: true` for defense-in-depth (the primary gate is `session.create.before`).

### 4.4 Auth Guard Functions

These are server-component guards — they `redirect()` (never return an error response):

| Guard | Used where | Behavior |
|---|---|---|
| `requireAuth()` | Any page needing a logged-in user | Redirects to `/api/auth/clear-stale-session` → `/auth/signin` if no session |
| `requireOnboarded()` | Dashboard, settings, profile pages | Redirects to onboarding if `!onboardingCompleted` or missing profile |
| `requireUserRole(roles)` | Role-restricted pages (e.g., org creation for `ORG_WORKSPACE`) | Redirects to `/dashboard` if role doesn't match |
| `requireNotOnboarded()` | Onboarding page itself | Redirects to `/dashboard` if already onboarded |

## 5. Operational Concerns

### Stale Cookie Loop

If a session is deleted from the DB but the browser still has the cookie, `requireOnboarded()` would bounce between `/dashboard` and `/auth/signin` infinitely. The fix: `redirectWithCookieCleanup()` sends to `/api/auth/clear-stale-session`, which is a Route Handler that can clear cookies (Server Components cannot).

### Cookie Cache Staleness

The 5-minute cookie cache means a user who just completed onboarding might see a stale `onboardingCompleted: false` for up to 5 minutes. Mitigated by using `getSession(true)` (bypasses cache) in flows that read freshly-mutated fields.

## 6. Edge Cases & Foot-Guns

1. **Plugin ordering matters.** `nextCookies()` must be last. `customSession()` must come after `organization()` and `sso()` because it reads data those plugins create.

2. **`auth-client.ts` must mirror `auth.ts`.** If you add a plugin server-side, add its client plugin too. Missing `ssoClient()` on the client breaks `signIn.sso()` — PKCE isn't generated and OIDC flows silently fail.

3. **Edge Runtime limitation.** `middleware.ts` runs in the Edge Runtime. `@better-auth/sso` imports `node:crypto` / `node:dns`, which are unavailable in Edge. That's why middleware only checks cookie presence — real validation happens in API routes.

4. **`betterAuthMemberId` bridge.** BetterAuth's `Member` table and our `Membership` table are linked via `Membership.betterAuthMemberId`. If you delete one, the other becomes orphaned. Always operate on both.

## 7. Related Docs

- [`02-middleware.md`](./02-middleware.md) — Request lifecycle, route classification, cookie-only check
- [`03-sessions-and-hooks.md`](./03-sessions-and-hooks.md) — Deep dive on session model and hook lifecycle
- [`sso/README.md`](./sso/README.md) — SSO enforcement, provider registration, domain claims
- [`oauth/README.md`](./oauth/README.md) — OAuth providers
- [`docs/authorization/`](../../authorization/) — Authorization helpers
