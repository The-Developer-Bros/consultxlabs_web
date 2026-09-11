# Testing

| Field | Value |
|---|---|
| Status | Stable |
| Audience | All engineers |
| Last reviewed | 2026-04-26 |
| Source files | `__tests__/sso/`, `scripts/verify-sso-invariants.sh`, `jest.config.ts` |

## 1. Background

Auth-related testing has two layers:

- **Unit tests** (`__tests__/sso/`) — Jest tests covering pure decision logic with injected I/O.
- **Static invariants** (`scripts/verify-sso-invariants.sh`) — Bash grep checks that catch common regressions without a DB or runtime.

Both run in CI on every PR via `.github/workflows/ci.yaml`.

## 2. Test Layout

### 2.1 SSO Unit Tests

```
__tests__/sso/
├── derive-urls.test.ts       # ACS/metadata URL derivation
├── enforce-session.test.ts   # SSO session-creation veto logic
└── provider-schemas.test.ts  # Zod schema validation for SSO providers
```

**`enforce-session.test.ts`** — Tests the `shouldRejectSession()` decision function. All I/O is injected via the `EnforceInputs` interface, so these run without a DB. Key cases:

| Case | Expected |
|---|---|
| Non-enforced domain | Allow |
| Missing email | Allow (can't decide) |
| Enforced + credential-only account | **Reject** (SSO_REQUIRED) |
| Enforced + personal Google OAuth (not registered SSO) | **Reject** |
| Enforced + account linked via registered SSO provider | Allow |
| Enforced + zero registered providers (fail-open) | Allow |
| Uppercase email domain | Reject (normalized to lowercase) |

**`derive-urls.test.ts`** — Guards against ACS/metadata URL regressions. If BetterAuth's endpoint templates drift from these, the URLs shown to IT admins won't match what BetterAuth actually mounts.

**`provider-schemas.test.ts`** — The most critical invariant: `samlConfig` must NOT accept `callbackUrl`. Tests also cover path-injection in `providerId` and providerType validation.

### 2.2 SSO Static Invariants

[`scripts/verify-sso-invariants.sh`](../../../scripts/verify-sso-invariants.sh) runs 8 grep-level checks:

| # | What it checks | Why |
|---|---|---|
| 1 | No raw `fetch()` to `/api/auth/sign-in/sso` | Skips OIDC PKCE → Auth0/Okta flows fail |
| 2 | `ssoClient()` registered in `lib/auth-client.ts` | `signIn.sso()` requires the plugin |
| 3 | `samlConfigSchema` has no `callbackUrl` property | BetterAuth would override derived ACS URL |
| 4 | SSO provider POST doesn't set `userId` to owner | FK cascade would kill org SSO on owner delete |
| 5 | `customSession` doesn't use `providerId: { not: "credential" }` | Personal OAuth would bypass enforcement |
| 6 | No "OIDC coming soon" strings on SSO settings page | OIDC is fully supported now |
| 7 | `shouldRejectSession` referenced in `lib/auth.ts` | Server-side SSO veto must stay wired |
| 8 | `better-auth` and `@better-auth/sso` versions match | Mismatched versions cause runtime errors |

To run locally:
```bash
bash scripts/verify-sso-invariants.sh
```

> [!CAUTION]
> If this script fails in CI, **read the "Why" line** before changing the invariant. Each check prevents a specific past incident from recurring.

## 3. Running Tests

```bash
# All unit tests
npm run test

# SSO tests only
npx jest __tests__/sso/

# Static invariants only
bash scripts/verify-sso-invariants.sh
```

## 4. Writing New Auth Tests

- **Pure logic → unit test.** If the function takes injected I/O (like `shouldRejectSession`), write a Jest test in `__tests__/sso/` or `__tests__/lib/`.
- **Structural invariant → add to `verify-sso-invariants.sh`.** If something should "never appear in the codebase" (like a forbidden field or import), add a grep check.
- **Integration test → use the existing test fixtures.** See `test-fixtures/` for shared test data.

## 5. Related Docs

- [06-ci-deployment.md](./06-ci-deployment.md) — How tests run in CI
- [sso/README.md](./sso/README.md) — SSO architecture context for the tests
