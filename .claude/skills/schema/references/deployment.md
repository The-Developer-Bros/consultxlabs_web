# Shipping the change

A safe migration applied at the wrong moment is still an outage. This reference
covers the ordering between the database change and the application deploy, and
it is deliberately host-agnostic: the rules are identical on Vercel, Netlify,
Fly, Render, Railway, Heroku, a Kubernetes cluster or a plain virtual machine,
and only the mechanism for running a command at the right point in the release
differs.

## The N-1 compatibility rule

Because the database and the application never change at the same instant, the
schema must be compatible with two versions of the application at once: the one
currently deployed and the one about to be. This is the rule that determines
deploy order, and it has a simple test — for the change you are about to make,
ask what happens if it lands while the old code is still serving traffic, and
what happens if the new code deploys before the migration runs. If either answer
is an error, the change is not yet decomposed enough.

Rolling deploys are not the only reason. A queued background job holds a
serialized payload written by old code. A webhook provider retries a delivery
hours later against an endpoint that has since been redeployed. A serverless
platform can keep a warm instance of the previous version alive for minutes
after a deploy completes. Every one of these executes old code against the new
schema.

## Migrate before, or deploy first?

The answer follows from the class of change, and there are only two cases.

Additive and widening changes migrate first. A new nullable column, a new table,
a new index, or a relaxed constraint cannot break the old code, because the old
code does not know they exist. Running the migration before the deploy means the
new code finds the schema it expects the moment it starts.

Destructive and narrowing changes deploy first. Dropping a column, tightening a
constraint or removing an enum value must wait until no running instance depends
on the old shape, which means the code that stopped depending on it has to be
fully rolled out first — and, for anything with retries or queues, has to have
been rolled out for long enough that nothing old is still in flight.

Stated as one rule: the database leads on expand and follows on contract. If a
release seems to need both at once, it has not been split into an expand release
and a contract release yet.

## Where the migration command runs

The mechanism differs per host, but the requirement is the same everywhere: run
`prisma migrate deploy` exactly once per release, after the build has succeeded
and before the new version starts taking traffic, using a direct database
connection.

| Host                | The right hook                                                                        |
| ------------------- | ------------------------------------------------------------------------------------- |
| Fly.io              | `deploy.release_command` in `fly.toml` — runs once, and aborts the deploy on failure. |
| Render              | The pre-deploy command on the service.                                                |
| Heroku              | The `release` phase in the Procfile.                                                  |
| Kubernetes          | A `Job`, or a Helm pre-upgrade hook, gated before the rollout.                        |
| Vercel, Netlify     | No native release phase; run it from CI before triggering or promoting the deploy.    |
| Container platforms | An init container or an entrypoint guarded so only one replica runs it.               |

On platforms with no release phase, the common shortcut is to put
`prisma migrate deploy` in the build command. It mostly works and it is wrong in
three ways that eventually bite. Builds run for preview and pull-request
deployments too, so a feature branch migrates the production database. Builds
can run concurrently, so two of them race. And a build that succeeds does not
imply a deploy that succeeds, so the schema can advance for a release that never
goes live. Running it as an explicit CI step, against an environment-specific
connection string, avoids all three.

```yaml
# A host-agnostic release job. The deploy is gated on the migration.
name: release
on:
  push:
    branches: [main]

jobs:
  migrate:
    runs-on: ubuntu-latest
    concurrency:
      # One migration at a time per environment, never two in parallel.
      group: migrate-production
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - name: Report what is pending before changing anything
        run: npx prisma migrate status
        env:
          DIRECT_URL: ${{ secrets.DIRECT_URL }}
      - name: Apply
        run: npx prisma migrate deploy
        env:
          DIRECT_URL: ${{ secrets.DIRECT_URL }}

  deploy:
    needs: migrate
    runs-on: ubuntu-latest
    steps:
      - run: echo "Trigger or promote the platform deploy here."
```

Prisma takes an advisory lock during `migrate deploy` so that two concurrent
runs cannot apply the same migration twice, but relying on that alone means the
loser waits and may time out. A CI concurrency group is the clearer control, and
it also serialises the human case of two people deploying at once.

## Pooled and direct connections

A connection pooler in **transaction** pooling mode breaks DDL, because a
session-level operation can be handed a different backend connection than the
one it started on. This is a property of transaction pooling itself rather than
of any particular vendor, and it applies equally to PgBouncer, Supavisor, RDS
Proxy and pgpool.

Pooling is common but not universal, so the second URL is conditional rather
than mandatory. AWS RDS and Cloud SQL expose direct instance endpoints and treat
pooling as opt-in — RDS Proxy is a separate resource, and Cloud SQL's managed
pooler listens on its own port — so a deployment that connects straight to the
instance needs no second URL at all. Supabase and Neon route through a pooler by
default, so there it is required.

Add a separate CLI connection string when either of two things is true: the
application connects through a transaction-mode pooler, or the provider exposes
a distinct session-mode endpoint. When it applies, the arrangement is the
familiar two-URL one — the application uses the pooled URL because it opens many
short-lived connections, and the CLI uses the direct or session-mode URL for
every migration, introspection and diff.

```sh
# Application runtime: pooled, transaction mode.
DATABASE_URL="postgresql://user:pass@host:6543/db?pgbouncer=true"

# Prisma CLI: direct or session mode. Never the transaction pooler.
DIRECT_URL="postgresql://user:pass@host:5432/db"
```

