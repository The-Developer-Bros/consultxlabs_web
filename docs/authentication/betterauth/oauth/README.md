# OAuth Providers

| Field | Value |
|---|---|
| Status | Stable |
| Audience | Engineers adding or maintaining OAuth providers |
| Last reviewed | 2026-04-26 |
| Source files | `lib/auth.ts` (lines 57–81), `lib/auth-providers.ts`, `lib/auth-client.ts` |

## 1. Background

Three OAuth social providers are registered: **Google**, **GitHub**, **Facebook**. They enable "Sign in with X" buttons on the auth pages and support automatic account linking by email.

OAuth is the lighter-weight cousin of SSO — it authenticates individual users via their personal accounts. Enterprise SSO (SAML/OIDC for org-managed IdPs) lives in [`../sso/`](../sso/README.md).

## 2. Current State

### 2.1 Provider Configuration

Defined in [`lib/auth.ts`](../../../../lib/auth.ts#L57-L70):

```typescript
socialProviders: {
  google:   { clientId: env.GOOGLE_CLIENT_ID,   clientSecret: env.GOOGLE_CLIENT_SECRET },
  github:   { clientId: env.GITHUB_CLIENT_ID,   clientSecret: env.GITHUB_CLIENT_SECRET },
  facebook: { clientId: env.FACEBOOK_CLIENT_ID, clientSecret: env.FACEBOOK_CLIENT_SECRET },
},
```

### 2.2 Account Linking

All three are `trustedProviders`:

```typescript
account: {
  accountLinking: {
    enabled: true,
    trustedProviders: ["google", "github", "facebook"],
  },
},
```

When a user signs in via OAuth with an email that already exists (from a credential signup or another OAuth provider), BetterAuth auto-links the accounts. The `account.create.after` hook sends a "new account linked" notification email.

> [!NOTE]
> `"credential"` is intentionally **not** in `trustedProviders`. It only applies to OAuth providers during BetterAuth's implicit auto-link callback flow. Credential accounts are created explicitly during sign-up.

### 2.3 UI Configuration

[`lib/auth-providers.ts`](../../../../lib/auth-providers.ts) centralizes the button labels, CSS classes, and type-safe IDs:

```typescript
export const AUTH_PROVIDERS = [
  { id: "github",   label: "GitHub",   className: "bg-black hover:bg-gray-700" },
  { id: "google",   label: "Google",   className: "bg-red-600 hover:bg-red-500" },
  { id: "facebook", label: "Facebook", className: "bg-blue-600 hover:bg-blue-500" },
] as const;
```

## 3. How to Add a New OAuth Provider

1. **`lib/auth.ts`** — Add to `socialProviders` and `trustedProviders`:
   ```typescript
   socialProviders: {
     // ... existing
     apple: { clientId: env.APPLE_CLIENT_ID, clientSecret: env.APPLE_CLIENT_SECRET },
   },
   account: {
     accountLinking: { trustedProviders: [..., "apple"] },
   },
   ```

2. **`lib/auth-providers.ts`** — Add UI config:
   ```typescript
   { id: "apple", label: "Apple", className: "bg-gray-900 hover:bg-gray-800" },
   ```

3. **`components/auth/auth-icons.tsx`** — Add icon + update `PROVIDER_ICONS` map.

4. **`.env` / `.env.sample`** — Add `APPLE_CLIENT_ID` and `APPLE_CLIENT_SECRET`.

5. **OAuth provider console** — Register the app, set redirect URI to `{BETTER_AUTH_URL}/api/auth/callback/apple`.

6. **Test** — Sign in via the new provider. Verify account linking works with an existing email.

## 4. Edge Cases

1. **Missing env vars.** If `GOOGLE_CLIENT_ID` is empty, the Google button renders but clicking it fails silently. All provider env vars should be set in all environments.
2. **Provider-specific scopes.** BetterAuth uses sensible defaults. If you need custom scopes (e.g., `calendar.readonly` for Google), configure them in the provider object.
3. **OAuth vs SSO.** A user signing in via personal Google OAuth is **not** satisfying enterprise SSO enforcement. The enforcement check looks for `account.providerId` matching a registered `ssoProvider.providerId`, not just "not credential."

## 5. Related Docs

- [01-architecture.md](../01-architecture.md) — Plugin chain, account linking config
- [../sso/README.md](../sso/README.md) — Enterprise SSO (SAML/OIDC)
