# Netlify Deployment — Full Reference Guide

> Written for junior developers who will maintain and extend Familiarise's deployment infrastructure.
> This document covers everything we learned the hard way, so you don't have to.

---

## Table of Contents

1. [Overview](#overview)
2. [Site & Branch Architecture](#site--branch-architecture)
3. [Environment Variables — What's There and Why](#environment-variables--whats-there-and-why)
4. [The BetterAuth / "Invalid Origin" Incident](#the-betterauth--invalid-origin-incident)
5. [Netlify CLI Setup](#netlify-cli-setup)
6. [DNS Architecture on Netlify](#dns-architecture-on-netlify)
7. [Setting Up dev.familiarisenow.com](#setting-up-devfamiliariseonowcom)
8. [GCP OAuth Configuration](#gcp-oauth-configuration)
9. [The `netlify.toml` File](#the-netlifytoml-file)
10. [Deployment Workflow](#deployment-workflow)
11. [Gotchas, Errors & Debugging Log](#gotchas-errors--debugging-log)
12. [Checklist for New Environments](#checklist-for-new-environments)

---

## Overview

| Property               | Value                                                 |
| ---------------------- | ----------------------------------------------------- |
| Platform               | Netlify (Pro plan — `nf_team_pro`)                    |
| Site name              | `familiarise`                                         |
| Site ID                | `$NETLIFY_SITE_ID`                                    |
| Production URL         | `https://familiarisenow.com`                          |
| Dev branch URL         | `https://dev.familiarisenow.com`                      |
| Netlify default URL    | `https://familiarise.netlify.app`                     |
| Dev branch Netlify URL | `https://dev--familiarise.netlify.app`                |
| Netlify admin          | `https://app.netlify.com/projects/familiarise`        |
| Netlify account        | `Practitionist-Deploys` (email: `<team-admin-email>`) |
| GitHub repo            | `https://github.com/Practitionist/familiarise_web`    |
| DNS managed by         | Netlify DNS (zone ID: `$NETLIFY_DNS_ZONE_ID`)         |

---

## Site & Branch Architecture

Familiarise uses **two long-lived branches** in a trunk-based deployment flow:

```
feat/* / fix/*  ──► dev  ──► prod
                    │           │
                    │           └─► familiarisenow.com  (Netlify production)
                    └─────────────► dev.familiarisenow.com  (Netlify branch deploy)
```

### Branch → Deploy mapping

| Git branch    | Netlify context | URL                                                   |
| ------------- | --------------- | ----------------------------------------------------- |
| `prod`        | production      | `https://familiarisenow.com`                          |
| `dev`         | branch-deploy   | `https://dev.familiarisenow.com`                      |
| any PR branch | deploy-preview  | `https://deploy-preview-NNN--familiarise.netlify.app` |

### Allowed branches

Netlify is configured to auto-deploy only `prod` and `dev`. All other branches
only get a preview deploy when a pull request is open against them.

This is controlled in the Netlify site settings under **Build & deploy → Continuous deployment → Branch deploys**.
Via the API it's the `build_settings.allowed_branches` array.

### Why `prod` and not `main`?

The production branch is named `prod` (not `main` or `master`). This is intentional:

- `dev` is where active development happens and gets reviewed as a staging environment
- `prod` only receives merges from `dev` after QA sign-off
- `main` does not exist in this repo — don't create it

---

## Environment Variables — What's There and Why

All env vars live in the Netlify dashboard and are injected at build time.
They are **not committed to the repo** (`.env` is gitignored).
The `.env.sample` file is the canonical reference for what vars are needed.

### Critical auth variables

| Variable                      | Production value             | Local dev value         | Notes                                                                  |
| ----------------------------- | ---------------------------- | ----------------------- | ---------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`          | `<your-better-auth-secret>`  | same                    | 32+ char base64 secret for signing BetterAuth sessions                 |
| `BETTER_AUTH_URL`             | `https://familiarisenow.com` | `http://localhost:3000` | **This was the root cause of the invalid origin bug** — see below      |
| `BETTER_AUTH_TRUSTED_ORIGINS` | `https://familiarisenow.com` | `http://localhost:3000` | Comma-separated additional allowed CORS origins                        |
| `NEXT_PUBLIC_APP_URL`         | `https://familiarisenow.com` | `http://localhost:3000` | Used by auth client + for building absolute URLs (e.g. referral links) |

### Optional performance variables

These variables are not required for the app to boot, but they tune runtime behaviour. Leave them unset to accept the defaults.

| Variable               | Production value | Local dev value | Notes                                                                                                                  |
| ---------------------- | ---------------- | --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `PRISMA_SLOW_QUERY_MS` | unset (uses 500) | unset (uses 500) | Threshold in milliseconds above which Prisma logs a slow-query warning. Optional; defaults to `500`. Must be a positive number, otherwise the default is used. |

When a query runs longer than `PRISMA_SLOW_QUERY_MS`, `lib/prisma.ts` emits a `[Prisma:SLOW_QUERY]` `console.warn` so that missing indexes and N+1 patterns surface in any environment without enabling full query logging. The rationale is documented in [Navigation Performance](../performance/01-navigation-performance.md).

### Why `BETTER_AUTH_URL` is the most important variable

BetterAuth uses `BETTER_AUTH_URL` as the canonical base URL for:

1. **Origin validation** — it rejects auth requests whose `Origin` header doesn't match this URL or `trustedOrigins`
2. **Cookie domain** — session cookies are scoped to this domain
3. **OAuth callbacks** — the redirect URI sent to providers (Google, GitHub, etc.) is built from this URL

If this is set to `http://localhost:3000` in production (as it was initially), every sign-in attempt from a real browser will be rejected with `"invalid origin"`.

### Setting env vars in Netlify

Via the Netlify CLI:

```bash
# Set for production only
netlify env:set BETTER_AUTH_URL "https://familiarisenow.com" --context production

# Set for branch deploys (dev, etc.)
netlify env:set BETTER_AUTH_URL "https://familiarisenow.com" --context branch-deploy

# Set for ALL contexts at once (omit --context flag)
netlify env:set SOME_VAR "value"

# Remove a variable
netlify env:unset VARIABLE_NAME

# List all env vars as JSON (non-interactive)
netlify env:list --json
```

> **Tip:** `--context production` and `--context branch-deploy` are separate calls.
> Omitting `--context` sets the var in the `all` context (all contexts inherit it).

### The legacy NextAuth variables

When we audited the Netlify env vars, we found `NEXTAUTH_SECRET` and `NEXTAUTH_URL`
still set from a previous NextAuth migration. These were **removed** because:

- The app uses BetterAuth, not NextAuth
- Stale vars create confusion and can shadow real vars in some frameworks
- `NEXTAUTH_URL=http://localhost:3000` was harmless for BetterAuth but misleading

Removed via:

```bash
netlify env:unset NEXTAUTH_SECRET
netlify env:unset NEXTAUTH_URL
```

---

## The BetterAuth / "Invalid Origin" Incident

### Symptoms

- Login on `familiarisenow.com` fails immediately after clicking "Sign In"
- Browser console shows a `400` or `403` from `/api/auth/sign-in/email`
- Error message in the response body: `"invalid origin"`
- Login works fine on `localhost:3000`

### Root cause

`lib/auth.ts` was missing `secret`, `baseURL`, and `trustedOrigins`:

```typescript
// BEFORE (broken)
export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  // ... no secret, no baseURL, no trustedOrigins
});
```

BetterAuth, when it has no `baseURL`, tries to infer it from the incoming request.
In a Netlify serverless environment, this inference can return the internal function
URL, not the public domain. With no `trustedOrigins` list, any request whose `Origin`
doesn't match the inferred base URL is rejected.

Additionally, even if `lib/auth.ts` had `baseURL: process.env.BETTER_AUTH_URL`,
the Netlify env var `BETTER_AUTH_URL` was set to `http://localhost:3000` — so it
would still reject production requests.

### Fix applied

**`lib/auth.ts`** — added three new top-level fields:

```typescript
export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins: process.env.BETTER_AUTH_TRUSTED_ORIGINS
    ? process.env.BETTER_AUTH_TRUSTED_ORIGINS.split(",")
    : [],
  // ... rest of config unchanged
});
```

**`lib/auth-client.ts`** — added `baseURL` so the client knows where to send requests:

```typescript
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL,
  plugins: [customSessionClient<typeof auth>()],
});
```

**Netlify env vars** — fixed via CLI:

```bash
netlify env:set BETTER_AUTH_URL "https://familiarisenow.com" --context production
netlify env:set BETTER_AUTH_URL "https://familiarisenow.com" --context branch-deploy
netlify env:set BETTER_AUTH_TRUSTED_ORIGINS "https://familiarisenow.com" --context production
netlify env:set BETTER_AUTH_TRUSTED_ORIGINS "https://familiarisenow.com" --context branch-deploy
netlify env:set NEXT_PUBLIC_APP_URL "https://familiarisenow.com" --context production
netlify env:set NEXT_PUBLIC_APP_URL "https://familiarisenow.com" --context branch-deploy
```

### Why the fix also helps referral links

The `NEXT_PUBLIC_APP_URL` env var is also used when building referral link URLs
(e.g. `https://familiarisenow.com/r/andrewanfkgx`). Before this fix, referral
links were being generated as `http://localhost:3000/r/...` — completely broken
in production.

---

## Netlify CLI Setup

### Installation

```bash
npm install -g netlify-cli
netlify --version   # netlify-cli/24.x.x
```

### Authentication

```bash
netlify login       # opens browser OAuth flow
netlify status      # verify you're logged in
```

### Linking a local repo to a Netlify site

The CLI needs to know which Netlify site the current directory maps to.
Run this once in the repo root:

```bash
netlify link --id $NETLIFY_SITE_ID
```

This creates a `.netlify/` folder (gitignored automatically) that stores the site ID.
Without this, all `netlify env:*`, `netlify deploy`, and `netlify api` commands
will fail with `"You don't appear to be in a folder that is linked to a project"`.

### Listing your sites (to find the site ID)

```bash
netlify sites:list
```

Example output:

```
familiarise - $NETLIFY_SITE_ID
  url:  https://familiarisenow.com
  repo: https://github.com/Practitionist/familiarise_web
```

### Using the raw Netlify API

The CLI wraps the Netlify REST API via `netlify api <methodName>`.
All method names are camelCase versions of the OpenAPI operation IDs.

```bash
# List available API methods
netlify api --list

# Get site details
netlify api getSite --data '{"site_id": "$NETLIFY_SITE_ID"}'

# Update site settings
netlify api updateSite --data '{
  "site_id": "$NETLIFY_SITE_ID",
  "body": { "branch_deploy_custom_domain": "dev.familiarisenow.com" }
}'
```

> **Gotcha:** `netlify api` output is always JSON. Pipe through `python3 -c "import sys,json; ..."`
> or `jq` to read it. The CLI may also print interactive prompts (like "Show values? y/N")
> that hang in non-interactive shells — always use `--json` or pipe to avoid this.

---

## DNS Architecture on Netlify

The domain `familiarisenow.com` is managed entirely by **Netlify DNS**
(DNS zone ID: `$NETLIFY_DNS_ZONE_ID`). This means Netlify is the
authoritative nameserver — you do NOT manage DNS at a separate registrar
(GoDaddy, Namecheap, etc.) for this domain.

### Record types you'll see

| Type        | Purpose                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NETLIFY`   | Netlify's proprietary A-record equivalent. Points to a Netlify site. Handles Anycast routing + automatic SSL provisioning. Use this for apex and www records. |
| `CNAME`     | Standard alias record. Can point to any hostname. Netlify accepts CNAMEs to `*.netlify.app` domains but SSL provisioning requires extra steps.                |
| `NETLIFYv6` | Same as `NETLIFY` but for IPv6                                                                                                                                |
| `TXT`       | Text records — used for domain verification (Google Search Console, etc.)                                                                                     |
| `MX`        | Mail exchange records — not relevant for the app                                                                                                              |

### Current DNS records

| Type      | Hostname                   | Target                    | Purpose                   |
| --------- | -------------------------- | ------------------------- | ------------------------- |
| `NETLIFY` | `familiarisenow.com`       | `familiarise.netlify.app` | Production site           |
| `NETLIFY` | `www.familiarisenow.com`   | `familiarise.netlify.app` | www redirect to prod      |
| `NETLIFY` | `dev.familiarisenow.com`   | `familiarise.netlify.app` | Dev branch deploy         |
| `NETLIFY` | `*.dev.familiarisenow.com` | `familiarise.netlify.app` | Wildcard for dev subpaths |

> **Note on the `NETLIFY` type for `dev.familiarisenow.com`:** Even though the value
> shows `familiarise.netlify.app`, Netlify internally routes requests for this hostname
> to the dev branch deploy because `branch_deploy_custom_domain` is set to
> `dev.familiarisenow.com` in the site configuration. The `NETLIFY` record type
> lets Netlify control routing at the edge level.

### How to manage DNS records via CLI

```bash
# Get zone ID and all records
netlify api getDNSForSite --data '{"site_id": "$NETLIFY_SITE_ID"}'

# Create a DNS record
netlify api createDnsRecord --data '{
  "zone_id": "$NETLIFY_DNS_ZONE_ID",
  "body": {
    "type": "NETLIFY",
    "hostname": "example.familiarisenow.com",
    "value": "familiarise.netlify.app",
    "ttl": 3600
  }
}'

# Delete a DNS record (you need the record ID first)
netlify api deleteDnsRecord --data '{
  "zone_id": "$NETLIFY_DNS_ZONE_ID",
  "dns_record_id": "<record-id-from-get>"
}'
```

> **Gotcha:** The API method name is `deleteDnsRecord` (not `deleteDNSRecord` —
> case matters). Use `netlify api --list | grep -i dns` to find the exact method name.

---

## Setting Up dev.familiarisenow.com

This was the most complex part of the deployment setup. Here's the full story.

### Goal

We wanted:

- `familiarisenow.com` → serves the `prod` branch
- `dev.familiarisenow.com` → serves the `dev` branch (for staging/testing)

### What we tried (and what failed)

#### Attempt 1: `build_settings.branch_deploy_custom_domain` (nested)

```bash
netlify api updateSite --data '{
  "site_id": "...",
  "body": {
    "build_settings": {
      "branch_deploy_custom_domain": "dev.familiarisenow.com"
    }
  }
}'
```

**Result:** The field was silently ignored. `branch_deploy_custom_domain` came back
as `null`. The field is top-level on the site object, NOT nested under `build_settings`.

#### Attempt 2: Adding as `domain_aliases`

Adding `dev.familiarisenow.com` to the site's `domain_aliases` array would
provision SSL for it — but domain aliases always serve the **production** deploy,
not a branch deploy. This would have made `dev.familiarisenow.com` serve prod
content, the opposite of what we wanted.

#### Attempt 3: CNAME record to `dev--familiarise.netlify.app`

Creating a plain `CNAME` record:

```
dev.familiarisenow.com  CNAME  dev--familiarise.netlify.app
```

This would direct DNS correctly to the branch deploy URL, but Netlify won't
automatically provision an SSL certificate for a custom domain pointing via
CNAME unless the domain is also registered in the site's configuration.
Without SSL, browsers would show a certificate error.

#### What actually worked: top-level `branch_deploy_custom_domain`

The correct API call:

```bash
netlify api updateSite --data '{
  "site_id": "$NETLIFY_SITE_ID",
  "body": {
    "branch_deploy_custom_domain": "dev.familiarisenow.com"
  }
}'
```

This sets the `branch_deploy_custom_domain` field **at the top level** of the site
object. When set, Netlify:

1. Automatically creates `NETLIFY` type DNS records for `dev.familiarisenow.com`
   and `*.dev.familiarisenow.com`
2. Provisions SSL for these hostnames via Let's Encrypt
3. Routes all traffic to `dev.familiarisenow.com` to the `dev` branch deploy

> **Key lesson:** Always inspect the full site object (`netlify api getSite`) to
> understand which fields exist at which nesting level. Don't assume nested structure.

### How to inspect the full site object

```bash
netlify api getSite --data '{"site_id": "$NETLIFY_SITE_ID"}' \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
for k, v in d.items():
    if k not in ['published_deploy', 'user']:
        print(f'{k}: {json.dumps(v)[:120]}')
"
```

This is the fastest way to discover available configuration fields.

---

## GCP OAuth Configuration

Google OAuth requires the production domain to be registered as an
**Authorized JavaScript origin** and the BetterAuth callback route to be
registered as an **Authorized redirect URI**.

### Steps to update

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → **APIs & Services → Credentials**
2. Click the OAuth 2.0 Client ID named **`familiarise-web-client`** (the Web application type)
3. Under **Authorized JavaScript origins**, add:
   - `https://familiarisenow.com`
   - `https://dev.familiarisenow.com`
   - `http://localhost:3000` (already present for local dev)
4. Under **Authorized redirect URIs**, add:
   - `https://familiarisenow.com/api/auth/callback/google`
   - `https://dev.familiarisenow.com/api/auth/callback/google`
   - `http://localhost:3000/api/auth/callback/google` (local dev)
5. Click **Save**. Changes propagate within ~5 minutes.

### Why `/api/auth/callback/google`?

BetterAuth's Google provider uses the route `POST /api/auth/callback/google`
for the OAuth2 code exchange. This is handled by the catch-all route at
`app/api/auth/[...all]/route.ts`. If this URI is not whitelisted in GCP,
the Google OAuth flow will fail with `redirect_uri_mismatch`.

### Google Client ID and Secret

These are stored in Netlify env vars:

- `GOOGLE_CLIENT_ID` = stored in Netlify (see `netlify env:list --json` — look for the `384845845365-` prefix confirming it belongs to the `familiarise` GCP project)
- `GOOGLE_CLIENT_SECRET` = stored in Netlify (check `netlify env:list --json`)

> **Security note:** Never commit these to the repo. The `.env` file is gitignored
> for exactly this reason.

---

## The `netlify.toml` File

Located at the repo root. Minimal configuration — most settings are managed
via the Netlify dashboard/API rather than in this file.

```toml
[build]
  command = "npm run build"
  publish = ".next"

[build.environment]
  NODE_VERSION = "22"

# Skip Dependabot PR preview builds
[context.deploy-preview]
  ignore = "..."

[context.production]
  command = "npm run build"

[context.dev]
  command = "npm run build"
```

### What to add if you need branch-specific env vars

You can set env vars per-context in `netlify.toml`. These are merged with
the dashboard env vars (dashboard wins on conflict):

```toml
[context.dev.environment]
  NEXT_PUBLIC_APP_URL = "https://dev.familiarisenow.com"
  BETTER_AUTH_URL = "https://dev.familiarisenow.com"
```

> **Warning:** Do NOT put secrets in `netlify.toml` — it's committed to the repo.
> Only put non-sensitive values like `NEXT_PUBLIC_APP_URL` here.

### Build configuration in `next.config.mjs`

A few build-time settings that affect the deployed bundle now live in `next.config.mjs` rather than in any Netlify configuration. The navigation-performance work (PR #887) added or broadened the following, and the reasoning for each is recorded in [Navigation Performance](../performance/01-navigation-performance.md):

- `experimental.optimizePackageImports` tree-shakes large barrel imports (such as the icon, charting, and Stream React packages) so only the symbols actually used ship to the client.
- `experimental.staleTimes` lets the client router cache hold RSC payloads between navigations instead of refetching on every move, which is the single biggest contributor to instant in-app navigation.
- `serverExternalPackages` was broadened to keep server-only dependencies out of client bundles — this now covers `razorpay`, `stripe`, `resend`, `bcrypt`, `@stream-io/node-sdk`, and `libsodium-wrappers` alongside the existing Postgres adapter packages.
- `images.formats` requests AVIF and then WebP so Netlify's image pipeline serves the smaller modern format when the browser supports it.

These are application-level concerns rather than deployment concerns, so they are not duplicated in `netlify.toml`; they take effect automatically on every Netlify build because the build command runs `next build`.

---

## Deployment Workflow

### Normal feature → staging → production flow

```bash
# 1. Work on a feature branch
git checkout -b feat/my-feature dev
# ... make changes ...
git push origin feat/my-feature

# 2. Open a PR against dev
# GitHub will show a Netlify preview deploy URL for the PR

# 3. Merge to dev (after review)
git checkout dev && git merge feat/my-feature && git push origin dev
# → Automatically deploys to dev.familiarisenow.com

# 4. When ready for production, merge dev into prod
git checkout prod && git pull origin prod
git merge dev --no-edit
git push origin prod
# → Automatically deploys to familiarisenow.com

# 5. Return to dev for the next feature
git checkout dev
```

### Checking deploy status

```bash
# View recent deploys (non-interactive)
netlify api listSiteDeploys \
  --data '{"site_id": "$NETLIFY_SITE_ID"}' \
  | python3 -c "
import sys, json
for d in json.load(sys.stdin)[:8]:
    print(f'[{d[\"state\"]:12}] {d[\"branch\"]:12} {d[\"created_at\"][:19]}')
"
```

States you'll see:

- `building` — build in progress
- `ready` — deployed successfully
- `error` — build failed (check Netlify dashboard for logs)
- `skipped` — build skipped (e.g. Dependabot branch)

### Manual redeploy (without a code push)

Useful when you've changed env vars and need a rebuild:

```bash
netlify deploy --build --prod   # rebuild and deploy to production
netlify deploy --build          # rebuild and deploy to a draft URL first
```

---

## Gotchas, Errors & Debugging Log

### 1. `netlify env:list` hangs waiting for user input

**Problem:** `netlify env:list` shows a prompt "Show values? (y/N)" which hangs
in non-interactive scripts.

**Fix:** Always use `netlify env:list --json` to get machine-readable output
without prompts:

```bash
netlify env:list --json
```

---

### 2. `"You don't appear to be in a folder that is linked to a project"`

**Problem:** `netlify status` shows you're logged in but every command fails.

**Cause:** The local directory isn't linked to a Netlify site. The `.netlify/`
folder with `state.json` is missing.

**Fix:**

```bash
netlify link --id $NETLIFY_SITE_ID
```

This creates `.netlify/state.json` in the repo root (gitignored automatically).

---

### 3. `netlify api` method name casing

**Problem:** `netlify api deleteDNSRecord` → `"is not a valid api method"`

**Cause:** Method names use the OpenAPI camelCase operation IDs. DNS abbreviations
are mixed-case (`Dns` not `DNS`).

**Fix:** Use `netlify api --list | grep -i dns` to find exact names:

```
deleteDnsRecord    ← correct
deleteDNSRecord    ← wrong
```

---

### 4. `netlify api` with body fields in the wrong nesting level

**Problem:** Setting `build_settings.branch_deploy_custom_domain` silently
did nothing — the field came back as `null`.

**Cause:** `branch_deploy_custom_domain` is a **top-level** field on the site
object, not nested under `build_settings`. The Netlify UI and some docs imply
otherwise.

**Fix:** Inspect the raw site object first to see where fields live:

```bash
netlify api getSite --data '{"site_id": "..."}' | python3 -c "
import sys, json
d = json.load(sys.stdin)
for k, v in d.items():
    print(k, ':', str(v)[:80])
"
```

Then set the field at the correct level in `updateSite`.

---

### 5. NETLIFY-type DNS records always show `familiarise.netlify.app` as value

**Problem:** After setting `branch_deploy_custom_domain`, all DNS records
(including `dev.familiarisenow.com`) show `familiarise.netlify.app` as the
value — not `dev--familiarise.netlify.app`.

**Cause:** This is correct behaviour. The `NETLIFY` DNS record type lets Netlify
route internally at the edge level based on the hostname. The `value` field
always points to the main site's Netlify subdomain — Netlify handles the
branch routing server-side using the `branch_deploy_custom_domain` configuration.
Do not try to change the value to `dev--familiarise.netlify.app`.

---

### 6. JSON parse errors from `netlify api`

**Problem:** Parsing API output fails with `JSONDecodeError: Expecting value`.

**Cause:** Some Netlify API responses are empty strings `""` (for 204 No Content).
Others return arrays, not objects.

**Fix:**

```bash
# Handle potentially-array responses
netlify api getDNSForSite --data '...' | python3 -c "
import sys, json
data = json.load(sys.stdin)
obj = data[0] if isinstance(data, list) else data
# ... use obj
"
```

---

### 7. `BETTER_AUTH_URL` set to localhost in production

**Problem:** Sign-in works locally but fails on the live site with `"invalid origin"`.

**Cause:** `BETTER_AUTH_URL` was set to `http://localhost:3000` in the Netlify
env vars. This was accidentally copied from the local `.env` file when the
Netlify project was first configured.

**Fix:**

```bash
netlify env:set BETTER_AUTH_URL "https://familiarisenow.com" --context production
netlify env:set BETTER_AUTH_URL "https://familiarisenow.com" --context branch-deploy
```

> **Lesson:** Always audit your Netlify env vars after initial setup.
> Run `netlify env:list --json` and compare every URL-type variable against
> the actual production domain. `localhost` in any env var is a red flag.

---

### 8. `NETLIFY` type vs `CNAME` for branch subdomains

**Problem:** We tried creating a `CNAME dev.familiarisenow.com → dev--familiarise.netlify.app`
but this doesn't automatically provision SSL and doesn't tell Netlify to
serve the branch from this hostname.

**Correct approach:** Use the `branch_deploy_custom_domain` site setting.
Netlify then automatically creates the right DNS records (NETLIFY type)
and provisions SSL. Do not manually create DNS records for branch subdomains
— let Netlify manage them.

---

### 9. `NODE_ENV=production` breaks the build — missing devDependencies

**Problem:** After fixing `NODE_ENV` from `test` to `production` on Netlify,
ALL deploy previews started failing with:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@next/bundle-analyzer'
Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'autoprefixer'
```

**Root cause:** When `NODE_ENV=production`, npm's `install` command skips
`devDependencies`. Build-critical packages like `autoprefixer`, `postcss`,
`tailwindcss`, `typescript`, and `@next/bundle-analyzer` were all in
`devDependencies`. With `NODE_ENV=test` (the previous value), npm installed
everything — so the build worked by accident.

**Why it worked before:** `NODE_ENV` was set to `test` on Netlify, which
is not a special npm lifecycle value, so npm treated it as development
and installed all dependencies including devDependencies.

**Two fixes applied:**

1. **`NPM_FLAGS=--include=dev`** — Set as a Netlify env var. This tells
   npm to install devDependencies even when `NODE_ENV=production`. This
   is the standard fix for Next.js on Netlify since the build step needs
   TypeScript, PostCSS, Tailwind, etc.

   ```bash
   netlify env:set NPM_FLAGS "--include=dev"
   ```

2. **Guarded `@next/bundle-analyzer` import** — Changed `next.config.mjs`
   from an unconditional top-level `import` to a conditional dynamic
   `await import()` that only loads when `ANALYZE=true`:

   ```javascript
   // BEFORE (breaks when package not installed)
   import bundleAnalyzer from "@next/bundle-analyzer";
   const withBundleAnalyzer = process.env.ANALYZE === "true"
     ? bundleAnalyzer({ enabled: true })
     : (config) => config;

   // AFTER (safe — never loads unless ANALYZE=true)
   const withBundleAnalyzer = process.env.ANALYZE === "true"
     ? (await import("@next/bundle-analyzer")).default({ enabled: true })
     : (config) => config;
   ```

**Key lesson:** When setting `NODE_ENV=production` on any hosting platform,
always ensure build tools in `devDependencies` are still installed. Either:
- Set `NPM_FLAGS=--include=dev` (recommended for Next.js)
- Or move build-critical packages to `dependencies` (not recommended —
  conflates runtime and build concerns)

**Packages that MUST be available at build time (currently in devDependencies):**

| Package | Why it's needed at build time |
|---------|------------------------------|
| `typescript` | Next.js compiles TypeScript during `next build` |
| `autoprefixer` | PostCSS plugin loaded by Tailwind CSS |
| `postcss` | CSS processing during build |
| `tailwindcss` | Utility CSS generation |
| `@types/node` | TypeScript type definitions |
| `@types/react` | TypeScript type definitions |
| `@types/react-dom` | TypeScript type definitions |
| `@next/bundle-analyzer` | Optional — only if `ANALYZE=true` (now guarded) |

---

## Checklist for New Environments

If you ever need to set up a new deployment environment (e.g. `staging.familiarisenow.com`),
follow this checklist:

- [ ] Create the git branch (e.g. `staging`)
- [ ] Add it to `netlify api updateSite` `build_settings.allowed_branches`
- [ ] If using a custom domain, set `branch_deploy_custom_domain` or `deploy_preview_custom_domain` at the site level
- [ ] Run `netlify env:set BETTER_AUTH_URL "https://staging.familiarisenow.com" --context branch-deploy`
- [ ] Run `netlify env:set BETTER_AUTH_TRUSTED_ORIGINS "..." --context branch-deploy`
- [ ] Run `netlify env:set NEXT_PUBLIC_APP_URL "https://staging.familiarisenow.com" --context branch-deploy`
- [ ] Update GCP OAuth credentials to add the new origin and redirect URI
- [ ] Verify env vars: `netlify env:list --json | grep -i auth`
- [ ] Ensure `NPM_FLAGS=--include=dev` is set (required for Next.js builds with `NODE_ENV=production`)
- [ ] Push a commit to the branch and confirm the Netlify deploy succeeds
- [ ] Visit the new URL and confirm sign-in works end-to-end

---

## Quick Reference Commands

```bash
# Check current status
netlify status
netlify env:list --json

# Fix auth env vars (replace URL as needed)
netlify env:set BETTER_AUTH_URL "https://familiarisenow.com" --context production
netlify env:set BETTER_AUTH_URL "https://familiarisenow.com" --context branch-deploy
netlify env:set BETTER_AUTH_TRUSTED_ORIGINS "https://familiarisenow.com" --context production
netlify env:set NEXT_PUBLIC_APP_URL "https://familiarisenow.com" --context production

# Remove a stale variable
netlify env:unset OLD_VARIABLE_NAME

# Inspect site configuration
netlify api getSite --data '{"site_id": "$NETLIFY_SITE_ID"}' | python3 -m json.tool

# Inspect DNS records
netlify api getDNSForSite --data '{"site_id": "$NETLIFY_SITE_ID"}' | python3 -m json.tool

# Set branch deploy custom domain
netlify api updateSite --data '{
  "site_id": "$NETLIFY_SITE_ID",
  "body": { "branch_deploy_custom_domain": "dev.familiarisenow.com" }
}'

# Recent deploys
netlify api listSiteDeploys --data '{"site_id": "$NETLIFY_SITE_ID"}' \
  | python3 -c "import sys,json; [print(d['state'],d['branch'],d['created_at'][:19]) for d in json.load(sys.stdin)[:5]]"

# Trigger a manual production redeploy
netlify deploy --build --prod
```
