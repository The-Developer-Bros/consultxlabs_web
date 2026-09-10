# The change catalog

Every schema change belongs to one of three classes, and the class determines
the entire procedure. This reference exists so that the class is decided by
looking a change up rather than by guessing, because the guess is usually wrong
in the same direction: changes feel additive because the Prisma schema diff is
one line, while the SQL underneath rewrites a table or drops a column.

Read the class first, then the row for the specific change, then the recipe.

## The three classes

The classes below are ordered by cost, and a change is always handled at the
highest class it touches.

| Class           | Meaning                                                                                                                 | Procedure                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Free**        | No deployed code can break, no existing row can be rejected, and the lock is either not taken or held for microseconds. | Ship it in one migration whenever you like.                            |
| **Ordered**     | Safe in itself, but only if the application deploy happens on the correct side of it.                                   | One migration, but the deploy order is not negotiable.                 |
| **Destructive** | Would break running code, reject existing rows, or lose data if applied in one step.                                    | Decompose into an expand/contract sequence — see `expand-contract.md`. |

## PostgreSQL lock classes, in the order that matters

The lock a statement takes is the difference between a schema change and an
incident, so it is worth knowing the four that come up in practice. Note that
the concurrent variant of a statement takes a weaker lock than the plain one,
which is the whole reason the concurrent variants exist.

| Lock                     | Blocks                                | Taken by                                                                                                           |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ACCESS EXCLUSIVE`       | Everything, including plain `SELECT`. | Most `ALTER TABLE` forms, `DROP TABLE`, `DROP INDEX` without `CONCURRENTLY`, `TRUNCATE`, `REINDEX`, `VACUUM FULL`. |
| `SHARE`                  | Writes, but not reads.                | `CREATE INDEX` without `CONCURRENTLY`.                                                                             |
| `SHARE ROW EXCLUSIVE`    | Writes and other DDL, but not reads.  | `ALTER TABLE ... ADD FOREIGN KEY`, on both tables. Also `CREATE TRIGGER`.                                          |
| `SHARE UPDATE EXCLUSIVE` | Other DDL, but not reads or writes.   | `CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, `VALIDATE CONSTRAINT`, `ALTER TABLE ... SET STATISTICS`.   |
| `ROW EXCLUSIVE`          | Only DDL that conflicts with it.      | Ordinary `INSERT`, `UPDATE`, `DELETE` — the application's normal traffic.                                          |

Two properties of PostgreSQL locking cause nearly all migration outages. The
first is that lock acquisition is a FIFO queue, so a pending `ACCESS EXCLUSIVE`
request blocks every later query that conflicts with it, including reads that
would not have conflicted with the queries currently running — one blocked DDL
statement therefore stalls the entire table. The second is that the DDL waits
for the _oldest_ open transaction on the table to finish, so a forgotten
analytics query or an idle-in-transaction session can turn a millisecond
operation into a multi-minute stall. Setting `lock_timeout` converts both
failures from an outage into a retryable error.

```sql
-- Prepend this to any migration that touches a populated table.
SET lock_timeout = '3s';
SET statement_timeout = '30s';
```

If the statement fails on the timeout, that is the mechanism working as
designed. Retry it a few seconds later rather than raising the timeout.

## Adding things

Additive changes are the ones worth batching together and shipping often,
because almost all of them are free.

