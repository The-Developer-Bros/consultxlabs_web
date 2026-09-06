# Prisma Migrate mechanics

This reference covers the machinery: which command does what, what the shadow
database is for, how to adopt a database that already exists, and how to recover
when a migration has already gone wrong. It assumes Prisma 7, and notes where
Prisma 6 differs.

## The three commands, and which one destroys data

Choosing between these is the single highest-consequence decision in Prisma
schema work, because two of them will drop tables without much ceremony.

| Command                 | What it does                                                                                                                  | Safe against a database with real data?                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `prisma migrate dev`    | Diffs the schema, writes a migration file, and applies it. In Prisma 7 it does **not** run `prisma generate` or seed for you. | **No.** On drift or an edited migration it prompts, and resets the database if you confirm.                                    |
| `prisma migrate deploy` | Applies pending migration files in order. Never generates, never resets, never prompts.                                       | **Yes.** This is the only command that belongs in a deploy pipeline.                                                           |
| `prisma db push`        | Reconciles the database to the schema file directly, writing no migration file.                                               | **No.** It drops anything the schema does not mention. It prompts first, but a non-interactive run needs `--accept-data-loss`. |

Two further commands matter for recovery rather than for routine work.
`prisma migrate status` reports which migrations are applied, pending or failed
and is the first thing to run against any database you are unsure about, and
`prisma migrate resolve` edits the migration history without executing SQL.
`prisma migrate reset` drops and recreates the database; it is a development
command and there is no production use for it.

Three safeguards are worth stating precisely, because they are the difference
between "this command is dangerous" and knowing when it actually bites. `migrate
dev` prompts before a reset rather than resetting silently, so the real risk is
an operator confirming out of habit or a script running it non-interactively.
`db push` likewise prompts before any statement that loses data, and
`--accept-data-loss` is what suppresses that prompt — which means the flag,
rather than the command, is the thing to grep for in automation. And
`--force-reset` is a separate, explicit request to drop and recreate the
database; neither command implies it.

In Prisma 7 neither `migrate dev` nor `db push` runs `prisma generate` any more,
and `migrate dev` no longer seeds automatically. The `--skip-generate` and
`--skip-seed` flags were removed along with the behaviour they suppressed, so
generation and seeding are now explicit steps.

## What `migrate deploy` guarantees, and what it does not

`prisma migrate deploy` applies every pending migration in filename order and
records each in the `_prisma_migrations` table. It does not compare the schema
file to the database, so it will not warn about drift, and it does not require
or create a shadow database. It takes an advisory lock so that two concurrent
deploys cannot apply the same migration twice.

What it does not do is roll anything back. If a migration fails halfway, the
statements before the failure may already be committed, the migration is marked
failed in `_prisma_migrations`, and every subsequent `migrate deploy` refuses to
proceed until the failure is resolved by hand. Planning for that is the subject
of the recovery section below.

## The shadow database

Prisma needs a second, throwaway database to work out what SQL a schema change
implies and to detect whether the real database has drifted from the migration
history. It creates it, replays every migration into it, diffs, and drops it.

The shadow database is used by `prisma migrate dev` and `prisma migrate diff`
against a live datasource. It is never used by `prisma migrate deploy`, which is
why a production deploy needs no elevated database privileges and no second
database. When the connection user cannot create databases — which is normal on
a managed provider — point `shadowDatabaseUrl` at a second database created by
hand.

```ts
// prisma.config.ts
// Prisma 7 does not load .env for you here, so import it before reading process.env.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    // The CLI needs a direct, non-pooled connection for DDL.
    url: process.env.DIRECT_URL,
    // Only needed for migrate dev / migrate diff, never for migrate deploy.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
```

## Reviewing SQL before it runs

This is the habit that prevents most schema disasters, and it is one flag.

```sh
# Write the migration file, but do not apply it.
npx prisma migrate dev --create-only --name rename_phone_to_phone_number
```

Read `prisma/migrations/<timestamp>_rename_phone_to_phone_number/migration.sql`,
edit it, then apply it with `npx prisma migrate dev`. Editing is expected and
supported: the file is the source of truth, and the schema diff is only a
starting draft.

The edit that comes up most often is turning a generated drop-and-create back
into a rename. Prisma cannot detect that a rename was intended, so it emits SQL
that loses the data.

```sql
-- What Prisma generates. This destroys every phone number.
ALTER TABLE "User" DROP COLUMN "phone";
ALTER TABLE "User" ADD COLUMN "phoneNumber" TEXT;

-- What you replace it with.
ALTER TABLE "User" RENAME COLUMN "phone" TO "phoneNumber";
```

Once a migration has been applied anywhere, its checksum is recorded. Editing it
afterwards causes `migrate dev` to report that the migration was modified after
being applied and to offer a reset. Edit before the first apply, and use a new
migration for anything after it.

## `prisma migrate diff`

