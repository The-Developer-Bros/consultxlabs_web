# Cutover: from `db push` to versioned migrations

This is the launch-day runbook for putting the database under versioned
migrations. It is the successor to `02-pre-mvp-reset-runbook.md`: the reset
finalises the schema shape, and this cutover makes every change after it
reviewable, ordered and replayable.

Run it once, after the reset and before the first real customer row exists.

## Why the current posture expires

The schema is managed with `prisma db push` and there is no `prisma/migrations`
directory. That is a deliberate choice and it is defensible only while the data
is disposable: a push reconciles the database to the schema file, writes no
history, and drops anything the schema does not mention. Three properties of it
become unacceptable the moment a paying customer's row exists.

There is no history, so there is no way to know which change reached which
environment or when, and no artefact to review. There is no generated SQL to
read before it runs, so a rename that Prisma expresses as a drop and a create is
applied as a drop and a create with nothing in between to catch it. And there is
no separation between environments, because a push targets whatever database the
connection string names.

Versioned migrations fix all three, at the cost of a migration file per change.
That is the trade this runbook executes.

## Preconditions

Do not start until every one of these holds, because the baseline captures
whatever state the database is in and a wrong baseline is very hard to unpick.

1. The pre-MVP reset in `02-pre-mvp-reset-runbook.md` is complete, including the staged constraint block and the legacy index removal.
2. `npm run db:assert-sidecars` passes.
3. `npx tsx scripts/ci/check-db-drift.ts` passes, and `prisma/sql/known-drift.json` contains no unexpired entries.
4. A fresh backup exists and its identifier is recorded in the cutover ticket.
5. No other schema-bearing pull request is in flight. One Postgres project serves both environments, so this is a production operation with a single writer.

## Step 1 — Confirm the schema file matches the database

The baseline is generated from `prisma/schema.prisma`, so any divergence between
the file and the live database is silently baked into it.

```sh
npx prisma db pull --print > /tmp/introspected.prisma
```

Compare it against `prisma/schema.prisma`. Differences in model ordering,
formatting and `@map` naming are expected and harmless. Differences in columns,
types, nullability or indexes are not: resolve each one before continuing, and
prefer changing the file over changing the database, since the file is what the
application is built against.

## Step 2 — Generate the baseline migration

The `0_` prefix keeps the baseline first in filename order, ahead of every
timestamped migration that follows.

```sh
mkdir -p prisma/migrations/0_init

npx prisma migrate diff \
  --from-empty \
  --to-schema prisma/schema.prisma \
  --script > prisma/migrations/0_init/migration.sql
```

## Step 3 — Append the sidecars to the baseline

**This step is specific to this repository and it is the one that is easy to
miss.** The Prisma schema cannot express constraint triggers, `CHECK`
constraints or partial indexes, so `migrate diff` does not emit them. A database
rebuilt from a baseline without them comes up with no `slot_no_confirmed_overlap`
and none of the money invariants — structurally identical, and missing every
guarantee that stops a double booking or an unbalanced payment.

Append the three sidecar files to the baseline so that the migration is a
complete description of the database.

```sh
{
  echo ""
  echo "-- Sidecar objects. These are not expressible in the Prisma schema, so"
  echo "-- migrate diff does not generate them; see prisma/sql/ for the sources."
  cat prisma/sql/check-constraints.sql
  cat prisma/sql/ledger-triggers.sql
  cat prisma/sql/payment-legs-triggers.sql
} >> prisma/migrations/0_init/migration.sql
```

Read the result before continuing. The sidecar files are written to be
re-runnable against a live database, so they contain guards such as
`DROP TRIGGER IF EXISTS` that are harmless in a baseline but should be
understood rather than skimmed. The staged block at the end of
`check-constraints.sql` must be uncommented by then, because the reset is a
precondition of this runbook.

## Step 4 — Mark the baseline as applied

The database already has this schema, so the SQL must be recorded as applied
rather than executed. This is the step that adopts the existing database instead
of recreating it.

```sh
npx prisma migrate resolve --applied 0_init
npx prisma migrate status
```

`migrate status` must report that the database schema is up to date. Because one
project serves both environments, this `resolve` runs exactly once. Any
environment created from scratch afterwards gets the same SQL applied by
`prisma migrate deploy` instead, which is what makes one baseline serve both
cases.

## Step 5 — Retire the push scripts

Leaving `db:push` available after the cutover is how a database ends up drifting
from its own migration history within a month. Change `package.json` so that the
default path is the migration path.

| Script                              | After the cutover                                                           |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `db:push`                           | Removed. Replaced by `db:migrate:dev` for local work.                       |
| `db:push:schema`                    | Removed.                                                                    |
| `db:push:no-sidecars-DANGEROUS`     | Removed. There is no remaining use for it.                                  |
| `db:migrate:dev`                    | `prisma migrate dev` — local development only, against a local database.    |
| `db:migrate:deploy`                 | `prisma migrate deploy` — CI only.                                          |
| `db:sidecars`, `db:assert-sidecars` | Kept. Sidecars applied by a migration still need asserting after a restore. |

