---
name: prisma-seed-sync
description: Bring the modular seed suite (prisma/seed.ts + prisma/seedFiles/N*-create-*.ts) back in sync with the Prisma schema and generate realistic consultation-platform mock data — after schema changes, when seeds fail to compile, or when new models need coverage. Validates with tsc + eslint and only ever seeds a database the user has confirmed is disposable (DATABASE_URL here points at remote Supabase — never reset it unprompted). Use when the user says "update the seeds", "sync seed data with the schema", "my seed file won't compile", or "add seed data for <model>".
argument-hint: "[optional: models/areas to focus on, e.g. 'Contract + Program']"
---

# Prisma Seed Sync (schema → seed suite)

Keep `prisma/seed.ts` and `prisma/seedFiles/` compiling against the current schema and producing realistic data for this consultation/mentorship platform. If `$ARGUMENTS` names models, focus there but still fix any compile breakage elsewhere in the suite.

## Guardrails (read first)

- **The configured DB is shared.** `DATABASE_URL`/`DIRECT_URL` in `.env` point at the remote Supabase pooler — NOT a local throwaway. Never run `prisma migrate reset`, `prisma db push --force-reset`, or a seed against it without the user explicitly confirming the target DB is disposable. Before any destructive command, print the masked host (`grep '^DATABASE_URL' .env | sed -E 's|//[^@]*@|//***@|'`) and ask. Prefer a Supabase branch DB or a local stack for seed runs.
- **The seed entry point is `npm run db:seed`** (`npx tsx prisma/seed.ts`). There is **no** `prisma.seed` key in package.json, so `npx prisma db seed` fails — don't use it. Sizes: `db:seed:small` / `db:seed:medium` / `db:seed:large` (SEED_MODE, parsed in `prisma/seedFiles/config.ts`); edge-case data: `db:seed:validation`.
- **No faker.** The suite uses its own helpers in `prisma/seedFiles/utils.ts` (random selection, date spreads, weighted choices) and quantity knobs in `config.ts`. Extend those; don't add a dependency.
- **Never set human-readable primary keys** on `Appointment`, `Consultation`, `Subscription`, `Webinar`, or `Class` for rows that hit real allocate/validate APIs. Those routes validate UUID/CUID via `eventIdSchema` / `isEventIdFormat` — strings like `mock0801-appt-pending` or `appt-1` 400 on save. Always omit `id` and let Prisma generate `@default(uuid())` / `@default(cuid())`. Unit-test mocks that never call those routes may still use readable ids.
- **Schema conventions** (if the task includes schema edits): enums are declared *below* the model(s) that use them; no backfill migrations (a pre-MVP DB reset is planned); comments are terse and explain *why*, referencing issues as `#N`.
- **Don't renumber existing modules.** New models get a new file in the next number band; related sub-entities share the number with a letter suffix (`15a-`, `15b-`).

## Step 1 — Diff schema vs seeds

1. Read `prisma/schema.prisma` — or better, `git diff` it against the last commit where seeds compiled — to list new/changed/removed models, fields, enums, and relations.
2. Map the suite: `prisma/seed.ts` imports the numbered modules in dependency order (users → profiles/credentials → topics → plans → availability → appointments → engagement → payments → tickets → waitlists → sessions → refunds/disputes → payouts/earnings → referrals/collaborators → organizations/enterprise). The orchestrator's call order IS the FK dependency order — a new model slots in after everything it references.
3. Regenerate the client so types match the schema: `npx prisma generate`.

## Step 2 — Update the seed modules

Per affected model, follow the established module shape: one `export async function createXxx(deps…)` per file, take parent entities as parameters, return created rows for downstream modules, log progress, scale counts off `config.ts`'s SEED_MODE.

Data realism for this domain (vary, don't clone):
- **People**: a handful of consultants across specializations/experience/ratings, more consultees, 1–2 admins; WEEKLY vs CUSTOM schedules.
- **Offerings**: consultation/subscription/webinar/class plans across realistic price bands and durations.
- **Bookings**: past + current + future; every AppointmentStatus represented; DIRECT_CHECKOUT and REQUEST_SUBMITTED sources.
- **Money**: multiple gateways (RAZORPAY paise-denominated especially), SUCCEEDED/PENDING/FAILED, a few refunds (partial + full), 1–2 disputes in different states — amounts must keep ledgers balanced if ledger postings are seeded.
- **Enterprise** (15-band): organizations across statuses/funding sources, contracts → programs → assignments respecting the activation chain.
- **Temporal spread**: createdAt over months, expirations both passed and upcoming; edge cases (expired, archived, free-tier) in small counts.

## Step 3 — Validate (no DB needed)

```bash
npx tsc --noEmit                       # bump heap if node aborts: NODE_OPTIONS="--max-old-space-size=8192"
npx eslint prisma/seed.ts prisma/seedFiles/   # lint ONLY the seed suite — full `npm run lint` is slow and noisy
```

Fix everything before touching a database. Most failures are: stale client (re-run `prisma generate`), missing new required fields, enum value drift, FK order.

## Step 4 — Seed run (only against a confirmed-disposable DB)

After the user confirms the target (per the guardrail): `npm run db:seed:small` first — it surfaces FK/unique violations fastest — then the size the user wants. A clean run plus spot-check counts (`createXxx` logs) is the pass signal.

## Step 5 — Report

Summarize: schema changes covered, modules created/updated/untouched, validation results (tsc / eslint / seed run or "seed run skipped — no disposable DB confirmed"), notable data-shape decisions, and anything deferred. Leave committing to the user.