`migrate diff` compares any two schema sources and prints the SQL that would
transform the first into the second. It is the utility behind baselining, drift
detection and rollback-script generation, and it is worth knowing directly.

```sh
# Baseline: what SQL creates the whole schema from nothing?
npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script

# Drift: what has the live database got that the migration history does not?
npx prisma migrate diff --from-migrations prisma/migrations --to-config-datasource --script

# Rollback: what SQL takes the database back to the migration history?
npx prisma migrate diff --from-schema prisma/schema.prisma --to-config-datasource --script
```

Read the flag names carefully every time, because mixing them up produces a
confidently wrong script. `--from-schema` and `--to-schema` take a path and read
the _models_ in that file, while `--from-config-datasource` and
`--to-config-datasource` take no path and read the live _database_ that
`prisma.config.ts` points at. `--from-migrations` and `--to-migrations` take the
migrations directory and mean "the state the history says we should be in".

These are Prisma 7 names. Prisma 6 spelled the same two ideas
`--from-schema-datamodel` and `--from-schema-datasource`, both taking a schema
path; those, along with `--from-url` and `--to-url`, were removed in Prisma 7,
so a command copied from an older article or answer will fail outright.

## Adopting a database that already exists

Baselining tells Prisma that the current state of a database corresponds to a
migration that has already been applied, so that future migrations start from
there rather than trying to create tables that exist. This is how a database
managed by `db push`, by another team, or by another ORM enters the migration
system without being recreated.

```sh
# 1. Make sure the schema file matches the live database exactly.
npx prisma db pull

# 2. Create the baseline directory. The 0_ prefix keeps it first in filename order.
mkdir -p prisma/migrations/0_init

# 3. Generate the SQL that would create the current schema from nothing.
npx prisma migrate diff \
  --from-empty \
  --to-schema prisma/schema.prisma \
  --script > prisma/migrations/0_init/migration.sql

# 4. Record it as applied, WITHOUT running it, on every existing database.
npx prisma migrate resolve --applied 0_init

# 5. Confirm.
npx prisma migrate status
```

Step 4 runs once per environment that already has the schema. A fresh database
skips the `resolve` and gets the SQL applied by `migrate deploy` instead, which
is what makes the baseline work for both cases. The baseline captures only what
the Prisma schema knows about: triggers, functions, row-level-security policies,
partial indexes and constraints applied outside the schema file are not in
`db pull` output and must be added to the baseline SQL by hand or they will be
absent from every database created from it afterwards.

## Recovering a failed migration

When `migrate deploy` fails partway, the database is in an intermediate state
and every subsequent deploy fails with `P3009` until the history is repaired.
Never re-run `migrate deploy` hoping it will pass; it fails on the same
statement every time.

```sh
# 1. Find out exactly which migration failed and where.
npx prisma migrate status
```

From there, decide which way to move, and the decision is about the database
rather than about the tooling: inspect the table and establish which statements
in the failed migration actually committed.

If most of the migration succeeded, finish it by hand and mark it applied.

```sh
psql "$DIRECT_URL" -c 'ALTER TABLE "Payment" ADD COLUMN "settledAt" TIMESTAMP(3);'
npx prisma migrate resolve --applied 20260907120000_add_settled_at
```

If little of it succeeded, undo the committed part and mark it rolled back, then
fix the migration file and deploy again.

```sh
psql "$DIRECT_URL" -c 'ALTER TABLE "Payment" DROP COLUMN IF EXISTS "settledAt";'
npx prisma migrate resolve --rolled-back 20260907120000_add_settled_at
```

The reason both paths require manual SQL is that Prisma does not know how far
the migration got. Statements in a multi-statement migration are wrapped in one
transaction where the database supports transactional DDL, so PostgreSQL usually
gives all-or-nothing behaviour per migration, but any statement that cannot run
in a transaction breaks that guarantee — which is the next section.

## Concurrent index creation

`CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, and Prisma
wraps multi-statement migrations in one, so a migration containing it fails with
`cannot run inside a transaction block`. Prisma has no supported way to disable
the transaction for a single migration.

Community reports that a migration containing exactly one statement is not
wrapped, and that isolating the concurrent index in its own migration therefore
works, are widespread but rest on an implementation detail rather than a
documented guarantee. The dependable approach is to keep the index out of the
migration system: apply it with `prisma db execute` or `psql` as an explicit
operational step, and record it in a checked-in SQL file so that a rebuilt
database gets it too. In Prisma 7 `db execute` reads its connection from
`prisma.config.ts`; the `--schema` and `--url` flags it accepted in Prisma 6
were removed.

```sh
npx prisma db execute --file prisma/sql/indexes/appointment-consultant-start.sql
```

A concurrent build that fails leaves an invalid index behind that slows writes
without helping reads, so always verify afterwards with the `pg_index` query in
`change-catalog.md`.

## Enum changes

Adding a value to a PostgreSQL enum is cheap and takes no table lock. Before
PostgreSQL 12 it could not run inside a transaction block, which produced the
same class of failure as concurrent index creation; on PostgreSQL 12 and later
it works inside a transaction as long as the new value is not used in the same
transaction that added it.

Removing a value is genuinely hard, because PostgreSQL has no
`ALTER TYPE ... DROP VALUE`. Removing one means creating a replacement type,
migrating every column that uses the old type, dropping the old type, and
renaming the new one into place — all while no row still holds the value being
removed. Prisma generates exactly this sequence and it is worth reading before
applying, because it rewrites every table that uses the enum.

```sql
-- The shape Prisma generates for an enum value removal.
ALTER TYPE "AppointmentStatus" RENAME TO "AppointmentStatus_old";
CREATE TYPE "AppointmentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED');
ALTER TABLE "Appointment"
  ALTER COLUMN "status" TYPE "AppointmentStatus"
  USING ("status"::text::"AppointmentStatus");