| Change                                   | Class       | Lock and cost                                                                                    | Notes                                                                                                                     |
| ---------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Add a table                              | Free        | None on existing tables.                                                                         | Nothing references it yet, so it can ship arbitrarily early.                                                              |
| Add a nullable column                    | Free        | `ACCESS EXCLUSIVE`, held for microseconds — a catalog write only.                                | The default and correct way to introduce any new field.                                                                   |
| Add a column with a constant default     | Free        | `ACCESS EXCLUSIVE`, microseconds, on PostgreSQL 11 and later.                                    | The default is stored in `pg_attribute.attmissingval` and materialised on read, so no rows are rewritten.                 |
| Add a column with a **volatile** default | Destructive | `ACCESS EXCLUSIVE` for a full table rewrite.                                                     | `now()` is fine because it is stable within a statement; `clock_timestamp()`, `random()` and `gen_random_uuid()` are not. |
| Add an index                             | Ordered     | `SHARE` for the whole build, which blocks writes but not reads, unless created concurrently.     | Always use `CREATE INDEX CONCURRENTLY` on a populated table; see the concurrency note below.                              |
| Add a `CHECK` constraint                 | Ordered     | `ACCESS EXCLUSIVE` and a full scan, unless added `NOT VALID` first.                              | Add `NOT VALID`, then `VALIDATE CONSTRAINT` separately under a weaker lock.                                               |
| Add a foreign key                        | Ordered     | `SHARE ROW EXCLUSIVE` on **both** tables plus a validating scan, unless added `NOT VALID` first. | Same two-step treatment as a `CHECK`, and remember the child column needs an index or every parent delete scans it.       |
| Add a unique constraint                  | Ordered     | `ACCESS EXCLUSIVE` for the implicit index build.                                                 | Build the unique index concurrently first, then attach it as a constraint — see the recipe below.                         |
| Add an enum value (PostgreSQL)           | Free        | No table lock.                                                                                   | `ALTER TYPE ... ADD VALUE` could not run inside a transaction block before PostgreSQL 12; see `prisma-mechanics.md`.      |

### Adding an index without locking the table

The default index build holds `ACCESS EXCLUSIVE` for its entire duration, which
on a large table means minutes of total unavailability. Building concurrently
takes only `SHARE UPDATE EXCLUSIVE`, so reads and writes continue throughout.

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Appointment_consultantId_startTime_idx"
  ON "Appointment" ("consultantId", "startTime");
```

A concurrent build cannot run inside a transaction block, which is exactly why
it fights with migration tools that wrap each migration in one — the workaround
is in `prisma-mechanics.md`. A concurrent build can also fail and leave an
invalid index behind, which continues to cost write throughput while being
useless for reads, so always verify afterwards and drop anything invalid.

```sql
SELECT c.relname
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE NOT i.indisvalid;
```

### Adding a constraint without scanning the table

Adding a validated constraint in one statement scans every row while holding
`ACCESS EXCLUSIVE`. Splitting it into two statements moves the expensive half
under a lock that does not block traffic.

```sql
-- 1. Enforce for all new and updated rows immediately. No scan, brief lock.
ALTER TABLE "Payment"
  ADD CONSTRAINT payment_amount_positive CHECK ("amount" > 0) NOT VALID;

-- 2. Verify the existing rows. SHARE UPDATE EXCLUSIVE, so traffic continues.
ALTER TABLE "Payment" VALIDATE CONSTRAINT payment_amount_positive;
```

If step 2 fails, the offending rows are still there and the constraint is still
enforced going forward, so the fix is to repair the data and validate again
rather than to drop the constraint.

### Adding a unique constraint without locking the table

Build the index concurrently, then promote it, so that the expensive build
happens under the weak lock and only the promotion takes the strong one.

```sql
CREATE UNIQUE INDEX CONCURRENTLY "SomeTable_columnA_columnB_key"
  ON "SomeTable" ("columnA", "columnB");

ALTER TABLE "SomeTable"
  ADD CONSTRAINT "SomeTable_columnA_columnB_key"
  UNIQUE USING INDEX "SomeTable_columnA_columnB_key";
