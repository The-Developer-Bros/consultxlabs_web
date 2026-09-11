---
name: netlify-env-sync
description: Audit and synchronize environment variables from the local .env to the Netlify production deployment — diff the two sets, categorize every variable (missing / localhost-valued / dev-only / wrong / Netlify-only / in-sync), present a masked report, PAUSE for approval, then apply the fixes scoped to the production context and verify. Use when the user says "sync env vars to Netlify", "check the Netlify env vars", "did I push that key to prod", or after adding a new service key to .env.
argument-hint: "[optional: specific variable names to focus on]"
---

# Netlify Env Var Sync (local `.env` → production)

Make the Netlify production deployment's env vars correct, complete, and secure, using the local `.env` as the source of truth for what the app needs. If `$ARGUMENTS` names specific variables, focus the audit on those but still flag anything obviously broken.

## Guardrails (read first)

- **One direction only: `.env` → Netlify.** Never modify the local `.env`, and never copy Netlify-only values down into it.
- **Scope every mutation to the production context.** Always pass `--context production` to `env:set` / `env:unset` — an unscoped set clobbers the value in ALL deploy contexts (deploy-preview, branch-deploy, dev).
- **Pause before mutating.** Present the full report first and wait for explicit approval. Only then run `env:set`/`env:unset`.
- **Never print full secret values.** Mask everything in reports and command echoes: API keys → first 8 chars + `…`, passwords → `****`, DB URLs → host only, JWT/HMAC secrets → `[n-char secret]`.
- **Flag, don't fix** anything that may be an intentional pre-launch state: test payment keys (`rzp_test_*`, `sk_test_*`), empty OAuth credentials, environment-split values (e.g. different Sentry DSNs).

## Step 1 — Discover

1. Read `.env` at the project root. Parse `KEY=VALUE` pairs (skip comments/blanks; values may be quoted). If `.env` is missing, stop and report.
2. Confirm CLI auth + detect the production URL — don't hardcode it:
   ```bash
   npx netlify-cli status 2>&1        # not authenticated → tell user to run: ! npx netlify-cli login
   ```
   Extract the Project URL (currently `https://familiarisenow.com`).
3. List Netlify's production-context values:
   ```bash
   npx netlify-cli env:list --context production --plain 2>&1
   ```

## Step 2 — Categorize every variable

| Category                    | Test                                                                                                           | Action                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Missing from Netlify**    | In `.env`, not on Netlify                                                                                      | Add with the `.env` value (rewrite URLs per below first)                                                                   |
| **Localhost value on prod** | Value contains `localhost`, `127.0.0.1`, or plain `http://`                                                    | Rewrite to the production URL (`BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`, `NEXT_PUBLIC_APP_URL`, any URL-typed var) |
| **Dev/test-only on prod**   | `SEED_PASSWORD`, `NEXT_PUBLIC_TEST_USERID`, `REDIS_URL` (localhost redis — prod uses `UPSTASH_REDIS_REST_URL`) | Remove from Netlify                                                                                                        |
| **Wrong value**             | `NODE_ENV` ≠ `production`; empty strings; values that look truncated                                           | Fix `NODE_ENV`; flag the rest                                                                                              |
| **Test keys / pre-launch**  | `rzp_test_*`, `sk_test_*`, empty OAuth                                                                         | **Flag only — never auto-fix**                                                                                             |
| **Netlify-only**            | On Netlify, not in `.env` (`CI`, `NODE_VERSION`, Netlify-injected build vars)                                  | List, don't touch                                                                                                          |
| **In sync**                 | Same key, appropriate value both sides                                                                         | Count only                                                                                                                 |

Security sweep while categorizing: every `NEXT_PUBLIC_*` value ships to the browser — if one holds what looks like a secret (not a publishable key), flag it **critical**.

## Step 3 — Report, then PAUSE

Present one table: variable, category, masked current value, proposed action. End with counts (in-sync, Netlify-only). **Stop and wait for approval before any mutation.**

## Step 4 — Execute (after approval)

```bash
npx netlify-cli env:set KEY "<value>" --context production           # add / fix, non-sensitive only
npx netlify-cli env:unset KEY --context production                   # remove dev-only
```

Never put a live secret on the command line. A shell argument is visible to every process on the box, lands in the shell history file, and is echoed back into this transcript — set payment, database, and auth secrets through the Netlify UI or `--secret` (which stores them write-only) instead, and paste the value there rather than here. The placeholders above are literal: substitute the real value only in an interactive prompt or the UI, never in a command a transcript will capture.

Quote values carefully (URLs with `&`, JSON blobs). Skip everything in the flag-only bucket.

## Step 5 — Verify

Re-run `npx netlify-cli env:list --context production --plain` and confirm every approved change landed. Report: actions taken, warnings still open (test keys, empty OAuth), anything that couldn't be fixed and why. Remind the user that env changes only take effect on the **next deploy** — offer to trigger one (`npx netlify-cli deploy --build --prod`) but don't do it unasked.

## Self-check before finishing

- [ ] Every `.env` var is on Netlify or intentionally dev-only
- [ ] No `localhost`/`127.0.0.1` values in the production context
- [ ] `NODE_ENV=production`; no `SEED_PASSWORD`/`NEXT_PUBLIC_TEST_USERID`/localhost `REDIS_URL`
- [ ] All `NEXT_PUBLIC_*` values are safe to expose
- [ ] No secret was printed unmasked anywhere in the conversation