DROP TYPE "AppointmentStatus_old";
```

The `USING` cast fails on any row still holding the removed value, so find and
migrate those rows in a prior deploy. Because enums are painful to shrink and
free to grow, a value that is being retired is usually best left in the type and
removed from application code, with the type cleaned up later or never.

## Drift

Drift is any difference between what the migration history says the database
should look like and what it actually looks like. It is caused by running
`db push` against a database that has migrations, by manual `ALTER TABLE`
statements, by a restore from an older backup, and by another service sharing
the database.

```sh
# Detect it.
npx prisma migrate diff --from-migrations prisma/migrations --to-config-datasource --script
```

There are only three honest resolutions. Adopt the drift by introspecting it
into the schema file and generating a migration that represents it, then marking
that migration applied on the database that already has it. Revert the drift by
applying the reverse SQL that `migrate diff` produces. Or, on a development
database only, reset. Anything else amounts to suppressing the check, and a
suppressed drift check is how a missing constraint survives for months.

Objects that Prisma does not model — triggers, functions, policies, extensions —
show up as permanent drift unless they are either added to the baseline
migration or explicitly tracked as known and accepted. Whichever route is
chosen, an allowlist entry needs an owner, a reason and an expiry, because an
allowlist without an expiry is a disabled check.

## Prisma 7 differences

Prisma 7 moved connection configuration out of the schema file. The `url`,
`directUrl` and `shadowDatabaseUrl` fields in the `datasource` block are
deprecated in favour of `prisma.config.ts`, and the CLI reads the connection
string from `datasource.url` there — which must be a direct, non-pooled
connection, because DDL through a transaction pooler is unreliable. A project
that wants to run migrations or introspection now needs that file to exist.

Seeding moved as well: the `prisma.seed` key in `package.json` is replaced by
`migrations.seed` in `prisma.config.ts`. The migration commands themselves are
unchanged from Prisma 6, so every command in this reference works identically on
both; only the configuration surface moved.

## The error codes worth recognising

These five account for most of the time lost to Prisma migration problems, and
each has a single correct response.

| Code    | Meaning                                                     | Response                                                                        |
| ------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `P3005` | The database is not empty and has no migration history.     | Baseline it, as described above. Do not reset.                                  |
| `P3006` | A migration failed to apply cleanly to the shadow database. | Usually a hand-edited migration that is not replayable from empty. Fix the SQL. |
| `P3009` | Failed migrations found in the target database.             | Recover with `migrate resolve`, as described above. Do not re-run `deploy`.     |
| `P3014` | The shadow database could not be created.                   | Provide `shadowDatabaseUrl` pointing at a database created by hand.             |
| `P1001` | Cannot reach the database server.                           | Almost always the pooled URL being used for DDL, or an IP allowlist.            |

## Sources

- [prisma migrate deploy](https://www.prisma.io/docs/cli/migrate/deploy) and [prisma migrate resolve](https://www.prisma.io/docs/cli/migrate/resolve) — command semantics.
- [Baselining a database](https://www.prisma.io/docs/orm/prisma-migrate/workflows/baselining) — the `0_init` and `migrate resolve --applied` procedure.
- [Customizing migrations](https://www.prisma.io/docs/orm/prisma-migrate/workflows/customizing-migrations) — `--create-only` and editing generated SQL.
- [prisma migrate diff](https://www.prisma.io/docs/cli/migrate/diff) — the datamodel versus datasource flag distinction.
- [About the shadow database](https://www.prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate/shadow-database) — when it is created and when it is not.
- [Patching and hotfixing](https://www.prisma.io/docs/orm/prisma-migrate/workflows/patching-and-hotfixing) — the failed-migration recovery paths.
- [Support CREATE INDEX CONCURRENTLY](https://github.com/prisma/orm/issues/14456) and [Disable transactions for a single migration](https://github.com/prisma/prisma/discussions/10601) — the open limitation and the community workarounds.
- [Upgrade to Prisma ORM 7](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7) — the `prisma.config.ts` migration.