`prisma migrate dev` resets the database whenever it detects drift, so it must
never be pointed at the shared project. The cutover is therefore also the point
at which local development needs its own database — a local PostgreSQL container
is sufficient, and it removes the largest standing hazard in the current setup.

## Step 6 — Gate deploys on the migration

Migrations run in CI, once per release, before the new build takes traffic.
Never in the Netlify build command: builds run for preview deployments too, they
can run concurrently, and a build that succeeds does not imply a deploy that
does.

```yaml
# .github/workflows/release.yml
jobs:
  migrate:
    runs-on: ubuntu-latest
    concurrency:
      group: migrate-production
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx prisma migrate status
        env: { DIRECT_URL: "${{ secrets.DIRECT_URL }}" }
      - run: npx prisma migrate deploy
        env: { DIRECT_URL: "${{ secrets.DIRECT_URL }}" }
      - run: npm run db:assert-sidecars
        env: { DATABASE_URL: "${{ secrets.DATABASE_URL }}" }
```

`prisma migrate deploy` needs the session-mode or direct connection in
`DIRECT_URL`; DDL through the transaction pooler either fails with a prepared
statement error or hangs. The existing `check-db-sidecars` and `check-db-drift`
guards in `ci.yaml` stay exactly as they are — after the cutover they are
checking a stronger invariant, because drift now means someone bypassed the
migration system.

## Step 7 — Quiesce background work before a heavy migration

Every scheduled job checks `abortIfMaintenance()` at startup, so maintenance
mode is the lever for stopping the long transactions a migration would otherwise
queue behind. This matters because PostgreSQL grants locks in FIFO order: a DDL
statement waiting on a cron job's open transaction blocks every query that
arrives after it, including reads.

For a migration that only adds nullable columns or tables, no gating is needed.
For anything that takes `ACCESS EXCLUSIVE` on a populated table, use `DEGRADED`
so the site stays readable, or `OFFLINE` if writes must stop entirely; the
distinction is documented in `../maintenance/02-degraded-vs-offline.md`. Enter
maintenance, wait about two minutes for in-flight jobs to drain, check for open
transactions, run the migration, verify, and leave maintenance.

```sql
-- Anything old here will block the migration. Check before, not after.
SELECT pid, state, now() - xact_start AS age, left(query, 80) AS query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
  AND now() - xact_start > interval '30 seconds'
ORDER BY age DESC;
```

Set `lock_timeout` at the top of any migration that touches a populated table,
so that a blocked statement fails fast and is retried rather than forming a
queue behind itself.

```sql
SET lock_timeout = '3s';
SET statement_timeout = '30s';
```

## Step 8 — Verify

The cutover is complete when all four of these hold.

```sh
# 1. History is clean and nothing is pending.
npx prisma migrate status

# 2. No difference remains between the schema file and the database.
npx prisma migrate diff \
  --from-schema prisma/schema.prisma \
  --to-config-datasource \
  --script
# Expect empty output.

# 3. Every sidecar object is present.
npm run db:assert-sidecars

# 4. The guards CI runs still pass.
npx tsx scripts/ci/check-db-sidecars.ts
npx tsx scripts/ci/check-db-drift.ts
```

Then exercise one read path and one write path over a table with a sidecar
constraint on the deployed build, because a clean migration and a regenerated
client can still disagree, and the write path is where that surfaces.

## After the cutover

Every schema change becomes a reviewed migration file, and the rules in the
`/schema` skill start applying in full rather than in the reduced form the
current posture allows. In particular, renames and drops stop being forbidden
and start being three-deploy sequences, which is the point of doing this at all.
Generate every migration with `--create-only`, read the SQL, and replace any
drop-and-create that was meant to be a rename before it is applied.

One coexistence note for later. If the Directus CMS in
`../roadmap/content-strategy/01-directus-cms-setup.md` is ever deployed against
this database — it is at design status today, with no credentials configured —
it will own its own `directus_*` and `cms_*` tables that Prisma does not model.
Those would appear as permanent drift and must be recorded in
`prisma/sql/known-drift.json` with an owner and an expiry, and `prisma db pull`
would need reviewing for them. `prisma migrate reset` against a shared database
would destroy them outright, which is one more reason it has no production use.

## Related documents

The general reference for every command used here is `01-migrations-guide.md`. The
reset this runbook depends on is `02-pre-mvp-reset-runbook.md`. The portable
doctrine — expand and contract, the lock classes, the deploy ordering — is the
`/schema` skill in `.claude/skills/schema/`, and its `references/this-repo.md`
summarises the posture this runbook replaces.