```

The build fails outright if duplicates already exist, which is the desired
outcome: find and resolve the duplicates deliberately, one group at a time,
before retrying. Deduplicating inside a migration is how the wrong row gets
deleted.

## Changing things

Modifications are where the classification most often surprises people, because
a one-word change in the Prisma schema can mean a full table rewrite.

| Change                                                              | Class       | Lock and cost                                                                         | Notes                                                                                              |
| ------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Widen a type (`varchar(50)` to `varchar(200)`, `varchar` to `text`) | Free        | `ACCESS EXCLUSIVE`, microseconds — a catalog change only.                             | PostgreSQL skips the rewrite when the new type provably accepts every existing value.              |
| Widen `int` to `bigint`                                             | Destructive | `ACCESS EXCLUSIVE` for a full rewrite.                                                | The on-disk width changes, so every row and index is rewritten. Treat it as a column swap.         |
| Narrow a type or change it incompatibly                             | Destructive | `ACCESS EXCLUSIVE` for a rewrite, and it fails outright on any row that does not fit. | Needs the expand/contract type-change playbook.                                                    |
| Drop a default                                                      | Free        | `ACCESS EXCLUSIVE`, microseconds.                                                     | Existing rows keep the values they were given.                                                     |
| Make a column `NOT NULL`                                            | Destructive | `ACCESS EXCLUSIVE` and a full scan, unless a validated `CHECK` already proves it.     | See the recipe below; also requires that no deployed code still writes null.                       |
| Make a column nullable                                              | Ordered     | `ACCESS EXCLUSIVE`, microseconds.                                                     | Safe for the database, but deploy the code that tolerates null **before** relaxing the constraint. |
| Rename a column                                                     | Destructive | The rename itself is instant; the danger is entirely to the running application.      | Three deploys. Prisma emits `DROP` plus `ADD` unless you edit the SQL.                             |
| Rename a table                                                      | Destructive | Instant catalog change; same application hazard.                                      | Same three-deploy shape as a column rename.                                                        |
| Rename an index or constraint                                       | Free        | `ACCESS EXCLUSIVE`, microseconds.                                                     | No application code names an index, so this one really is free.                                    |
| Change a column's collation                                         | Destructive | Rewrites every index over the column.                                                 | Also silently changes sort order, which changes any behaviour derived from it.                     |

### Making a column `NOT NULL` without a blocking scan

Setting `NOT NULL` directly scans the whole table under `ACCESS EXCLUSIVE`.
PostgreSQL 12 and later will skip that scan if a validated `CHECK` constraint
already proves the column is never null, which turns the expensive half into the
non-blocking `VALIDATE` step.

```sql
-- 1. Enforce going forward, no scan.
ALTER TABLE "Payment"
  ADD CONSTRAINT payment_key_not_null CHECK ("clientIdempotencyKey" IS NOT NULL) NOT VALID;

-- 2. Backfill any remaining nulls in batches — see expand-contract.md.

-- 3. Validate under SHARE UPDATE EXCLUSIVE.
ALTER TABLE "Payment" VALIDATE CONSTRAINT payment_key_not_null;

-- 4. Now instant, because the validated CHECK proves it.
ALTER TABLE "Payment" ALTER COLUMN "clientIdempotencyKey" SET NOT NULL;