Note that "direct" here means "not transaction-pooled", which is not the same as
"not pooled". A session-mode pooler endpoint is perfectly adequate for DDL and is
what several providers hand you when you ask for a direct URL — this repository's
own `DIRECT_URL` is one, as `references/this-repo.md` records. What matters is
session mode, not the absence of a proxy.

In Prisma 7 the CLI reads `datasource.url` from `prisma.config.ts`, so that is
where the direct string belongs; in Prisma 6 it was `directUrl` in the schema's
datasource block. The `?pgbouncer=true` parameter tells Prisma Client to stop
using prepared statements, which is what makes transaction pooling work at
runtime — and it is a runtime setting, not a migration one.

Two symptoms identify a migration accidentally running through the pooler. A
`prepared statement "s0" already exists` error, and a migration that hangs
indefinitely rather than failing. Both mean the connection string is wrong.

## Timeouts and long transactions

Set `lock_timeout` inside migrations that touch populated tables, as described
in `change-catalog.md`, so that a blocked statement fails fast instead of
building a lock queue. Then check what is holding transactions open before
migrating, because that is what the DDL will wait behind.

```sql
-- Anything old here will block a migration. Look before you deploy.
SELECT pid, state, now() - xact_start AS age, left(query, 80) AS query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
  AND now() - xact_start > interval '30 seconds'
ORDER BY age DESC;
```

Scheduled jobs are the usual culprit, because they run long transactions on a
timer and nobody thinks about them at deploy time. If the platform has a
maintenance or pause mechanism, quiescing background work before a migration
that touches a hot table is worth the two minutes it costs.

## Rollback

Plan the rollback before applying, and be honest about what it can recover.

A down migration handles structural mistakes and nothing else. It can drop a
column that was added, but it cannot restore a column that was dropped, because
the data went with it. Generating one before applying is still worth doing:
`migrate diff` will produce it, and having it reviewed in the same pull request
as the forward migration forces the question of what reversal would actually
mean.

```sh
# Generate the reverse script BEFORE applying the forward one.
npx prisma migrate diff \
  --from-schema prisma/schema.prisma \
  --to-config-datasource \
  --script > prisma/migrations/<name>/rollback.sql
```

For anything destructive, the real safety net is a backup taken immediately
before, with its identifier recorded in the release ticket. Restoring loses
everything written since the snapshot, so it is the last resort rather than the
plan — which is why the expand/contract sequence keeps the old shape intact
until the very last step.

The default response to a bad migration is to roll forward. Write the corrective
migration, review it, apply it. Reversal is for the case where the corrective
migration is not obvious and the system is actively broken.

## Verifying the release

A migration is verified when the schema, the client and the application agree,
and each needs its own check.

```sh
# 1. The history is clean and nothing is pending.
npx prisma migrate status

# 2. No unexpected difference remains between the schema file and the database.
npx prisma migrate diff \
  --from-schema prisma/schema.prisma \
  --to-config-datasource \
  --script
# Expect empty output.

# 3. Objects the schema file does not model are still present.
#    A full pg_dump/pg_restore preserves triggers, functions, policies and
#    partial indexes. A data-only restore, a partial restore, or a db push
#    does not. Assert them explicitly after any of those three.
```

Then exercise the application: one read path and one write path over the changed
table, on the deployed build rather than locally. A migration that applied
cleanly and a client that was regenerated can still disagree, and the write path
is where that shows up.

## Databases other than PostgreSQL

The doctrine is portable; the mechanics are not. On MySQL, many `ALTER TABLE`
forms are online since 5.6 but some still copy the table, and the tooling
tradition is the ghost table — `gh-ost` tailing the binary log, or
`pt-online-schema-change` using triggers — rather than PostgreSQL's `NOT VALID`
and `CONCURRENTLY` options. MySQL also lacks transactional DDL, so a
multi-statement migration that fails halfway leaves the earlier statements
committed, which makes the "one logical change per migration" rule considerably
more important than it is on PostgreSQL. Vitess and PlanetScale-style platforms
go further and take schema changes out of the migration tool entirely, applying
them through their own online-DDL workflow.

SQLite supports very little `ALTER TABLE` at all, so most changes are implemented
as create-copy-drop-rename, which Prisma generates automatically and which is
acceptable only because SQLite deployments are typically single-writer.

Whatever the engine, the two rules that do not change are that the schema must
stay compatible with the previously deployed code, and that destructive steps
ship separately from the code change that made them safe.

## Sources

- [Deploying database changes with Prisma Migrate](https://www.prisma.io/docs/orm/prisma-client/deployment/deploy-database-changes-with-prisma-migrate) — where `migrate deploy` belongs in a pipeline.
- [Configure Prisma Client with PgBouncer](https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/pgbouncer) — why DDL needs a direct connection and what `?pgbouncer=true` changes.
- [Development and production](https://www.prisma.io/docs/orm/prisma-migrate/workflows/development-and-production) — the advisory lock and the separation of environments.
- [PostgreSQL: Monitoring pg_stat_activity](https://www.postgresql.org/docs/current/monitoring-stats.html) — identifying the open transaction a migration will wait behind.
- [Online Schema Change for MySQL and MariaDB](https://severalnines.com/blog/online-schema-change-mysql-mariadb-comparing-github-s-gh-ost-vs-pt-online-schema-change/) — the MySQL equivalents of this playbook.
