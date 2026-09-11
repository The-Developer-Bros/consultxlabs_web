# CI & Deployment

| Field | Value |
|---|---|
| Status | Stable |
| Audience | All engineers, SREs |
| Last reviewed | 2026-04-26 |
| Source files | `.github/workflows/ci.yaml`, `.github/workflows/sso-cert-expiry-alert.yml`, `Dockerfile`, `Dockerfile.prod`, `docker-compose.yml`, `docker-compose.prod.yml`, `netlify.toml`, `.env.sample` |

## 1. Background

This doc covers how auth code is validated in CI, how the application is containerized, and how it deploys — with focus on auth-related concerns (env vars, SSO cron jobs, secret rotation).

## 2. CI Pipeline

### 2.1 Main CI (`ci.yaml`)

Triggers on PRs to `dev`, `staging`, `prod`. Two parallel jobs:

**Job 1: `lint`**
- Prettier format check
- ESLint check (non-blocking — warnings reported in summary)

**Job 2: `test-and-build`**
- TypeScript check (`tsc --noEmit`)
- Prisma client generation
- **SSO invariants check** (`bash scripts/verify-sso-invariants.sh`) — static guard against SSO regressions
- Unit tests (`npm run test`) — includes `__tests__/sso/` suite
- Production build (`npm run build`)

Services: Redis container for rate-limit tests.

Env: `.env` loaded from `secrets.ENV_FILE` (base64-encoded).

> [!IMPORTANT]
> Dependabot PRs skip CI (`if: github.actor != 'dependabot[bot]'`). Dependabot also skips Netlify deploy previews (see `netlify.toml`).

### 2.2 SSO Cert Expiry Alert (`sso-cert-expiry-alert.yml`)

**Schedule:** Daily at 08:30 IST (03:00 UTC).

Runs `jobs/cleanup/sso-cert-expiry-alert.ts` which scans all `SsoProvider` rows for SAML certs approaching expiry. Alerts are logged to stdout (Slack integration is TODO).

Required secrets: `DATABASE_URL`, `DIRECT_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.

### 2.3 Other Auth-Adjacent Workflows

| Workflow | Schedule | Relevance |
|---|---|---|
| `cleanup-auth-tokens.yml` | Scheduled | Purges expired BetterAuth tokens |
| `cleanup-stale-invitations.yml` | Scheduled | Removes expired org invitations |
| `claude-code-review.yml` | On demand (`workflow_dispatch`) | Optional supplementary AI review; CodeRabbit is the reviewer of record on every PR, including auth changes |

## 3. Docker

### 3.1 Development (`Dockerfile` + `docker-compose.yml`)

```
node:20-alpine + libc6-compat + python3 + make + g++
→ npm ci → prisma generate → COPY . .
→ CMD npm run dev
```

- Source mounted as volume (`.:/app`) for hot reload
- `WATCHPACK_POLLING=true` for container filesystem watching
- Health check: `GET /api/health` every 30s

### 3.2 Production (`Dockerfile.prod` + `docker-compose.prod.yml`)

Three-stage build for minimal image:

| Stage | Purpose |
|---|---|
| `deps` | Install dependencies (with native build tools) |
| `builder` | Generate Prisma client, build Next.js (`npm run build`) |
| `runner` | Copy only `.next/`, `node_modules/`, `prisma/`, `public/` — run as non-root `nextjs` user |

Build args for public env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_STREAM_API_KEY`, `NEXT_PUBLIC_SENTRY_DSN`.

Run locally:
```bash
# Dev
docker compose up

# Prod
docker compose -f docker-compose.prod.yml up --build
```

## 4. Deployment (Netlify)

Primary deployment target is **Netlify** via `netlify.toml`:

- Node 22, `--max-old-space-size=4096`
- Build: `npm run build`, publish: `.next`
- Branches: `prod` (production), `dev` (development)
- Dependabot branches skip deploy previews

## 5. Auth-Related Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `BETTER_AUTH_SECRET` | Yes | 32+ char secret for signing sessions. Generate: `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | Yes | Canonical base URL (e.g., `https://familiarisenow.com`) |
| `BETTER_AUTH_TRUSTED_ORIGINS` | No | Comma-separated additional CORS origins (preview deploys) |
| `NEXT_PUBLIC_APP_URL` | Yes | Public app URL (used by auth client + SSO URL derivation) |
| `GOOGLE_CLIENT_ID` / `_SECRET` | Yes | Google OAuth |
| `GITHUB_CLIENT_ID` / `_SECRET` | Yes | GitHub OAuth |
| `FACEBOOK_CLIENT_ID` / `_SECRET` | Yes | Facebook OAuth |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | Yes | Rate limiting (edge + handler) |
| `DATABASE_URL` | Yes | Postgres (session storage, user data) |

> [!WARNING]
> **`BETTER_AUTH_SECRET` rotation** requires invalidating all existing sessions. Coordinate with ops — users will be logged out.

## 6. Secret Rotation Runbook

| Secret | Rotation impact | Steps |
|---|---|---|
| `BETTER_AUTH_SECRET` | All sessions invalidated | 1. Generate new secret. 2. Update env. 3. Deploy. 4. All users re-login. |
| OAuth client secrets | OAuth sign-in breaks until updated | 1. Rotate in provider console. 2. Update env. 3. Deploy. |
| SAML certs | SSO sign-in breaks for the org | 1. Org admin uploads new cert in IdP. 2. Update `SsoProvider.samlConfig.cert` via API or DB. 3. Test with a non-enforced user first. |
| `UPSTASH_REDIS_*` | Rate limits stop working (fail-open) | 1. Create new Redis instance. 2. Update env. 3. Deploy. Old limits naturally expire. |

## 7. Related Docs

- [05-testing.md](./05-testing.md) — Test suite details
- [sso/README.md](./sso/README.md) — SSO cert rotation specifics
- [docs/infrastructure/](../../infrastructure/) — Redis, deployment topology