-- 5. Optional: the CHECK is now redundant.
ALTER TABLE "Payment" DROP CONSTRAINT payment_key_not_null;
```

The database half is only half the work. The constraint may not be applied until
every deployed writer already populates the column, or the first request from an
old instance fails at the constraint. That ordering is the subject of
`deployment.md`.

## Removing things

Removal is the step everyone wants to bundle with the change that made it
redundant, and bundling them is precisely what breaks the deploy.

| Change                            | Class       | Lock and cost                                                                                                                                     | Notes                                                                                                                 |
| --------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Drop a column                     | Destructive | `ACCESS EXCLUSIVE`, microseconds — but irreversible.                                                                                              | Cheap for the database and fatal for any deployed code still selecting it. `SELECT *` in an ORM selects every column. |
| Drop a table                      | Destructive | `ACCESS EXCLUSIVE`, irreversible.                                                                                                                 | Ship only after nothing has read it for a full retention window.                                                      |
| Drop an index                     | Ordered     | `ACCESS EXCLUSIVE` for a plain `DROP INDEX`; `DROP INDEX CONCURRENTLY` takes only `SHARE UPDATE EXCLUSIVE` and cannot run in a transaction block. | Reversible, but rebuilding a large index takes time you may not have during an incident.                              |
| Drop a constraint                 | Destructive | `ACCESS EXCLUSIVE`, microseconds.                                                                                                                 | Structurally reversible, semantically not: see the note below.                                                        |
| Remove an enum value (PostgreSQL) | Destructive | Requires recreating the type.                                                                                                                     | PostgreSQL has no `ALTER TYPE ... DROP VALUE`; see `prisma-mechanics.md`.                                             |

Dropping a constraint deserves its own note, because the lock cost makes it look
free and it is not. The statement is instant and the constraint can be re-added
afterwards, so the _structure_ is reversible — but from the moment it is dropped
PostgreSQL stops enforcing the invariant, and every write accepted in the
interval can be one the constraint existed to reject. Re-adding it then fails on
the rows that were admitted while it was gone, and the repair is a data-cleanup
exercise rather than a migration. Classify the change by the invariant being
removed rather than by the lock: dropping a `CHECK` that keeps a payment's legs
summing to its amount is not in the same category as dropping a constraint that
a later migration immediately replaces with a stricter one. The former needs the
same review as any destructive change, and in this repository those constraints
live in `prisma/sql/` precisely so that removing one is a visible edit.

The safe removal sequence is always the same. Stop reading the column in
application code and deploy that. Stop writing it and deploy that. Wait long
enough that no queued job, no cached deployment, and no in-flight retry can
still reference it. Only then drop it, in its own migration, with a backup taken
first.

## Prisma-specific traps in this catalog

Three behaviours of Prisma turn safe-looking schema edits into destructive SQL,
and all three are silent.

A rename is not detected. Prisma diffs the schema structurally, so renaming a
model or a field produces a `DROP` of the old object and a `CREATE` of the new
one, and every row in it is lost. The same applies to `@map` and `@@map`: adding
a mapping to point an existing model at a differently named table generates a
drop and a create, not a rename. Generate with `--create-only` and rewrite the
SQL as `ALTER TABLE ... RENAME TO` or `ALTER TABLE ... RENAME COLUMN`.

`prisma db push` drops whatever the schema does not mention. It reconciles the
database to the schema file, so a table that exists only in the database — one
created by another service, or a column deliberately kept for a capture — is
removed without a migration recording that it happened.

Relation changes rewrite more than they appear to. Changing a relation's
optionality, its referential action, or the field it points at can drop and
recreate a foreign key, and on a large child table the revalidation is a full
scan. Read the generated SQL for any relation edit.

## What does not need a migration at all

Not every schema-file edit reaches the database, and knowing which ones do not
avoids a pointless deploy. Renaming a Prisma model or field while pinning the
database name with `@map` or `@@map` changes only the generated client, as does
adding or removing a `@relation` name, reordering fields, editing comments, and
changing anything about the generator block. Run `prisma generate` and ship the
code; there is no DDL to apply.

## Sources

- [PostgreSQL: ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html) — the authoritative list of which forms require a rewrite.
- [PostgreSQL: Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html) — the lock conflict matrix.
- [Zero-downtime Postgres schema migrations need this: lock_timeout and retries](https://postgres.ai/blog/20210923-zero-downtime-postgres-schema-migrations-lock-timeout-and-retries) — why the FIFO lock queue turns a fast statement into an outage.
- [A Missing Link in Postgres 11: Fast Column Creation with Defaults](https://brandur.org/postgres-default) — how `attmissingval` avoids the rewrite, and when it does not apply.
- [The SET NOT NULL downtime trap in PostgreSQL](https://dev.to/andrewpsy/the-set-not-null-downtime-trap-in-postgresql-1o71) — the validated-`CHECK` shortcut.
- [Squawk](https://squawkhq.com/docs/) — a linter for PostgreSQL migrations that encodes most of this catalog as automated rules.
