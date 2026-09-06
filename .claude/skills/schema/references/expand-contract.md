# Expand and contract

Expand and contract is the answer to the question this skill exists for: what a
company does instead of resetting the database. A change that cannot be made
safely in one step is decomposed into a sequence of steps that each leave the
system working, and the old shape is only removed once nothing depends on it.
It is the same idea the MySQL world implements with ghost tables in `gh-ost` and
`pt-online-schema-change`, and that `pgroll` and `pg-osc` automate for
PostgreSQL; doing it by hand is simply that pattern written out.

The cost is real and worth stating plainly: a rename is three deploys spread
over days, not one migration. Teams accept that cost because the alternative is
a window in which the running application and the live schema disagree.

## The shape

Every playbook in this reference is the same five movements. Naming them makes
it obvious which one you are in and what is not yet finished.

| Movement       | What happens                                                                            | Reversible?                                          |
| -------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Expand**     | The new shape is added alongside the old one. Nothing reads it yet.                     | Yes — drop the addition.                             |
| **Dual write** | Application code writes both shapes on every path. Reads still come from the old shape. | Yes — stop writing the new one.                      |
| **Backfill**   | Historical rows are copied into the new shape in batches.                               | Yes — the new shape is still unread.                 |
| **Cut over**   | Reads move to the new shape. Writes still populate both.                                | Yes — this is the step to make instantly revertible. |
| **Contract**   | Writes to the old shape stop, then the old shape is dropped.                            | No. This is the point of no return.                  |

Two rules govern the sequence. The cut-over must be revertible without a deploy,
which in practice means putting it behind a feature flag or an environment
variable rather than behind a code change, so that a bad cut-over is undone in
seconds. And the contract step must never ship in the same release as the
cut-over, because the whole value of the sequence is the window in which you can
still go back.

## Playbook: renaming a column

This is the canonical case, and the one Prisma handles worst, because the ORM
emits a `DROP` and a `CREATE` for what the author intended as a rename.

There is a cheap escape hatch worth checking first. If the goal is only to
improve the name in application code, and the database name is irrelevant, then
rename the Prisma field and pin the database column with `@map`. No DDL is
generated, no data moves, and the whole exercise is one `prisma generate`.

```prisma
model User {
  // The database column stays "phone"; only the client-facing name changes.
  phoneNumber String? @map("phone")
}
```

If the database column genuinely has to be renamed, the three-deploy sequence
below is the shortest safe path, and it is what the Prisma maintainers
themselves describe.

**Deploy 1 — expand.** Add the new column as nullable. Do not touch the old one.

The migration is additive, so no _already deployed_ code can break — but it must
still run **before** the code that writes the new column, because an instance
that starts writing `phoneNumber` while the column does not yet exist fails on
every write. Additive means the database leads; it does not mean the order is
free.

```sql
ALTER TABLE "User" ADD COLUMN "phoneNumber" TEXT;
```

Ship application code that writes both columns on every write path and still
reads the old one. Every path matters, including admin tools, background jobs,
webhook handlers, and seed scripts; a single writer that misses the new column
is a source of rows that the cut-over will read as null.

**Between deploys — backfill.** Copy the historical rows in batches, as described
under "Backfilling" below. Run it to completion, then verify that no row remains
with the old column populated and the new one null.

```sql
SELECT count(*) FROM "User" WHERE "phone" IS NOT NULL AND "phoneNumber" IS NULL;
-- Must be 0 before proceeding.
```

**Deploy 2 — cut over.** Move reads to the new column while continuing to write
both. Leave the old field in the Prisma schema as an ordinary field: `@ignore`
removes it from the generated client entirely, so a field marked `@ignore`
cannot be dual-written, and applying it here would silently stop `phone` being
maintained — which is precisely the data the revert path depends on. `@ignore`
belongs in deploy 3, after writes to the old column have stopped, as the step
that proves nothing in the codebase still references it.

If the new column is meant to be required, this is where the `NOT NULL` recipe
from `change-catalog.md` runs — after the backfill has proven there are no
nulls, and after every writer populates it.

**Deploy 3 — contract.** Stop writing the old column. Mark it `@ignore` and
regenerate, which turns any remaining reference into a compile error rather than
a runtime surprise; once that is clean, remove it from the schema and drop it.
Take a backup first: this is the irreversible step.

```sql
ALTER TABLE "User" DROP COLUMN "phone";
```

The gap between deploy 2 and deploy 3 should be at least one full retention
window for anything that can replay old code — queued jobs, webhook retries,
scheduled tasks. A day is a reasonable floor; a week costs nothing.

## Playbook: renaming a table

A table rename has the same three-deploy shape, with one simplification and one
complication. The simplification is that `ALTER TABLE ... RENAME TO` is an
instant catalog change that carries indexes, constraints and data with it, so
there is no backfill. The complication is that it is not additive: the moment it
runs, the old name is gone, and any still-running instance querying the old name
fails.

The way to keep it safe is to make the old name keep working through a view.

```sql
-- Deploy 1: rename, and leave a view behind under the old name.
ALTER TABLE "ConsultantReview" RENAME TO "Review";
CREATE VIEW "ConsultantReview" AS SELECT * FROM "Review";
```

Old instances read and — for a simple single-table view, which PostgreSQL makes
automatically updatable — write through the view, while new instances use the
real table. Deploy 2 moves the application to the new name. Deploy 3 drops the
view. If the view cannot be made updatable because of the shape of the change,
fall back to treating the rename as a table copy, which is the split playbook
below.

Prisma will not generate the rename. Create the migration with `--create-only`
and replace the generated `DROP TABLE`/`CREATE TABLE` pair with the statements
above; the details are in `prisma-mechanics.md`.

## Playbook: changing a column's type

An incompatible type change rewrites the table under `ACCESS EXCLUSIVE` and
fails outright on any row that does not fit the new type, so it is handled as a
column swap rather than an `ALTER COLUMN ... TYPE`.

Add a new column of the target type, dual-write with the conversion applied,
backfill with the same conversion, verify that every converted value round-trips
as intended, cut reads over, and finally drop the original. The verification
step is the one people skip and the one that matters: a numeric widening is
lossless, but a text-to-enum or float-to-decimal conversion is not, and the
backfill is the only chance to see which rows do not convert cleanly.

```sql
-- Find the rows that will not convert, before converting anything.
SELECT id, "legacyStatus"
FROM "Appointment"
WHERE "legacyStatus" IS NOT NULL
  AND "legacyStatus" NOT IN ('PENDING', 'CONFIRMED', 'CANCELLED');
```

Where the conversion is genuinely lossless and the table is small enough that a
brief rewrite is acceptable, a direct `ALTER COLUMN ... TYPE ... USING` under a
`lock_timeout` is a legitimate shortcut. "Small enough" has to be measured
against the actual table, not assumed.

## Playbook: adding a required field to a populated table

Adding a `NOT NULL` column with no default to a table that already has rows
fails immediately, because the existing rows would violate it. The sequence is
four steps and every one of them is necessary.

Add the column as nullable, which is free. Deploy application code that
populates it on every write path, so the set of null rows stops growing. Backfill
the existing nulls in batches. Then apply the constraint using the validated
`CHECK` recipe from `change-catalog.md`, so that the final `SET NOT NULL` does
not scan the table.

If a sensible constant default exists, the shortcut is to add the column with
that default in one statement, which PostgreSQL 11 and later performs without
rewriting the table. This is genuinely one step and is the right answer whenever
a default is meaningful. It is the wrong answer when it is not: a default of
`''` or `0` chosen to make the migration easy writes a fake value into every
historical row, and no later code can distinguish it from a real one.

## Playbook: splitting or merging tables

Splitting one table into two, or merging two into one, is the case where the
generic pattern is not enough and Stripe's four-phase online migration is the
model worth copying, because it adds a verification phase that the simple
version lacks.

The phases are dual write, backfill, shadow read, and cut over. Dual writing
sends every new write to both the old and the new shape, keeping them in sync
from the moment it ships. The backfill moves history, and at any real scale it
runs against a snapshot or a replica rather than the live primary, so that the
copy does not compete with production traffic. The shadow read is the phase that
distinguishes this from guessing: reads execute against both shapes, the results
are compared, and a mismatch raises an alert without affecting the response the
user receives. Only once the mismatch rate has been zero for long enough does
the cut-over move reads to the new shape, and only then does the contract phase
stop the dual writes and remove the old shape.

For an extra margin, reverse the dual write after the cut-over so that the new
shape is written first and the old one is updated asynchronously. That keeps the
old shape current, which means reverting the cut-over stays a configuration
change rather than a restore.

Shadow reads are worth the effort exactly when a mismatch would be expensive and
silent — money, permissions, availability. For a low-stakes column rename they
are overkill, and the plain three-deploy sequence is the right size of solution.

## Backfilling

A backfill is a data migration, not a schema migration, and conflating the two is
the most common way to turn a fast deploy into a stalled one. Keep the backfill
out of the migration file: the migration adds the column and finishes in
milliseconds, and a separate script fills it in.

Four properties make a backfill safe. It must be batched, so that each
transaction is short and locks are released between chunks. It must commit per
batch, so that a failure loses one batch rather than all of them. It must be
restartable, which follows from the batching if the query selects the next unset
rows rather than paginating by offset. And it must be throttled, with a pause
between batches so that replication lag and write-ahead-log growth stay bounded.

```ts
// scripts/db/backfill-phone-number.ts
// Batched, restartable, throttled. Run to completion before the cut-over.
import prisma from "../../lib/prisma";

const BATCH_SIZE = 1_000;
const PAUSE_MS = 200;

async function main() {
  let moved = 0;

  for (;;) {
    // One statement, so the value written is the value the row holds at write
    // time. Reading with findMany and writing row.phone back would race the
    // dual-writer: a concurrent update between the read and the write would be
    // overwritten with the stale value the backfill had already read.
    //
    // "phoneNumber" IS NULL is the compare-and-set predicate — a row the
    // dual-writer has already populated is left alone. Selecting the batch by
    // that same predicate rather than by offset is what makes this restartable.
    // SKIP LOCKED steps over rows another transaction is holding instead of
    // blocking behind them.
    const moved_in_batch = await prisma.$executeRaw`
      UPDATE "User" AS u
      SET "phoneNumber" = u."phone"
      WHERE u."id" IN (
        SELECT "id" FROM "User"
        WHERE "phone" IS NOT NULL AND "phoneNumber" IS NULL
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      AND u."phoneNumber" IS NULL
    `;

    if (moved_in_batch === 0) break;

    moved += moved_in_batch;
    console.log(`backfilled ${moved}`);
    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
  }

  const remaining = await prisma.user.count({
    where: { phone: { not: null }, phoneNumber: null },
  });
  console.log(`done: ${moved} moved, ${remaining} remaining`);
  if (remaining > 0) process.exitCode = 1;
}

void main().finally(() => prisma.$disconnect());
```

The pattern Prisma's own data-migration guide shows — loading every row with
`findMany()` and updating each inside a single `$transaction` — is correct for a
development database and wrong for a production one twice over. It holds one
transaction open for the entire run and rolls the whole thing back on any
failure, and it reads each value before writing it, so a dual-writer that
updates a row in between has its value silently overwritten by the stale one.

Raw SQL is the right tool here, despite the general preference for the ORM in
this codebase, and for two reasons rather than one. Setting a column from
another column in the same statement is not expressible through the Prisma
Client at all, and that single statement is what makes the write race-free. The
throughput of a set-based `UPDATE` over a row-by-row client loop is the
secondary benefit.

Where the transformation genuinely needs application logic — parsing, calling
out to a service, anything SQL cannot express — read and write in the same short
transaction with a `WHERE` predicate that still asserts the target is unset, so
that a concurrent writer causes the row to be skipped rather than clobbered.

Always finish with the verification query. A backfill that reports success
without a count of remaining rows has not been verified, and the cut-over is the
worst place to discover that a writer was missed.

## When to reach for a tool instead

The manual sequence is the right default for a schema with normal traffic, and
there is a point past which tooling earns its complexity. `pgroll` implements
expand and contract natively by exposing each schema version behind its own set
of views, so the old and new application versions genuinely run side by side
against one physical table, and a rollback is dropping a view rather than
reversing a migration. `Reshape` takes the same view-based approach. `Atlas` and
`Bytebase` approach it from the declarative direction, planning migrations from
a desired end state and linting them for unsafe operations.

Adopting one of these means giving up Prisma Migrate as the source of truth for
DDL, which is a significant commitment. The threshold worth applying is whether
tables are large enough that a rewrite is measured in minutes and traffic is
high enough that a lock queue is an incident. Below that, the sequences in this
reference are cheaper than the tool.

## Sources

- [How to migrate data with Prisma ORM using the expand and contract pattern](https://www.prisma.io/docs/guides/data-migration) — Prisma's own guide, including the single-transaction backfill this reference argues against for production.
- [Implementation Guidance for Expand and Contract Pattern using Prisma Migrate](https://github.com/prisma/prisma/discussions/21927) — a Prisma maintainer confirming that a field rename requires three production deployments, and the role of `@ignore`.
- [Online migrations at scale](https://stripe.com/blog/online-migrations) — Stripe's four-phase dual-write, backfill, shadow-read and cut-over method.
- [Using the expand and contract pattern](https://www.prisma.io/dataguide/types/relational/expand-and-contract-pattern) — the pattern stated independently of any ORM.
- [pgroll](https://pgroll.com/) and [Reshape](https://github.com/fabianlindfors/reshape) — view-based multi-version schema tooling for PostgreSQL.
- [gh-ost vs pt-online-schema-change](https://www.bytebase.com/blog/gh-ost-vs-pt-online-schema-change/) — the MySQL ghost-table equivalents, for context on where the pattern came from.
