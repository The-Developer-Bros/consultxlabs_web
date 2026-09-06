# Prisma Migrations Guide

A comprehensive, general-purpose reference for managing database migrations with Prisma ORM. This guide covers core concepts, every CLI command, production safety patterns, team workflows, rollback strategies, and troubleshooting. All examples use a fictional e-commerce schema and are applicable to any Prisma project.

**Prisma version scope:** Prisma 7 is the primary syntax (using `prisma.config.ts`). Prisma 6 differences are noted where relevant.

**Last updated:** 2026-09-07.

> **Status in this repository.** This guide is general-purpose and deliberately
> uses a fictional schema, so it describes Prisma Migrate as it works anywhere.
> This repository does not use versioned migrations yet: there is no
> `prisma/migrations` directory and no `_prisma_migrations` table, and the
> schema is managed with `prisma db push` plus the hand-applied SQL sidecars in
> `prisma/sql/`. The command reference and the safe-versus-dangerous operation
> rules below apply in full today; the workflow, deployment and squashing
> chapters apply after the cutover. See [README.md](./README.md) for what applies
> when, and [03-cutover-to-migrations.md](./03-cutover-to-migrations.md) for the
> procedure that closes the gap.

---

## Table of Contents

- [1. How Prisma Migrate Works](#1-how-prisma-migrate-works)
  - [1.1 The Migration Lifecycle](#11-the-migration-lifecycle)
  - [1.2 The Shadow Database](#12-the-shadow-database)
  - [1.3 The `_prisma_migrations` Table](#13-the-_prisma_migrations-table)
  - [1.4 Migration Files on Disk](#14-migration-files-on-disk)
  - [1.5 Configuration: `prisma.config.ts` (Prisma 7)](#15-configuration-prismaconfigts-prisma-7)
  - [1.6 Example Schema Used in This Guide](#16-example-schema-used-in-this-guide)
- [2. Command Reference](#2-command-reference)
  - [2.1 `prisma migrate dev`](#21-prisma-migrate-dev)
  - [2.2 `prisma migrate deploy`](#22-prisma-migrate-deploy)
  - [2.3 `prisma migrate reset`](#23-prisma-migrate-reset)
  - [2.4 `prisma migrate status`](#24-prisma-migrate-status)
  - [2.5 `prisma migrate resolve`](#25-prisma-migrate-resolve)
  - [2.6 `prisma migrate diff`](#26-prisma-migrate-diff)
  - [2.7 `prisma db push`](#27-prisma-db-push)
  - [2.8 `prisma db pull`](#28-prisma-db-pull)
  - [2.9 `prisma db execute`](#29-prisma-db-execute)
  - [2.10 `prisma generate`](#210-prisma-generate)
  - [2.11 `prisma validate` and `prisma format`](#211-prisma-validate-and-prisma-format)
- [3. Decision Matrix: `migrate dev` vs `db push` vs `migrate deploy`](#3-decision-matrix-migrate-dev-vs-db-push-vs-migrate-deploy)
- [4. Safe vs Dangerous Operations](#4-safe-vs-dangerous-operations)
  - [4.1 Safe Operations (No Data Loss)](#41-safe-operations-no-data-loss)
  - [4.2 Dangerous Operations (Potential Data Loss)](#42-dangerous-operations-potential-data-loss)
  - [4.3 Operations Requiring Manual Migration](#43-operations-requiring-manual-migration)
- [5. Schema Changes with Examples](#5-schema-changes-with-examples)
  - [5.1 Adding a New Model](#51-adding-a-new-model)
  - [5.2 Adding Fields](#52-adding-fields)
  - [5.3 Removing Fields and Models](#53-removing-fields-and-models)
  - [5.4 Renaming Fields and Models](#54-renaming-fields-and-models)
  - [5.5 Changing Field Types](#55-changing-field-types)
  - [5.6 Enum Changes](#56-enum-changes)
  - [5.7 Index and Constraint Changes](#57-index-and-constraint-changes)
  - [5.8 Relation Changes](#58-relation-changes)
  - [5.9 What Does NOT Require a Migration](#59-what-does-not-require-a-migration)
- [6. Production Data Migrations (Expand/Contract)](#6-production-data-migrations-expandcontract)
  - [6.1 The Expand/Contract Pattern](#61-the-expandcontract-pattern)
  - [6.2 Example: Renaming a Column](#62-example-renaming-a-column)
  - [6.3 Example: Adding a Required Field to a Populated Table](#63-example-adding-a-required-field-to-a-populated-table)
  - [6.4 Example: Splitting a Table](#64-example-splitting-a-table)
  - [6.5 Data Migration Scripts](#65-data-migration-scripts)
  - [6.6 Testing with Production-Like Data](#66-testing-with-production-like-data)
- [7. Team Workflow](#7-team-workflow)
  - [7.1 The Golden Rules](#71-the-golden-rules)
  - [7.2 Daily Developer Routine](#72-daily-developer-routine)
  - [7.3 Branch-Based Development](#73-branch-based-development)
  - [7.4 Resolving Migration Conflicts](#74-resolving-migration-conflicts)
  - [7.5 PR Checklist for Schema Changes](#75-pr-checklist-for-schema-changes)
  - [7.6 What to Commit to Version Control](#76-what-to-commit-to-version-control)
- [8. Rollback Strategies](#8-rollback-strategies)
  - [8.1 Why Prisma Has No Built-in Rollback](#81-why-prisma-has-no-built-in-rollback)
  - [8.2 Generating Rollback SQL with `migrate diff`](#82-generating-rollback-sql-with-migrate-diff)
  - [8.3 Manual Rollback Process](#83-manual-rollback-process)
  - [8.4 Forward Fixes vs Rollbacks](#84-forward-fixes-vs-rollbacks)
  - [8.5 Database Backup as Rollback](#85-database-backup-as-rollback)
  - [8.6 Pre-Generating Companion Rollback Scripts](#86-pre-generating-companion-rollback-scripts)
- [9. Production Deployment and CI/CD](#9-production-deployment-and-cicd)
  - [9.1 Pipeline Integration](#91-pipeline-integration)
  - [9.2 Advisory Locking](#92-advisory-locking)
  - [9.3 Connection Pooling and the Two-URL Strategy](#93-connection-pooling-and-the-two-url-strategy)
  - [9.4 Zero-Downtime Migrations](#94-zero-downtime-migrations)
  - [9.5 Health Checks and Smoke Tests](#95-health-checks-and-smoke-tests)
  - [9.6 Environment Variable Management](#96-environment-variable-management)
- [10. Squashing Migrations](#10-squashing-migrations)
  - [10.1 When to Squash](#101-when-to-squash)
  - [10.2 Development Squashing (Feature Branch)](#102-development-squashing-feature-branch)
  - [10.3 Production Squashing (Full History)](#103-production-squashing-full-history)
  - [10.4 Baselining an Existing Database](#104-baselining-an-existing-database)
  - [10.5 Risks and Caveats](#105-risks-and-caveats)
- [11. Schema Drift](#11-schema-drift)
  - [11.1 What is Schema Drift](#111-what-is-schema-drift)
  - [11.2 Common Causes](#112-common-causes)
  - [11.3 Detecting Drift](#113-detecting-drift)
  - [11.4 Resolving Drift](#114-resolving-drift)
  - [11.5 Preventing Drift](#115-preventing-drift)
- [12. Supabase-Specific Considerations](#12-supabase-specific-considerations)
  - [12.1 The Two-URL Strategy](#121-the-two-url-strategy)
  - [12.2 Connection Pooling with Supavisor](#122-connection-pooling-with-supavisor)
  - [12.3 Shadow Database on Supabase](#123-shadow-database-on-supabase)
  - [12.4 Baselining a Supabase Project](#124-baselining-a-supabase-project)
  - [12.5 Supabase Branching](#125-supabase-branching)
- [13. Prisma 7 Migration System Changes](#13-prisma-7-migration-system-changes)
  - [13.1 Configuration Changes](#131-configuration-changes)
  - [13.2 Driver Adapters](#132-driver-adapters)
  - [13.3 Removed Options](#133-removed-options)
  - [13.4 Seeding Changes](#134-seeding-changes)
  - [13.5 Migration Commands Are Unchanged](#135-migration-commands-are-unchanged)
- [14. Troubleshooting](#14-troubleshooting)
- [15. Best Practices Checklist](#15-best-practices-checklist)
- [16. Cross-References and Resources](#16-cross-references-and-resources)

---

## 1. How Prisma Migrate Works

### 1.1 The Migration Lifecycle

Every Prisma migration follows this lifecycle:

```
1. You edit schema.prisma
2. Run `prisma migrate dev --name <name>`
3. Prisma creates a shadow database (temporary)
4. Prisma replays all existing migrations against the shadow DB
5. Prisma diffs the shadow DB against your new schema
6. Prisma generates a migration.sql file from the diff
7. Prisma applies the migration.sql to your development database
8. Prisma records the migration in the `_prisma_migrations` table
9. Prisma drops the shadow database
10. Prisma regenerates the Prisma Client
```

```mermaid
flowchart TD
    A["Edit schema.prisma"] --> B["Run prisma migrate dev"]
    B --> C["Create shadow database"]
    C --> D["Replay all existing migrations on shadow DB"]
    D --> E["Diff shadow DB vs new schema"]
    E --> F["Generate migration.sql"]
    F --> G["Apply migration.sql to dev database"]
    G --> H["Record in _prisma_migrations table"]
    H --> I["Drop shadow database"]
    I --> J["Regenerate Prisma Client"]
```

In **production**, the process is simpler: `prisma migrate deploy` reads the pending migration files and applies them sequentially. No shadow database, no diffing, no prompts.

### 1.2 The Shadow Database

The shadow database is a temporary database that Prisma creates and destroys during `prisma migrate dev`. It serves two purposes:

1. **Detect drift** -- Prisma replays all migrations on the shadow DB, then compares the result against your actual development database. If they differ, your database has "drifted" from the expected state.
2. **Generate accurate SQL** -- By diffing the shadow DB (which represents the state after all existing migrations) against your new schema, Prisma generates precisely the SQL needed for the new change.

**Key facts:**

- The shadow database is **only used by `prisma migrate dev`** and `prisma migrate diff`. It is **never** used by `prisma migrate deploy`.
- The database user needs `CREATE DATABASE` privileges to create the shadow database.
- On hosted providers that restrict `CREATE DATABASE` (like some Supabase or PlanetScale configurations), you can provide a dedicated shadow database via `shadowDatabaseUrl` in your configuration.

```typescript
// prisma.config.ts (Prisma 7)
export default defineConfig({
  datasource: {
    url: env("DATABASE_URL"),
    directUrl: env("DIRECT_URL"),
    shadowDatabaseUrl: env("SHADOW_DATABASE_URL"), // Optional: dedicated shadow DB
  },
});
```

> **Prisma 6 note:** In Prisma 6, `shadowDatabaseUrl` was set directly in the `datasource` block of `schema.prisma`.

### 1.3 The `_prisma_migrations` Table

Prisma automatically creates and manages a `_prisma_migrations` table in your database. This table tracks which migrations have been applied:

| Column                | Type      | Purpose                                            |
| --------------------- | --------- | -------------------------------------------------- |
| `id`                  | VARCHAR   | Unique migration ID (UUID)                         |
| `checksum`            | VARCHAR   | SHA-256 hash of the migration.sql file             |
| `finished_at`         | TIMESTAMP | When the migration finished (NULL if in-progress)  |
| `migration_name`      | VARCHAR   | Timestamp + name (e.g., `20260115_add_user_email`) |
| `logs`                | TEXT      | Error logs if the migration failed                 |
| `rolled_back_at`      | TIMESTAMP | When the migration was marked as rolled back       |
| `started_at`          | TIMESTAMP | When the migration began                           |
| `applied_steps_count` | INT       | Number of SQL steps applied (for partial failures) |

**How checksums work:**

When you run `prisma migrate deploy`, Prisma computes the SHA-256 hash of each migration file and compares it to the checksum stored in `_prisma_migrations`. If they don't match, the migration is rejected. This prevents tampering with already-applied migration files.

**Never manually edit this table** unless you're resolving a failed migration state (and even then, prefer `prisma migrate resolve`).

### 1.4 Migration Files on Disk

Migrations live in the `prisma/migrations/` directory:

```
prisma/
├── schema.prisma
├── migrations/
│   ├── migration_lock.toml              # Locks the database provider
│   ├── 20260115120000_create_users/
│   │   └── migration.sql                # The SQL for this migration
│   ├── 20260116090000_add_product_table/
│   │   └── migration.sql
│   └── 20260117140000_add_order_status_enum/
│       └── migration.sql
```

**`migration_lock.toml`** locks the database provider (e.g., `provider = "postgresql"`). This prevents accidentally applying PostgreSQL migrations to a MySQL database.

**Migration directory names** are formatted as `<timestamp>_<name>`:

- The timestamp ensures lexicographic ordering matches chronological order.
- The name comes from the `--name` flag you pass to `prisma migrate dev`.

**The `migration.sql` file** contains raw SQL. You can (and sometimes should) edit this file before applying it -- for example, to add data backfill queries, `IF NOT EXISTS` guards, or `CONCURRENTLY` index creation. However, **never edit a migration file after it has been applied to any environment**, because the checksum will no longer match.

**All migration files must be committed to version control.** They are part of your codebase, just like your application code.

### 1.5 Configuration: `prisma.config.ts` (Prisma 7)

In Prisma 7, the canonical configuration lives in `prisma.config.ts` at the project root:

```typescript
// prisma.config.ts
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  // Path to your schema file
  schema: "prisma/schema.prisma",

  // Migration settings
  migrations: {
    path: "prisma/migrations", // Where migration files live
    seed: "npx tsx prisma/seed.ts", // Seed command (Prisma 7 doesn't auto-seed)
  },

  // Database connection URLs
  datasource: {
    // `url` IS the CLI's connection, so it must be the direct/session-mode one.
    // There is no separate `directUrl` key in prisma.config.ts.
    url:
      process.env.DIRECT_URL ||
      "postgresql://placeholder:placeholder@localhost:5432/placeholder",
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
```

> **Prisma 6 note:** In Prisma 6, the datasource URL was defined in `schema.prisma`:
>
> ```prisma
> datasource db {
>   provider  = "postgresql"
>   url       = env("DATABASE_URL")
>   directUrl = env("DIRECT_URL")
> }
> ```

**Important:** The `url` in `prisma.config.ts` is used by CLI commands (`migrate dev`, `migrate deploy`, etc.). This is separate from the connection your application uses at runtime (which may go through a connection pooler). Provide a fallback value for CI environments where no database connection is needed during `prisma generate`.

### 1.6 Example Schema Used in This Guide

All examples throughout this guide use the following e-commerce schema:

```prisma
// prisma/schema.prisma

generator client {
  provider = "prisma-client"
  output   = "../node_modules/.prisma/client"
}

datasource db {
  provider = "postgresql"
}

model User {
  id        String    @id @default(cuid())
  email     String    @unique
  name      String
  role      UserRole  @default(CUSTOMER)
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  orders    Order[]
  reviews   Review[]
  addresses Address[]
}

model Product {
  id          String            @id @default(cuid())
  name        String
  description String?
  price       Decimal           @db.Decimal(10, 2)
  sku         String            @unique
  stock       Int               @default(0)
  isActive    Boolean           @default(true)
  createdAt   DateTime          @default(now())
  updatedAt   DateTime          @updatedAt
  categories  CategoryProduct[]
  orderItems  OrderItem[]
  reviews     Review[]
}

model Order {
  id        String      @id @default(cuid())
  status    OrderStatus @default(PENDING)
  total     Decimal     @db.Decimal(10, 2)
  userId    String
  user      User        @relation(fields: [userId], references: [id], onDelete: Restrict)
  items     OrderItem[]
  createdAt DateTime    @default(now())
  updatedAt DateTime    @updatedAt
}

model OrderItem {
  id        String  @id @default(cuid())
  quantity  Int
  price     Decimal @db.Decimal(10, 2)
  orderId   String
  order     Order   @relation(fields: [orderId], references: [id], onDelete: Cascade)
  productId String
  product   Product @relation(fields: [productId], references: [id], onDelete: Restrict)

  @@unique([orderId, productId])
}

model Category {
  id       String            @id @default(cuid())
  name     String            @unique
  products CategoryProduct[]
}

model CategoryProduct {
  categoryId String
  category   Category @relation(fields: [categoryId], references: [id], onDelete: Cascade)
  productId  String
  product    Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  assignedAt DateTime @default(now())

  @@id([categoryId, productId])
}

model Review {
  id        String   @id @default(cuid())
  rating    Int
  comment   String?
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  productId String
  product   Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now())

  @@unique([userId, productId])
}

model Address {
  id      String @id @default(cuid())
  street  String
  city    String
  state   String
  zip     String
  country String
  userId  String
  user    User   @relation(fields: [userId], references: [id], onDelete: Cascade)
}

enum UserRole {
  CUSTOMER
  ADMIN
  SELLER
}

enum OrderStatus {
  PENDING
  CONFIRMED
  SHIPPED
  DELIVERED
  CANCELLED
  REFUNDED
}
```

---

## 2. Command Reference

### 2.1 `prisma migrate dev`

**Purpose:** Create and apply migrations during development.

```bash
npx prisma migrate dev [options]
```

| Flag            | Description                                     |
| --------------- | ----------------------------------------------- |
| `--name <name>` | Name for the migration (used in directory name) |
| `--create-only` | Generate migration file without applying it     |

> **Prisma 7:** `--skip-seed` and `--skip-generate` were **removed**, because the
> behaviour they suppressed was removed with them. `migrate dev` no longer
> regenerates Prisma Client and no longer seeds after a reset; run
> `prisma generate` and the seed command explicitly. The same removal applies to
> `--skip-generate` on `db push`.

**What it does:**

1. Creates a shadow database to compute the diff
2. Generates a `migration.sql` file in `prisma/migrations/`
3. Applies the migration to your development database

In Prisma 6 it then regenerated Prisma Client and, after a reset, ran the seed
script. Prisma 7 does neither: both are explicit steps now.

**When to use:** Every time you change `schema.prisma` during development.

**When NOT to use:**

- Never in production or staging
- Never in CI/CD pipelines
- Never on shared databases

**Important behaviors:**

- If drift is detected (your DB doesn't match migration history), Prisma will prompt you to reset the database. In development, this is usually safe. In production, this would be catastrophic -- which is why you never run `migrate dev` in production.
- If you don't provide `--name`, Prisma will prompt for one interactively.
- If you run it with no schema changes, it still validates the migration history.

**Example:**

```bash
# Create and apply a migration
npx prisma migrate dev --name add_product_description

# Generate migration file only (review SQL before applying)
npx prisma migrate dev --create-only --name add_product_description
# Review prisma/migrations/<timestamp>_add_product_description/migration.sql
# Then apply:
npx prisma migrate dev
```

> **Prisma 7 note:** `prisma migrate dev` no longer runs the seed script after a reset, and no longer regenerates Prisma Client. Run `npx prisma db seed` and `npx prisma generate` explicitly. The `--skip-seed` and `--skip-generate` flags that used to suppress those steps were removed along with them.

### 2.2 `prisma migrate deploy`

**Purpose:** Apply pending migrations in production or CI environments.

```bash
npx prisma migrate deploy
```

**What it does:**

1. Reads the `_prisma_migrations` table to find unapplied migrations
2. Applies them sequentially in timestamp order
3. Acquires an advisory lock to prevent concurrent migrations
4. Exits with a non-zero code if any migration fails

**What it does NOT do:**

- Does NOT create a shadow database
- Does NOT generate new migrations
- Does NOT prompt for user input
- Does NOT reset the database
- Does NOT regenerate Prisma Client

**When to use:** Production deployments, staging deployments, CI/CD pipelines.

**When NOT to use:** Local development (use `migrate dev` instead).

**If a migration fails:** `migrate deploy` stops execution, records the error in the `logs` column of `_prisma_migrations`, and exits with a non-zero code. See [Section 8: Rollback Strategies](#8-rollback-strategies) for recovery.

**Example (CI/CD):**

```bash
# Apply all pending migrations
npx prisma migrate deploy

# Check exit code
echo $?  # 0 = success, non-zero = failure
```

### 2.3 `prisma migrate reset`

**Purpose:** Drop the database, recreate it, apply all migrations, and optionally seed.

```bash
npx prisma migrate reset [options]
```

| Flag      | Description                  |
| --------- | ---------------------------- |
| `--force` | Skip the confirmation prompt |

`--skip-seed` and `--skip-generate` were removed in Prisma 7; reset no longer
seeds or regenerates on its own.

**When to use:**

- Local development when your database is in a bad state
- After pulling a branch with migration changes that conflict with your current DB
- Starting fresh during development

**When NOT to use:**

- **NEVER in production** -- this drops all data
- **NEVER on shared databases**

**Example:**

```bash
# Reset with confirmation prompt
npx prisma migrate reset

# Reset without prompting (useful in scripts)
npx prisma migrate reset --force
```

### 2.4 `prisma migrate status`

**Purpose:** Check which migrations have been applied, are pending, or have failed.

```bash
npx prisma migrate status
```

**Output examples:**

```
# All up to date:
Database schema is up to date!

# Pending migrations:
Following migrations have not yet been applied:
  20260117140000_add_order_status_enum

# Failed migration:
Following migration have failed:
  20260117140000_add_order_status_enum

The failed migration(s) can be marked as rolled back or applied:
  prisma migrate resolve --rolled-back "20260117140000_add_order_status_enum"
  prisma migrate resolve --applied "20260117140000_add_order_status_enum"
```

**When to use:**

- Before deploying to production (verify pending migrations)
- After deploying (verify all migrations applied successfully)
- As a CI health check
- When debugging migration issues

**Exit codes:** Returns 0 if up to date, non-zero if there are pending or failed migrations.

### 2.5 `prisma migrate resolve`

**Purpose:** Manually mark a migration as applied or rolled back. Does NOT run or undo any SQL.

```bash
# Mark a migration as already applied (e.g., you applied the SQL manually)
npx prisma migrate resolve --applied "20260117140000_add_order_status_enum"

# Mark a migration as rolled back (e.g., you manually reverted the SQL)
npx prisma migrate resolve --rolled-back "20260117140000_add_order_status_enum"
```

**When to use:**

- **Baselining:** You have an existing database and want to start using Prisma Migrate. Create a baseline migration and mark it as applied.
- **Hotfixes:** You applied SQL directly to production to fix an urgent issue. Create a corresponding migration file and mark it as applied.
- **Recovery:** A migration partially failed and you manually completed or reverted it. Mark it appropriately.

**Important:** This command only updates the `_prisma_migrations` table. It does not execute any SQL. The migration file must exist on disk.

### 2.6 `prisma migrate diff`

**Purpose:** Compute the SQL diff between two database states. The Swiss Army knife for migration analysis.

```bash
npx prisma migrate diff --from-<source> --to-<target> [--script]
```

**Source/target options:**

| Flag                                                  | Description                                                    |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `--from-empty` / `--to-empty`                         | Empty database (no tables)                                     |
| `--from-schema` / `--to-schema`                       | The models in a Prisma schema file, given a path               |
| `--from-migrations` / `--to-migrations`               | The migration history directory                                |
| `--from-config-datasource` / `--to-config-datasource` | The live database `prisma.config.ts` points at. Takes no path. |
| `--script`                                            | Output SQL (instead of human-readable summary)                 |

> **Prisma 7:** `--from-url`, `--to-url`, `--from-schema-datasource` and
> `--to-schema-datasource` were **removed**, and `--from-schema-datamodel` /
> `--to-schema-datamodel` are now spelled `--from-schema` / `--to-schema`. A
> `migrate diff` command copied from a Prisma 6 article will fail outright.

**Common use cases:**

```bash
# 1. Preview what SQL a migration would generate
npx prisma migrate diff \
  --from-migrations ./prisma/migrations \
  --to-schema prisma/schema.prisma \
  --script

# 2. Detect drift between your database and migration history
npx prisma migrate diff \
  --from-migrations ./prisma/migrations \
  --to-url "$DATABASE_URL" \
  --script

# 3. Generate a baseline migration from an existing database
npx prisma migrate diff \
  --from-empty \
  --to-url "$DATABASE_URL" \
  --script > prisma/migrations/0_baseline/migration.sql

# 4. Generate a rollback script (reverse the last migration)
npx prisma migrate diff \
  --from-schema prisma/schema.prisma \
  --to-migrations ./prisma/migrations \
  --script > rollback.sql

# 5. Compare two live databases
npx prisma migrate diff \
  --from-url "$STAGING_URL" \
  --to-url "$PRODUCTION_URL" \
  --script
```

> **Prisma 7 note:** The `--shadow-database-url` flag was removed from `migrate diff`. Configure `shadowDatabaseUrl` in `prisma.config.ts` instead. The `--url` flag was also removed from several commands; use `prisma.config.ts` for connection configuration.

### 2.7 `prisma db push`

**Purpose:** Push the schema state to the database without creating migration files.

```bash
npx prisma db push [options]
```

| Flag                 | Description                                         |
| -------------------- | --------------------------------------------------- |
| `--force-reset`      | Force a database reset if schema changes require it |
| `--accept-data-loss` | Accept data loss from destructive changes           |

The `--skip-generate` flag was removed in Prisma 7, because `db push` no longer
regenerates Prisma Client at all.

**What it does:**

1. Compares your `schema.prisma` against the actual database
2. Applies the necessary SQL directly (no migration file created)
3. Regenerates Prisma Client

**When to use:**

- Rapid prototyping when you don't need migration history
- Very early development when the schema is changing constantly
- Working with databases that don't support migrations (e.g., MongoDB)

**When NOT to use:**

- **Never in production** -- no migration history, no rollback ability
- **Never when you need to deploy to other environments** -- there are no migration files to deploy
- **Never alongside `prisma migrate`** -- mixing `db push` and `migrate` on the same database causes drift

**Critical warning:** If you use `db push` instead of `migrate dev`, zero migration files are generated. Your production pipeline will have nothing to apply. This is a common mistake, especially when using AI coding tools that default to `db push`.

### 2.8 `prisma db pull`

**Purpose:** Introspect an existing database and generate a `schema.prisma` that matches it.

```bash
npx prisma db pull [options]
```

| Flag      | Description                        |
| --------- | ---------------------------------- |
| `--force` | Overwrite the existing schema file |

**When to use:**

- Working with an existing database that wasn't created with Prisma
- After someone made manual SQL changes and you need to sync the schema
- Starting a new Prisma project with an existing database

**After introspection:**

- Review the generated schema for naming and type accuracy
- Prisma may use `@@map` and `@map` to handle naming differences
- Add relation names, constraints, and any Prisma-specific decorators

### 2.9 `prisma db execute`

**Purpose:** Execute raw SQL against your database.

```bash
# Execute from a file
npx prisma db execute --file rollback.sql

# Execute from stdin
echo "SELECT 1;" | npx prisma db execute --stdin
```

**When to use:**

- Applying rollback scripts
- Running data migration scripts that aren't part of a migration file
- Executing one-off SQL commands

> **Prisma 7 note:** The `--url` flag was removed. The database URL is read from `prisma.config.ts`. If you need to target a different database, create a separate config file and use the `--config` flag.

### 2.10 `prisma generate`

**Purpose:** Regenerate the Prisma Client based on your schema.

```bash
npx prisma generate
```

**When it runs automatically:**

In Prisma 6, after `prisma migrate dev` and `prisma db push`. In Prisma 7,
**never** — both commands stopped generating, and `--skip-generate` was removed
with the behaviour. Every schema change now needs an explicit `prisma generate`,
which is the single most common cause of a "property does not exist on type"
error after upgrading.

**When to run manually:**

- After pulling changes that modify `schema.prisma`
- After changing generator settings
- In CI/CD pipelines as part of the build step

**This is NOT a migration command.** It does not touch the database. It only regenerates the TypeScript client code that your application imports.

### 2.11 `prisma validate` and `prisma format`

**`prisma validate`** checks your schema for syntax and semantic errors:

```bash
npx prisma validate
# Exits 0 if valid, non-zero with error messages if invalid
```

**`prisma format`** auto-formats your schema file (indentation, field alignment):

```bash
npx prisma format
```

**Recommended:** Add both to a pre-commit hook to catch errors early:

```bash
# .husky/pre-commit or similar
npx prisma validate
npx prisma format
git add prisma/schema.prisma  # Re-stage if format changed anything
```

---

## 3. Decision Matrix: `migrate dev` vs `db push` vs `migrate deploy`

### Comparison Table

| Feature                   | `migrate dev`     | `db push`                | `migrate deploy`      |
| ------------------------- | ----------------- | ------------------------ | --------------------- |
| Creates migration files   | Yes               | **No**                   | No (applies existing) |
| Uses shadow database      | Yes               | No                       | No                    |
| Safe for production       | **No**            | **No**                   | Yes                   |
| Handles existing data     | Via migration SQL | May prompt for data loss | Via migration SQL     |
| Prompts user              | Yes               | Yes                      | **No**                |
| Team-friendly             | Yes               | **No**                   | Yes                   |
| Can reset database        | Yes (with prompt) | Yes (with flag)          | **No**                |
| Records migration history | Yes               | **No**                   | Yes                   |
| Regenerates Prisma Client | Yes               | Yes                      | **No**                |

### Decision Flowchart

```mermaid
flowchart TD
    A["Schema changed?"] --> B{"Environment?"}
    B -->|"Production / Staging / CI"| C["prisma migrate deploy"]
    B -->|"Local development"| D{"Need migration files?"}
    D -->|"Yes (team project, will deploy)"| E["prisma migrate dev"]
    D -->|"No (solo prototyping, throwaway DB)"| F["prisma db push"]
    E --> G{"Want to review SQL first?"}
    G -->|"Yes"| H["prisma migrate dev --create-only\n→ review migration.sql\n→ prisma migrate dev"]
    G -->|"No"| I["prisma migrate dev --name descriptive_name"]
```

### Summary

| Scenario                                     | Command          |
| -------------------------------------------- | ---------------- |
| Prototyping alone, throwaway database        | `db push`        |
| Any change that will go to production        | `migrate dev`    |
| CI/CD pipeline deploying to staging          | `migrate deploy` |
| Production deployment                        | `migrate deploy` |
| Checking migration status before deploy      | `migrate status` |
| Introspecting an existing database           | `db pull`        |
| Reviewing what SQL a migration would produce | `migrate diff`   |

---

## 4. Safe vs Dangerous Operations

### 4.1 Safe Operations (No Data Loss)

| Operation                                | Migration Required? | What Happens to Existing Data                                              |
| ---------------------------------------- | ------------------- | -------------------------------------------------------------------------- |
| Add a new model                          | Yes                 | Creates a new table. No data affected.                                     |
| Add an optional field (`String?`)        | Yes                 | Existing rows get `NULL`.                                                  |
| Add a field with `@default(value)`       | Yes                 | Existing rows get the default value.                                       |
| Add a new index (`@@index`)              | Yes                 | Index is built from existing data. No loss.                                |
| Add a new enum value                     | Yes                 | Enum type is extended. No rows affected.                                   |
| Add a `@@unique` constraint              | Yes\*               | Fails if duplicate values exist. See note.                                 |
| Add an optional relation field           | Yes                 | New FK column added, existing rows get `NULL`.                             |
| Reorder fields in schema                 | No                  | Field order in schema doesn't affect DB.                                   |
| Change `@updatedAt`                      | No                  | Prisma Client sets this at write time.                                     |
| Change `@default(now())`                 | **Yes**             | Compiles to a column `DEFAULT now()` in PostgreSQL, so changing it is DDL. |
| Add `@@map` or `@map` (without renaming) | No\*                | Maps Prisma name to existing DB name.                                      |

\* Adding `@@unique` is safe only if no duplicate values exist in the column. If duplicates exist, the migration will fail.

\* Adding `@@map`/`@map` to match an _existing_ database column name doesn't generate SQL; it's a Prisma-level mapping. Adding it to _rename_ a column does require a migration.

### 4.2 Dangerous Operations (Potential Data Loss)

| Operation                         | Risk Level | What Happens                                                     |
| --------------------------------- | ---------- | ---------------------------------------------------------------- |
| Remove a model                    | **HIGH**   | `DROP TABLE` -- all data in the table is deleted                 |
| Remove a field                    | **HIGH**   | `DROP COLUMN` -- all data in the column is deleted               |
| Make an optional field required   | MEDIUM     | `ALTER COLUMN SET NOT NULL` -- fails if NULLs exist              |
| Change field type                 | HIGH       | May fail or lose precision (e.g., `String` to `Int`)             |
| Remove an enum value              | HIGH       | Fails if any row uses the removed value                          |
| Rename without `@map`             | **HIGH**   | Prisma generates DROP + CREATE, destroying data                  |
| Change `@id` field                | **HIGH**   | Recreates primary key, may cascade to foreign keys               |
| Change `onDelete` behavior        | LOW        | Alters FK constraint; no data change, but affects future deletes |
| Remove `@@unique` constraint      | LOW        | Allows duplicates going forward                                  |
| Change relation type (1:1 to 1:N) | HIGH       | May require column/table restructuring                           |

### 4.3 Operations Requiring Manual Migration

These operations cannot be handled by Prisma's automatic SQL generation. You must create a migration with `--create-only` and edit the SQL manually:

| Operation                                  | Why Manual?                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Data transformation / backfill             | Prisma can't know your business logic                                                             |
| Splitting a table into two                 | Complex data movement between tables                                                              |
| Merging two tables into one                | Complex data reconciliation                                                                       |
| Changing relation type (1:1 to 1:N)        | Structural change requiring data migration                                                        |
| Renaming an enum value                     | PostgreSQL requires `ALTER TYPE ... RENAME VALUE`                                                 |
| Adding a required field to populated table | Needs backfill step (see [Section 6.3](#63-example-adding-a-required-field-to-a-populated-table)) |
| Changing primary key type                  | Affects all foreign keys referencing this table                                                   |
| Converting implicit M2M to explicit        | Need to move data from implicit join table                                                        |

---

## 5. Schema Changes with Examples

### 5.1 Adding a New Model

```prisma
// Add a Wishlist model
model Wishlist {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  productId String
  product   Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now())

  @@unique([userId, productId])
}
```

```bash
npx prisma migrate dev --name create_wishlist_table
```

**Generated SQL:**

```sql
CREATE TABLE "Wishlist" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Wishlist_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Wishlist_userId_productId_key" ON "Wishlist"("userId", "productId");

ALTER TABLE "Wishlist" ADD CONSTRAINT "Wishlist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Wishlist" ADD CONSTRAINT "Wishlist_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

This is always safe -- it only creates new structures.

### 5.2 Adding Fields

**Optional field (safe):**

```prisma
model Product {
  // ... existing fields
  description String?  // New: existing rows get NULL
}
```

**Field with default (safe):**

```prisma
model Product {
  // ... existing fields
  isActive Boolean @default(true)  // New: existing rows get true
}
```

**Required field without default (DANGEROUS on populated tables):**

```prisma
model Product {
  // ... existing fields
  sku String @unique  // FAILS if table has rows!
}
```

**Error:**

```
ERROR: column "sku" of relation "Product" contains null values
```

**Solution -- the three-step approach:**

```bash
# Step 1: Add as optional
npx prisma migrate dev --name add_sku_nullable --create-only
```

```prisma
model Product {
  sku String?  // Nullable first
}
```

Edit the migration SQL to add a backfill:

```sql
ALTER TABLE "Product" ADD COLUMN "sku" TEXT;

-- Backfill existing rows
UPDATE "Product" SET "sku" = 'SKU-' || "id" WHERE "sku" IS NULL;
```

```bash
# Step 2: Apply and then make required in next migration
npx prisma migrate dev

# Step 3: Change schema to required + unique
npx prisma migrate dev --name make_sku_required
```

```prisma
model Product {
  sku String @unique  // Now required, all rows have values
}
```

### 5.3 Removing Fields and Models

**Removing a field:**

```prisma
model Product {
  // REMOVE: description String?
  // This generates: ALTER TABLE "Product" DROP COLUMN "description";
}
```

**All data in the column is permanently deleted.** There is no undo.

**Removing a model:**

```prisma
// REMOVE: entire Wishlist model
// This generates: DROP TABLE "Wishlist";
```

**All data in the table is permanently deleted.** All foreign key constraints referencing this table may also cascade.

**Best practice:** Before removing fields or models in production, verify:

1. No application code references them
2. You've backed up any data you might need
3. You've communicated the change to the team

### 5.4 Renaming Fields and Models

**The WRONG way (data loss):**

If you simply rename a field in the schema:

```prisma
model User {
  // Changed from: name String
  displayName String  // Prisma sees this as: DROP "name", ADD "displayName"
}
```

Prisma generates:

```sql
ALTER TABLE "User" DROP COLUMN "name";
ALTER TABLE "User" ADD COLUMN "displayName" TEXT NOT NULL;
-- All existing names are GONE
```

**The RIGHT way (preserves data):**

```prisma
model User {
  displayName String @map("name")  // Maps to the existing "name" column
}
```

Prisma generates NO SQL -- the column stays as `name` in the database, but your application code uses `displayName`.

**Renaming a model (table):**

```prisma
model Customer {
  // ...
  @@map("User")  // Maps to existing "User" table
}
```

**Renaming both model and field together:**

```prisma
model Customer {
  fullName String @map("name")  // Field: "name" in DB, "fullName" in code
  @@map("User")                 // Table: "User" in DB, "Customer" in code
}
```

### 5.5 Changing Field Types

**Safe widenings (usually work):**

```prisma
// These typically work without data loss:
name String @db.VarChar(50) → name String @db.VarChar(255)   // Wider varchar
price Float → price Decimal @db.Decimal(10, 2)                // More precision
count Int → count BigInt                                       // Wider integer
```

**Unsafe narrowings and type changes:**

```prisma
// These may fail or lose data:
name String → name Int                    // Incompatible types
price Decimal @db.Decimal(10, 2) → price Int  // Loses decimal precision
name String @db.VarChar(255) → name String @db.VarChar(50)   // Truncates if data > 50 chars
```

**Multi-step approach for incompatible type changes:**

```bash
# 1. Create migration with --create-only
npx prisma migrate dev --create-only --name change_price_type
```

Edit the generated SQL:

```sql
-- Step 1: Add new column
ALTER TABLE "Product" ADD COLUMN "price_new" DECIMAL(10,2);

-- Step 2: Copy data with transformation
UPDATE "Product" SET "price_new" = "price"::DECIMAL(10,2);

-- Step 3: Drop old column
ALTER TABLE "Product" DROP COLUMN "price";

-- Step 4: Rename new column
ALTER TABLE "Product" RENAME COLUMN "price_new" TO "price";

-- Step 5: Add NOT NULL constraint
ALTER TABLE "Product" ALTER COLUMN "price" SET NOT NULL;
```

### 5.6 Enum Changes

**Adding a value (safe in PostgreSQL):**

```prisma
enum OrderStatus {
  PENDING
  CONFIRMED
  SHIPPED
  DELIVERED
  CANCELLED
  REFUNDED
  RETURNED  // New value -- safe to add
}
```

```sql
-- Generated SQL:
ALTER TYPE "OrderStatus" ADD VALUE 'RETURNED';
```

**Removing a value (DANGEROUS):**

```prisma
enum OrderStatus {
  PENDING
  CONFIRMED
  SHIPPED
  DELIVERED
  CANCELLED
  // REMOVED: REFUNDED -- fails if any Order has status = REFUNDED
}
```

```
ERROR: cannot drop label "REFUNDED" from enum "OrderStatus" because it is being used
```

**Fix:** First update all rows using the old value, then remove it.

**Renaming an enum value (manual SQL required):**

PostgreSQL supports renaming enum values directly:

```bash
npx prisma migrate dev --create-only --name rename_cancelled_to_canceled
```

Edit the migration SQL:

```sql
ALTER TYPE "OrderStatus" RENAME VALUE 'CANCELLED' TO 'CANCELED';
```

Then update the schema to match:

```prisma
enum OrderStatus {
  PENDING
  CONFIRMED
  SHIPPED
  DELIVERED
  CANCELED   // Renamed from CANCELLED
  REFUNDED
}
```

### 5.7 Index and Constraint Changes

**Adding an index:**

```prisma
model Order {
  // ... existing fields

  @@index([userId])           // Simple index
  @@index([status, createdAt]) // Composite index
}
```

This is safe -- indexes are built from existing data without modifying it.

**Adding a unique constraint:**

```prisma
model Review {
  // ... existing fields

  @@unique([userId, productId])  // Only one review per user per product
}
```

This **fails** if duplicate values already exist. Verify first:

```sql
SELECT "userId", "productId", COUNT(*)
FROM "Review"
GROUP BY "userId", "productId"
HAVING COUNT(*) > 1;
```

**Creating indexes concurrently (large tables):**

For tables with millions of rows, standard index creation locks the table. Edit the migration to use `CONCURRENTLY`:

```bash
npx prisma migrate dev --create-only --name add_order_index
```

Edit the migration SQL:

```sql
-- Replace:
-- CREATE INDEX "Order_userId_idx" ON "Order"("userId");
-- With:
CREATE INDEX CONCURRENTLY "Order_userId_idx" ON "Order"("userId");
```

> **Note:** `CREATE INDEX CONCURRENTLY` cannot run inside a transaction. If your migration has multiple statements, you may need to split this into its own migration.

### 5.8 Relation Changes

**Adding an optional relation:**

```prisma
model Order {
  // ... existing fields
  couponId String?
  coupon   Coupon?  @relation(fields: [couponId], references: [id], onDelete: SetNull)
}
```

This is safe -- existing rows get `NULL` for the new FK column.

**Changing `onDelete` behavior:**

```prisma
model OrderItem {
  // Changed from: onDelete: Cascade
  order Order @relation(fields: [orderId], references: [id], onDelete: Restrict)
}
```

This generates an `ALTER TABLE` that changes the FK constraint. No existing data is affected, but future delete behavior changes.

**Always set `onDelete` explicitly.** Prisma's defaults can surprise you:

| Relation Type  | Prisma Default | Recommended                         |
| -------------- | -------------- | ----------------------------------- |
| Required (1:N) | `Restrict`     | Set explicitly based on your domain |
| Optional (1:N) | `SetNull`      | Set explicitly based on your domain |

Note that these are the `onDelete` defaults. `onUpdate` defaults to `Cascade`
for both required and optional relations, which is a separate setting and a
different default — do not assume the two match.

Common `onDelete` strategies:

| Strategy   | When to Use                                                      |
| ---------- | ---------------------------------------------------------------- |
| `Cascade`  | Child records are meaningless without parent (OrderItem → Order) |
| `Restrict` | Prevent deletion if children exist (Order → User)                |
| `SetNull`  | Keep child but remove association (Order → Coupon)               |
| `NoAction` | Let the database decide (advanced, rarely needed)                |

**Explicit vs implicit many-to-many:**

Implicit M2M (Prisma manages the join table):

```prisma
model Product {
  categories Category[]
}

model Category {
  products Product[]
}
// Prisma creates a join table named "_CategoryToProduct" (alphabetical order)
```

Explicit M2M (you manage the join table -- **recommended**):

```prisma
model CategoryProduct {
  categoryId String
  category   Category @relation(fields: [categoryId], references: [id], onDelete: Cascade)
  productId  String
  product    Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  assignedAt DateTime @default(now())

  @@id([categoryId, productId])
}
```

**Why explicit is recommended:**

1. You control the table name (no alphabetical naming surprises)
2. You can add extra fields (like `assignedAt`, `sortOrder`)
3. You can set explicit `onDelete` behavior
4. The join table is visible in your schema and queries
5. Avoids the implicit M2M naming pitfall where the table name depends on the alphabetical order of the two model names

### 5.9 What Does NOT Require a Migration

These changes only affect the Prisma Client, not the database:

| Change                                           | Why No Migration                             |
| ------------------------------------------------ | -------------------------------------------- |
| Changing relation names (`@relation("name")`)    | Relation names are Prisma-level, not in DB   |
| Adding `@@map`/`@map` to match existing DB names | Maps Prisma names to existing columns/tables |
| Changing `@updatedAt`                            | Handled by Prisma Client at write time       |
| Reordering fields in schema                      | Schema field order doesn't affect DB         |
| Adding comments (`///` doc comments)             | Comments are Prisma metadata only            |
| Changing Prisma Client generator settings        | Only affects generated code, not DB          |
| Computed/virtual fields in application code      | Not stored in DB                             |

**Important exception:** Changing the _order_ of models in an implicit M2M relation can change the generated join table name. For example, if you change:

```prisma
// Before
model Product {
  categories Category[]
}
// Join table: "_CategoryToProduct"

// After (swapped order of the @relation)
model Category {
  products Product[]
}
// Join table: STILL "_CategoryToProduct" (alphabetical)
```

The join table name is always alphabetical based on model names, regardless of which model lists the relation first. But if you rename a model involved in an implicit M2M, the join table name changes and the old table is dropped. Use explicit M2M to avoid this entirely.

---

## 6. Production Data Migrations (Expand/Contract)

### 6.1 The Expand/Contract Pattern

The expand/contract pattern is the gold standard for zero-data-loss schema changes in production. It works in three phases:

```mermaid
flowchart LR
    subgraph "Phase 1: Expand"
        A["Add new structure\nalongside old"]
    end
    subgraph "Phase 2: Migrate"
        B["Copy/transform data\nfrom old to new"]
    end
    subgraph "Phase 3: Contract"
        C["Remove old structure"]
    end
    A --> B --> C
```

**Phase 1 -- Expand:** Add the new column/table alongside the existing one. Both old and new code can work with the database at this point. Deploy the migration.

**Phase 2 -- Migrate:** Run a data migration script that copies or transforms data from the old structure to the new one. This can be inline SQL in a migration file or an external script.

**Phase 3 -- Contract:** Remove the old column/table. Deploy the updated application code that only uses the new structure.

The key insight: at no point during this process is data lost or is the application broken.

### 6.2 Example: Renaming a Column

Goal: Rename `User.name` to `User.fullName` without losing data.

**Migration 1 -- Expand (add new column):**

```bash
npx prisma migrate dev --create-only --name add_full_name_column
```

Schema (temporary state):

```prisma
model User {
  name     String   // Old column (keep for now)
  fullName String?  // New column (nullable initially)
}
```

Edit the migration SQL to include the data copy:

```sql
-- Add the new column
ALTER TABLE "User" ADD COLUMN "fullName" TEXT;

-- Copy data from old to new
UPDATE "User" SET "fullName" = "name";
```

Apply:

```bash
npx prisma migrate dev
```

**Migration 2 -- Contract (remove old column):**

```bash
npx prisma migrate dev --create-only --name remove_old_name_column
```

Update schema:

```prisma
model User {
  fullName String  // Now required (all rows have data)
  // name column removed
}
```

Edit the migration SQL:

```sql
-- Make the new column required (all rows have data from Phase 1)
ALTER TABLE "User" ALTER COLUMN "fullName" SET NOT NULL;

-- Drop the old column
ALTER TABLE "User" DROP COLUMN "name";
```

**Alternative (simpler, if you don't need to rename in DB):**

If you only want to rename in your application code, use `@map`:

```prisma
model User {
  fullName String @map("name")  // Code says "fullName", DB still says "name"
}
```

No migration needed. No data touched.

### 6.3 Example: Adding a Required Field to a Populated Table

Goal: Add a required `phone` field to the `User` model, which already has existing rows.

**Step 1: Add as nullable:**

```prisma
model User {
  phone String?  // Nullable first
}
```

```bash
npx prisma migrate dev --name add_user_phone_nullable
```

**Step 2: Backfill existing rows:**

Option A -- Inline SQL (edit migration before applying):

```bash
npx prisma migrate dev --create-only --name backfill_user_phone
```

Edit the migration SQL:

```sql
-- Backfill: set a default value for existing users
UPDATE "User" SET "phone" = 'NOT_PROVIDED' WHERE "phone" IS NULL;
```

Option B -- External script:

```typescript
// scripts/backfill-phone.ts
import prisma from "../lib/prisma";

async function main() {
  const updated = await prisma.user.updateMany({
    where: { phone: null },
    data: { phone: "NOT_PROVIDED" },
  });
  console.log(`Backfilled ${updated.count} users`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
```

```bash
npx tsx scripts/backfill-phone.ts
```

**Step 3: Make required:**

```prisma
model User {
  phone String  // Now required
}
```

```bash
npx prisma migrate dev --name make_user_phone_required
```

This generates:

```sql
ALTER TABLE "User" ALTER COLUMN "phone" SET NOT NULL;
```

This succeeds because all rows now have a non-NULL value.

### 6.4 Example: Splitting a Table

Goal: Extract address fields from `User` into a separate `Address` model.

Before:

```prisma
model User {
  id      String @id @default(cuid())
  email   String @unique
  name    String
  street  String?
  city    String?
  state   String?
  zip     String?
  country String?
}
```

After:

```prisma
model User {
  id        String    @id @default(cuid())
  email     String    @unique
  name      String
  addresses Address[]
}

model Address {
  id      String @id @default(cuid())
  street  String
  city    String
  state   String
  zip     String
  country String
  userId  String
  user    User   @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

**Migration 1 -- Create Address table and copy data:**

```bash
npx prisma migrate dev --create-only --name create_address_table
```

Edit the migration SQL:

```sql
-- Create the new table
CREATE TABLE "Address" (
    "id" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Address" ADD CONSTRAINT "Address_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Copy data from User to Address (generate IDs using gen_random_uuid)
INSERT INTO "Address" ("id", "street", "city", "state", "zip", "country", "userId")
SELECT gen_random_uuid()::text, "street", "city", "state", "zip", "country", "id"
FROM "User"
WHERE "street" IS NOT NULL;
```

**Migration 2 -- Drop old columns from User:**

```bash
npx prisma migrate dev --name drop_address_fields_from_user
```

```sql
ALTER TABLE "User" DROP COLUMN "street";
ALTER TABLE "User" DROP COLUMN "city";
ALTER TABLE "User" DROP COLUMN "state";
ALTER TABLE "User" DROP COLUMN "zip";
ALTER TABLE "User" DROP COLUMN "country";
```

### 6.5 Data Migration Scripts

You have two options for running data migrations:

**Option A: Inline SQL in migration files**

```bash
npx prisma migrate dev --create-only --name backfill_product_slugs
```

Edit `migration.sql`:

```sql
-- Add the column
ALTER TABLE "Product" ADD COLUMN "slug" TEXT;

-- Generate slugs from names
UPDATE "Product" SET "slug" = LOWER(REPLACE("name", ' ', '-'));

-- Make it required and unique
ALTER TABLE "Product" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX "Product_slug_key" ON "Product"("slug");
```

**Pros:** Self-contained, runs as part of the migration, reproducible.
**Cons:** Can't use application logic, limited to SQL.

**Option B: External migration scripts**

```typescript
// scripts/migrate-product-slugs.ts
import prisma from "../lib/prisma";
import slugify from "slugify";

async function main() {
  const products = await prisma.product.findMany({
    where: { slug: null },
  });

  for (const product of products) {
    await prisma.product.update({
      where: { id: product.id },
      data: { slug: slugify(product.name, { lower: true }) },
    });
  }

  console.log(`Generated slugs for ${products.length} products`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
```

**Pros:** Can use application logic, Prisma Client features, third-party libraries.
**Cons:** Must be run separately from the migration, can't be replayed with `migrate reset`.

**Recommendation:** Use inline SQL for simple transformations (UPDATE, INSERT, data copying). Use external scripts for complex business logic (slug generation, data enrichment, third-party API calls).

### 6.6 Testing with Production-Like Data

Never test migrations against an empty database alone. Empty databases hide failures like:

- NOT NULL violations on populated tables
- Unique constraint violations on duplicate data
- Type casting failures on real data values
- Performance issues with large datasets

**Strategy 1: Schema-only dump**

```bash
# Dump production schema (no data)
pg_dump --schema-only "$PRODUCTION_DATABASE_URL" > schema.sql

# Create test database and load schema
createdb migration_test
psql migration_test < schema.sql

# Seed with representative test data
npx tsx prisma/seed.ts

# Test the migration
npx prisma migrate dev
```

**Strategy 2: Anonymized production data**

```bash
# Dump production data with anonymization
pg_dump "$PRODUCTION_DATABASE_URL" | \
  sed 's/email@/test@/g' | \
  psql migration_test
```

**Strategy 3: Staging environment**

Maintain a staging database that mirrors production data. Run all migrations in staging before production.

---

## 7. Team Workflow

### 7.1 The Golden Rules

1. **Never edit a migration file after it has been committed to version control.** The checksum in `_prisma_migrations` will no longer match, causing errors in every environment where it was already applied.

2. **Never delete migration files created by teammates.** Even if their changes conflict with yours, deleting their migration will break their environment and production.

3. **Never run `prisma migrate reset` on shared databases.** It drops and recreates the entire database.

4. **Never use `prisma db push` on any database other than your local development database.** It creates no migration files and causes drift.

5. **One logical change per migration.** Easier to review, debug, and rollback.

6. **Always run `prisma migrate dev` after pulling changes that include new migrations.** This applies teammates' migrations to your local database.

7. **Communicate about schema changes.** On a small team (2-5 people), a quick message in Slack/standup prevents 90% of migration conflicts.

### 7.2 Daily Developer Routine

```bash
# Morning: Pull latest changes and sync your local database
git pull origin dev
npx prisma migrate dev          # Applies any new migrations from teammates

# Work: Make schema changes and create migrations
# Edit schema.prisma
npx prisma migrate dev --name add_shipping_address

# End of day: Push your changes
git add prisma/schema.prisma prisma/migrations/
git commit -m "Add shipping address model"
git push
```

### 7.3 Branch-Based Development

When two developers create migrations on separate branches:

```
main:     ──────────────────────────
               ↓          ↓
dev-alice:     ├── 20260315_add_coupon ──┐
               │                         ├── merge
dev-bob:       └── 20260316_add_review ──┘
```

**What happens:**

- Both migrations get unique timestamps, so they apply sequentially
- When Bob merges his branch after Alice, both migrations exist in the `prisma/migrations/` directory
- `prisma migrate deploy` applies them in timestamp order: Alice's first, Bob's second

**When this goes wrong:**

- Both modify the same table in conflicting ways (e.g., both add a column with the same name)
- Both modify an enum in ways that conflict
- One migration depends on a state that the other migration changes

### 7.4 Resolving Migration Conflicts

**Scenario:** You created a migration on your branch, but a teammate merged a conflicting migration to `dev` first.

**Resolution:**

```bash
# 1. Pull the latest changes (includes teammate's migration)
git pull origin dev

# 2. Delete YOUR local migration (not theirs!)
rm -rf prisma/migrations/20260317_your_migration/

# 3. Revert your schema changes temporarily
git checkout prisma/schema.prisma

# 4. Apply teammate's migration to your local database
npx prisma migrate dev

# 5. Re-apply your schema changes
# Edit schema.prisma again

# 6. Generate a new migration (on top of teammate's)
npx prisma migrate dev --name your_migration_name

# 7. Commit and push
git add prisma/
git commit -m "Add your migration (rebased on teammate's changes)"
```

**If you get a "migration history conflict" error:** This means your local `_prisma_migrations` table has entries that don't match the migration files on disk. In development, `prisma migrate reset` is the easiest fix.

### 7.5 PR Checklist for Schema Changes

When reviewing a PR that includes schema changes:

- [ ] Does the migration have a descriptive name? (`add_user_profile` not `update`)
- [ ] Is `schema.prisma` included in the PR?
- [ ] Are the migration files (`prisma/migrations/`) included in the PR?
- [ ] Has the generated SQL been reviewed? (Check `migration.sql`)
- [ ] Are there any destructive operations (DROP TABLE, DROP COLUMN)?
- [ ] If adding a required field, is there a backfill strategy?
- [ ] If renaming, are `@map`/`@@map` used to preserve data?
- [ ] Has `onDelete` been explicitly set on new relations?
- [ ] Has the migration been tested with production-like data?
- [ ] Is `prisma.config.ts` modified? If so, review the changes carefully.

### 7.6 What to Commit to Version Control

**Always commit:**

- `prisma/schema.prisma`
- `prisma/migrations/` (entire directory, including `migration_lock.toml`)
- `prisma.config.ts` (Prisma 7)

**Never commit:**

- `.env` files with real database URLs
- `node_modules/.prisma/` (generated client, not source code)

**Add to `.gitignore`:**

```gitignore
node_modules/
.env
.env.local
```

---

## 8. Rollback Strategies

### 8.1 Why Prisma Has No Built-in Rollback

Unlike some ORM frameworks (e.g., Django, Rails, Knex) that generate both "up" and "down" migrations, Prisma only generates forward ("up") migrations. This is a deliberate design choice:

1. **Automatically generated "down" migrations are unreliable.** Reversing a column addition is trivial, but reversing a data transformation or table split is impossible to automate safely.
2. **Forward-only encourages safer practices.** Rather than relying on rollback, teams are encouraged to write additive migrations and use the expand/contract pattern.

However, you can still manually create rollback scripts. Here's how.

### 8.2 Generating Rollback SQL with `migrate diff`

Before applying a migration, generate a rollback script:

```bash
# BEFORE applying the migration, save the current state
# Generate rollback SQL: from new schema back to current migrations
npx prisma migrate diff \
  --from-schema prisma/schema.prisma \
  --to-migrations ./prisma/migrations \
  --script > rollback.sql

# Then create and apply the migration
npx prisma migrate dev --name add_coupon_table
```

The `rollback.sql` file contains the SQL needed to undo the migration.

**Store rollback scripts alongside migrations:**

```
prisma/migrations/
├── 20260315_add_coupon_table/
│   ├── migration.sql      # Forward migration
│   └── rollback.sql       # Reverse migration (manually generated)
```

### 8.3 Manual Rollback Process

When a production migration fails and you need to roll back:

**Step 1: Assess the situation**

```bash
npx prisma migrate status
# Look for: "Following migration have failed: ..."
```

Check the `_prisma_migrations` table for error details:

```sql
SELECT migration_name, logs, started_at, finished_at, rolled_back_at
FROM _prisma_migrations
ORDER BY started_at DESC
LIMIT 5;
```

**Step 2: Determine the failure point**

- If `finished_at` is NULL, the migration is still in-progress or crashed mid-way.
- Check `applied_steps_count` to see how many SQL statements were applied before the failure.
- Read the `logs` column for the specific error.

**Step 3a: Forward fix (complete the migration manually)**

If the migration partially applied and you can fix the remaining SQL:

```bash
# Apply the remaining SQL manually
npx prisma db execute --file fix.sql

# Mark as applied
npx prisma migrate resolve --applied "20260315_add_coupon_table"
```

**Step 3b: Roll back (undo the migration)**

If you need to undo:

```bash
# Apply the rollback SQL
npx prisma db execute --file prisma/migrations/20260315_add_coupon_table/rollback.sql

# Mark as rolled back
npx prisma migrate resolve --rolled-back "20260315_add_coupon_table"
```

**Step 4: Fix and re-deploy**

After resolving the issue, fix the migration file (or create a new one) and re-deploy with `prisma migrate deploy`.

> **Important:** Until you resolve a failed migration state (either by marking it as applied or rolled back), `prisma migrate deploy` will refuse to run.

### 8.4 Forward Fixes vs Rollbacks

In most cases, a **forward fix** (deploying a corrected migration) is safer than a rollback:

| Approach    | When to Use                                                        |
| ----------- | ------------------------------------------------------------------ |
| Forward fix | The migration partially applied; you can complete it manually      |
| Forward fix | The fix is a small SQL correction                                  |
| Forward fix | Rolling back would lose data that was inserted since the migration |
| Rollback    | The migration completely failed (nothing was applied)              |
| Rollback    | The migration applied but introduced a critical bug                |
| Rollback    | You have a tested rollback script ready                            |
| DB restore  | The migration is catastrophically broken and data is corrupted     |

### 8.5 Database Backup as Rollback

For catastrophic failures, database backups are your last resort:

| Provider      | Backup Type             | Recovery Time    |
| ------------- | ----------------------- | ---------------- |
| Supabase      | Daily + PITR (Pro plan) | Minutes (PITR)   |
| AWS RDS       | Automated + PITR        | Minutes to hours |
| GCP Cloud SQL | Automated + PITR        | Minutes to hours |
| Self-hosted   | Manual `pg_dump` / WAL  | Depends on setup |

**Pre-migration backup workflow:**

```bash
# 1. Take a backup before the migration
pg_dump "$PRODUCTION_DATABASE_URL" > backup-$(date +%Y%m%d-%H%M%S).sql

# 2. Run the migration
npx prisma migrate deploy

# 3. If catastrophic failure:
#    - Restore from backup
#    - Fix the migration
#    - Re-deploy
```

**Supabase PITR (Point-in-Time Recovery):**

If you're on Supabase Pro, you can restore to any point in the last 7 days:

1. Go to Supabase Dashboard → Database → Backups
2. Select "Point in Time Recovery"
3. Choose a timestamp before the failed migration
4. Restore

### 8.6 Pre-Generating Companion Rollback Scripts

A disciplined workflow for mission-critical applications:

```bash
# 1. Create migration (don't apply yet)
npx prisma migrate dev --create-only --name add_inventory_tracking

# 2. Generate rollback script BEFORE applying
npx prisma migrate diff \
  --from-schema prisma/schema.prisma \
  --to-migrations ./prisma/migrations \
  --script > prisma/migrations/20260320_add_inventory_tracking/rollback.sql

# 3. Review both migration.sql and rollback.sql

# 4. Apply the migration
npx prisma migrate dev

# 5. Commit both files
git add prisma/migrations/
git commit -m "Add inventory tracking with rollback script"
```

---

## 9. Production Deployment and CI/CD

### 9.1 Pipeline Integration

`prisma migrate deploy` should run **before** your application starts, as part of the deployment process.

**GitHub Actions:**

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install dependencies
        run: npm ci

      - name: Generate Prisma Client
        run: npx prisma generate

      - name: Deploy database migrations
        run: npx prisma migrate deploy
        env:
          DIRECT_URL: ${{ secrets.DIRECT_URL }}

      - name: Deploy application
        run: # Your deployment command
```

**Dockerfile:**

```dockerfile
FROM node:20-alpine

WORKDIR /app
COPY . .
RUN npm ci
RUN npx prisma generate

# Run migrations at container start
CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]
```

**Netlify (build command):**

```toml
# netlify.toml
[build]
  command = "npx prisma generate && npx prisma migrate deploy && npm run build"
```

**Key principles:**

- **Never run `migrate dev` in CI/CD** -- only `migrate deploy`
- **Run migrations before the application starts** -- the app expects the latest schema
- `migrate deploy` exits with a non-zero code on failure, which fails the pipeline

### 9.2 Advisory Locking

Prisma automatically acquires a PostgreSQL advisory lock before running `prisma migrate deploy`. This prevents concurrent migration runs from corrupting the database.

**How it works:**

1. `migrate deploy` acquires an advisory lock with key `72707369` (hex for "pris")
2. If another `migrate deploy` is already running, it waits up to 10 seconds
3. If the lock isn't acquired within 10 seconds, the migration fails
4. After all migrations are applied, the lock is released

**What this means for you:**

- Two simultaneous deployments won't both run migrations (one will wait or fail)
- If a deployment crashes mid-migration, the advisory lock is released when the database connection closes

**If you hit "timeout waiting for advisory lock":**

1. Check if another deployment is running
2. Check for long-running transactions that might hold the lock
3. If stuck, manually release: `SELECT pg_advisory_unlock_all();`

**Disabling advisory locks (advanced):**

```bash
# Only if you have your own concurrency control mechanism
PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK=true npx prisma migrate deploy
```

### 9.3 Connection Pooling and the Two-URL Strategy

Most production PostgreSQL setups use a connection pooler (PgBouncer, Supavisor, pgpool). Prisma migrations **cannot run through a transaction-mode pooler** because they use features (prepared statements, advisory locks, DDL) that require a persistent session.

**The two-URL strategy:**

| URL            | Used By                       | Connection Type                    |
| -------------- | ----------------------------- | ---------------------------------- |
| `DATABASE_URL` | Application (Prisma Client)   | Pooled (transaction mode)          |
| `DIRECT_URL`   | Migrations (`migrate deploy`) | Direct (no pooler) or session mode |

**Configuration in `prisma.config.ts`:**

```typescript
export default defineConfig({
  datasource: {
    url: env("DIRECT_URL"), // Used by CLI commands (migrations). This IS the
    // direct connection; prisma.config.ts has no separate `directUrl` key.
  },
});
```

**In your application (`lib/prisma.ts`):**

```typescript
// Application code uses the pooled connection
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL, // Pooled URL
});

const prisma = new PrismaClient({ adapter });
```

**Connection pool sizing:**

| Deployment Type           | Recommended Pool Size             |
| ------------------------- | --------------------------------- |
| Traditional server        | `num_cpus * 2 + 1`                |
| Serverless (Lambda, Edge) | `connection_limit=1` per instance |
| Container (Docker, K8s)   | `connection_limit=5-10` per pod   |

### 9.4 Zero-Downtime Migrations

**Migrations that are zero-downtime (additive):**

- Adding a new table
- Adding a new nullable column
- Adding a new index (use `CONCURRENTLY` for large tables)
- Adding a new enum value
- Adding an optional relation

**Migrations that require downtime (breaking):**

- Dropping a table or column
- Renaming a table or column
- Making a nullable column required
- Changing a column type
- Removing an enum value

**Strategy for zero-downtime breaking changes:**

Use the expand/contract pattern across multiple deployments:

```
Deploy 1: Expand
  - Migration: Add new column alongside old
  - Code: Write to both old and new columns, read from old

Deploy 2: Migrate
  - Script: Backfill new column from old column
  - Code: Write to both, read from new

Deploy 3: Contract
  - Migration: Drop old column
  - Code: Only use new column
```

This ensures the application works correctly at every stage, even during rolling deployments where some instances are on the old code and some on the new.

### 9.5 Health Checks and Smoke Tests

After running migrations in production:

```bash
# 1. Verify migration status
npx prisma migrate status
# Expected: "Database schema is up to date!"

# 2. Hit your health endpoint
curl -f https://your-app.com/api/health

# 3. Run critical query tests
curl -f https://your-app.com/api/products?limit=1
```

**Automated verification in CI/CD:**

```yaml
- name: Run migrations
  run: npx prisma migrate deploy

- name: Verify migration status
  run: |
    STATUS=$(npx prisma migrate status 2>&1)
    if echo "$STATUS" | grep -q "Database schema is up to date"; then
      echo "Migrations applied successfully"
    else
      echo "Migration issue detected: $STATUS"
      exit 1
    fi
```

### 9.6 Environment Variable Management

Keep these environment variables consistent across environments:

| Variable              | Development                      | Staging / Production                        |
| --------------------- | -------------------------------- | ------------------------------------------- |
| `DATABASE_URL`        | Local PostgreSQL (pooled)        | Pooled connection (port 6543)               |
| `DIRECT_URL`          | Local PostgreSQL (direct)        | Direct connection (port 5432)               |
| `SHADOW_DATABASE_URL` | Optional (local can auto-create) | Usually not needed (only for `migrate dev`) |

**Tips:**

- Use `.env` for local development, CI secrets for production
- Never commit `.env` files to version control
- Ensure `DIRECT_URL` is always set in environments where you run migrations
- Add a fallback in `prisma.config.ts` for environments where no DB is needed (e.g., `prisma generate` in CI)

---

## 10. Squashing Migrations

### 10.1 When to Squash

Over time, the `prisma/migrations/` directory accumulates hundreds of migration files. This causes:

- Slower `prisma migrate dev` (replays all migrations on shadow DB)
- Harder to read migration history
- CI build times increase

**Good times to squash:**

- Before the first production deployment (all migrations are development-only)
- During a major version release
- When `prisma migrate dev` becomes noticeably slow

**Bad times to squash:**

- Right after a production deployment (environments are out of sync)
- When team members have pending branches with migrations

### 10.2 Development Squashing (Feature Branch)

Before merging a feature branch with many intermediate migrations:

```bash
# 1. Note the base branch's last migration
git log --oneline main -- prisma/migrations/ | head -1

# 2. Reset migrations to main's state
git checkout main -- prisma/migrations

# 3. Generate a single squashed migration
npx prisma migrate dev --name squashed_feature_orders

# This creates ONE migration from main's state to your feature's current schema
```

### 10.3 Production Squashing (Full History)

When you want to compress all historical migrations into one:

```bash
# 1. Ensure ALL environments are up to date
npx prisma migrate status  # on every environment

# 2. Delete all migration directories (keep migration_lock.toml)
rm -rf prisma/migrations/*/

# 3. Generate the squashed baseline migration
mkdir -p prisma/migrations/0_squashed

npx prisma migrate diff \
  --from-empty \
  --to-schema prisma/schema.prisma \
  --script > prisma/migrations/0_squashed/migration.sql

# 4. In each environment that already has all migrations applied:
npx prisma migrate resolve --applied "0_squashed"

# 5. Clean old entries from _prisma_migrations
#    (Optional: keeps only the squashed entry)
```

> **Note:** The `0_` prefix ensures the squashed migration sorts first lexicographically.

### 10.4 Baselining an Existing Database

If you have a production database that was set up before Prisma Migrate (e.g., created manually, by another ORM, or by `prisma db push`):

```bash
# 1. Generate a migration that represents the current database state
mkdir -p prisma/migrations/0_baseline

npx prisma migrate diff \
  --from-empty \
  --to-url "$DATABASE_URL" \
  --script > prisma/migrations/0_baseline/migration.sql

# 2. Mark this migration as already applied (don't actually run the SQL)
npx prisma migrate resolve --applied "0_baseline"

# 3. From now on, all new changes go through prisma migrate dev
```

### 10.5 Risks and Caveats

**Custom SQL is lost.** If your migration files contain manual additions (data backfills, `CREATE INDEX CONCURRENTLY`, stored procedures, views, RLS policies), these will NOT appear in the squashed migration. You must re-add them manually.

**All environments must be coordinated.** Every database that has applied the old migrations must be told about the squashed migration via `migrate resolve --applied`.

**Known issues.** Some users have reported that migrations created after squashing sometimes fail to apply correctly (see [Prisma GitHub issue #25358](https://github.com/prisma/prisma/issues/25358)). Test thoroughly after squashing.

---

## 11. Schema Drift

### 11.1 What is Schema Drift

Schema drift occurs when the actual database schema differs from what Prisma's migration history says it should be. In other words, if you replay all your migrations on an empty database, the result doesn't match your actual database.

### 11.2 Common Causes

| Cause                                    | How It Happens                                            |
| ---------------------------------------- | --------------------------------------------------------- |
| Manual SQL changes                       | Running `ALTER TABLE` via psql, pgAdmin, or a dashboard   |
| Using `prisma db push` after `migrate`   | `db push` changes the DB without creating migration files |
| External tools modifying the schema      | A CMS, admin panel, or other service alters tables        |
| Failed migrations that partially applied | Half the SQL ran before the error                         |
| Editing migration files after applying   | Checksum mismatch between file and `_prisma_migrations`   |
| Other team members making direct changes | Someone ran SQL directly on a shared database             |

### 11.3 Detecting Drift

**Method 1: `prisma migrate diff`**

```bash
# Compare migration history against actual database
npx prisma migrate diff \
  --from-migrations ./prisma/migrations \
  --to-url "$DATABASE_URL" \
  --script
```

If the output is empty, there's no drift. If it contains SQL statements, those represent the drift.

**Method 2: `prisma migrate dev`**

When you run `prisma migrate dev`, it automatically detects drift using the shadow database. If drift is found, it will warn you and may prompt to reset.

**Method 3: `prisma migrate status`**

```bash
npx prisma migrate status
```

This shows if any migrations are pending, failed, or if the database is out of sync.

### 11.4 Resolving Drift

**Option A: Adopt the drift (the manual change was intentional)**

If someone made a legitimate change directly to the database (e.g., an emergency hotfix):

```bash
# 1. Introspect the database to see the actual state
npx prisma db pull

# 2. Review the changes in schema.prisma

# 3. Create a migration that represents the drift
npx prisma migrate dev --name retroactive_hotfix

# 4. In environments where the change is already applied:
npx prisma migrate resolve --applied "20260320_retroactive_hotfix"
```

**Option B: Revert the drift (the manual change was accidental)**

```bash
# 1. Generate SQL to bring the database back in line with migrations
npx prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-migrations ./prisma/migrations \
  --script > fix-drift.sql

# 2. Review the SQL carefully

# 3. Apply it
npx prisma db execute --file fix-drift.sql
```

**Option C: Reset (development only)**

```bash
npx prisma migrate reset
# This drops the database, recreates it, and applies all migrations
```

### 11.5 Preventing Drift

1. **Never use `prisma db push` on a database that uses Prisma Migrate.** Choose one or the other.
2. **Never make manual DDL changes in production.** If an emergency hotfix is absolutely necessary, immediately create a corresponding migration file and mark it as applied.
3. **Restrict database access.** Use dedicated database users with appropriate permissions. The application user should not have `ALTER TABLE` privileges.
4. **Run `prisma migrate status` in CI.** Catch drift before it reaches production.
5. **If other services share your database** (CMS, analytics tools), ensure they use separate schemas or tables with a naming prefix that doesn't conflict with Prisma-managed tables.

---

## 12. Supabase-Specific Considerations

> **This section is specific to Supabase-hosted PostgreSQL.** Skip if you use a different provider.

### 12.1 The Two-URL Strategy

Supabase provides multiple connection endpoints:

| Endpoint                | Port | Mode              | Use For                        |
| ----------------------- | ---- | ----------------- | ------------------------------ |
| Supavisor (transaction) | 6543 | Transaction mode  | Application queries            |
| Supavisor (session)     | 5432 | Session mode      | Migrations, long queries       |
| Direct (IPv6)           | 5432 | Direct connection | Migrations (if IPv6 available) |

**Environment variables:**

```bash
# .env
# Application queries (pooled, transaction mode)
DATABASE_URL="postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres?pgbouncer=true"

# Migrations (session mode or direct)
DIRECT_URL="postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres"
```

**The `?pgbouncer=true` parameter** disables prepared statements, which is required when connecting through Supavisor in transaction mode (Supavisor replaced PgBouncer but the parameter name is the same).

### 12.2 Connection Pooling with Supavisor

Supabase uses Supavisor as its connection pooler. Key facts:

- **Transaction mode (port 6543):** Each query gets a connection from the pool, then returns it. Prepared statements and advisory locks don't work across queries.
- **Session mode (port 5432):** A dedicated connection for the entire session. Prepared statements and advisory locks work.

**Prisma Migrate must use session mode or direct connection** because:

- Migrations use advisory locks (require persistent connection)
- Migrations use DDL statements that should run in a session context
- Migrations may use transactions that span multiple statements

### 12.3 Shadow Database on Supabase

Supabase restricts the `CREATE DATABASE` privilege, which Prisma needs for the shadow database during `prisma migrate dev`. Options:

**Option 1: Use a local PostgreSQL for development**

Run PostgreSQL locally (Docker, Homebrew, etc.) and use it for `prisma migrate dev`. Only use the Supabase URL for `prisma migrate deploy`.

```bash
# Local development
DATABASE_URL="postgresql://postgres:password@localhost:5432/myapp"

# Production deployment
DIRECT_URL="postgresql://postgres.[ref]:...@pooler.supabase.com:5432/postgres"
```

**Option 2: Create a separate shadow database**

Create a second Supabase project (free tier) dedicated as a shadow database:

```bash
SHADOW_DATABASE_URL="postgresql://postgres.[shadow-ref]:...@pooler.supabase.com:5432/postgres"
```

```typescript
// prisma.config.ts
export default defineConfig({
  datasource: {
    url: env("DIRECT_URL"),
    shadowDatabaseUrl: env("SHADOW_DATABASE_URL"),
  },
});
```

### 12.4 Baselining a Supabase Project

If you created tables through the Supabase Dashboard SQL Editor before adopting Prisma Migrate:

```bash
# 1. Introspect the database
npx prisma db pull

# 2. Review and clean up the generated schema.prisma

# 3. Create a baseline migration
mkdir -p prisma/migrations/0_init_supabase

npx prisma migrate diff \
  --from-empty \
  --to-schema prisma/schema.prisma \
  --script > prisma/migrations/0_init_supabase/migration.sql

# 4. Mark as already applied
npx prisma migrate resolve --applied 0_init_supabase
```

### 12.5 Supabase Branching

Supabase offers database branching (on Pro plan), which creates isolated database copies for each Git branch:

1. Create a Supabase branch → gets its own database URL
2. Run `prisma migrate deploy` against the branch URL
3. Test your migrations in isolation
4. Merge the Git branch → merge the Supabase branch

This is useful for testing destructive migrations safely before applying to production.

**Important:** Any SQL changes made via the Supabase Dashboard (triggers, views, RLS policies, functions) must also be managed as part of your migration strategy if you use branching.

---

## 13. Prisma 7 Migration System Changes

> This section summarizes what changed in Prisma 7's migration system. For the complete Prisma 6-to-7 upgrade guide (including runtime changes like driver adapters), see your project's specific upgrade documentation.

### 13.1 Configuration Changes

**Prisma 7** moved datasource configuration from `schema.prisma` to `prisma.config.ts`:

```typescript
// prisma.config.ts (Prisma 7 -- canonical)
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "npx tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
    directUrl: env("DIRECT_URL"),
    shadowDatabaseUrl: env("SHADOW_DATABASE_URL"),
  },
});
```

**Prisma 6** (for reference):

```prisma
// schema.prisma (Prisma 6)
datasource db {
  provider          = "postgresql"
  url               = env("DATABASE_URL")
  directUrl         = env("DIRECT_URL")
  shadowDatabaseUrl = env("SHADOW_DATABASE_URL")
}
```

In Prisma 7, the `datasource` block in `schema.prisma` retains only the `provider` field. The `url`, `directUrl`, and `shadowDatabaseUrl` fields are deprecated there and must be in `prisma.config.ts`.

### 13.2 Driver Adapters

Prisma 7 replaced the Rust query engine with a TypeScript "Query Compiler." This affects your **application runtime** but has minimal impact on migrations:

- `prisma migrate dev`, `migrate deploy`, etc. use the URL from `prisma.config.ts` directly
- They do NOT use the driver adapter configured in your application code
- The migration system itself (shadow database, checksums, advisory locks) is unchanged

### 13.3 Removed Options

| Removed                               | Replacement                                      |
| ------------------------------------- | ------------------------------------------------ |
| `engine: "classic"` in config         | Removed entirely. Use driver adapters.           |
| `engineType = "library"` in generator | Removed. No longer bypasses adapter requirement. |
| `--url` flag on many CLI commands     | Use `prisma.config.ts` for connection config     |
| `--shadow-database-url` flag          | Use `shadowDatabaseUrl` in `prisma.config.ts`    |
| `--schema` flag on some commands      | Use `schema` in `prisma.config.ts`               |

### 13.4 Seeding Changes

**Prisma 7** no longer automatically runs the seed script after `prisma migrate dev` or `prisma migrate reset`. You must:

1. Configure the seed command in `prisma.config.ts`:

```typescript
migrations: {
  seed: "npx tsx prisma/seed.ts",
},
```

2. Run it explicitly:

```bash
npx prisma db seed
```

The `--skip-seed` and `--skip-generate` flags were removed from `migrate dev`, `migrate reset` and `db push`, because neither seeding nor client generation runs automatically any more.

### 13.5 Migration Commands Are Unchanged

Despite the major architectural changes in Prisma 7, the migration commands themselves work the same way:

- `prisma migrate dev` -- same behavior, same flags
- `prisma migrate deploy` -- same behavior
- `prisma migrate status` -- same behavior
- `prisma migrate resolve` -- same behavior
- `prisma migrate diff` -- same behavior (minus `--shadow-database-url` flag)
- `prisma migrate reset` -- same behavior (minus auto-seeding)

If your migration workflow worked on Prisma 6, it will work on Prisma 7 with only the configuration changes described above.

---

## 14. Troubleshooting

### Error: "Drift detected: Your database schema is not in sync"

**Cause:** The actual database doesn't match what the migration history expects. Someone used `prisma db push`, ran manual SQL, or an external tool modified the schema.

**Fix:** See [Section 11.4: Resolving Drift](#114-resolving-drift).

---

### Error: "The migration `X` was modified after it was applied"

**Cause:** A migration file was edited after it was applied to this database. The SHA-256 checksum no longer matches.

**Fix (development):** Reset and reapply:

```bash
npx prisma migrate reset
```

**Fix (production):** If the edit was intentional and the database is in the correct state:

```sql
-- Update the checksum in _prisma_migrations to match the new file
-- First, get the new checksum:
-- sha256sum prisma/migrations/20260315_migration/migration.sql
UPDATE _prisma_migrations
SET checksum = '<new-checksum>'
WHERE migration_name = '20260315_migration';
```

> **Warning:** Only do this if you are absolutely sure the database state matches the edited migration file.

---

### Error: P3005 "The database schema is not empty"

**Cause:** You're trying to apply a migration (including a baseline) to a database that already has tables, but the `_prisma_migrations` table doesn't exist or doesn't have the baseline recorded.

**Fix:** Baseline the database:

```bash
npx prisma migrate resolve --applied "0_baseline"
```

---

### Error: P3006 "Migration `X` failed to apply cleanly to the shadow database"

**Cause:** The migration SQL contains an error, or the migration was written for a different database state than the shadow database reproduces.

**Fix:**

```bash
# Check what's wrong
npx prisma migrate diff \
  --from-migrations ./prisma/migrations \
  --to-schema prisma/schema.prisma \
  --script
```

If the migration file has a bug, fix it and run `prisma migrate dev` again. If the migration was already applied elsewhere, you may need to use `migrate resolve`.

---

### Error: P3009 "migrate found failed migrations in the target database"

**Cause:** A previous migration failed partway through and wasn't resolved.

**Fix:**

```bash
# Check which migration failed
npx prisma migrate status

# Option 1: Complete the migration manually and mark as applied
npx prisma migrate resolve --applied "20260315_failed_migration"

# Option 2: Roll back and mark as rolled back
npx prisma migrate resolve --rolled-back "20260315_failed_migration"
```

Check the `logs` column in `_prisma_migrations` for the specific error:

```sql
SELECT migration_name, logs FROM _prisma_migrations
WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;
```

---

### Error: P3014 "Prisma Migrate could not create the shadow database"

**Cause:** The database user doesn't have `CREATE DATABASE` privileges. Common on hosted providers (Supabase, PlanetScale, etc.).

**Fix:** Provide a dedicated shadow database:

```typescript
// prisma.config.ts
export default defineConfig({
  datasource: {
    url: env("DIRECT_URL"),
    shadowDatabaseUrl: env("SHADOW_DATABASE_URL"),
  },
});
```

Create the shadow database manually or use a separate instance/project.

---

### Error: P1001 "Can't reach database server"

**Cause:** Wrong URL, database is down, firewall blocking connection, SSL issues.

**Fix:**

1. Verify the database URL is correct
2. Check if the database server is running
3. Check firewall rules and security groups
4. If using SSL, ensure the certificate is valid
5. If using a pooler, try the direct URL instead
6. Check IPv4 vs IPv6 connectivity

---

### Error: P1003 "Database `X` does not exist"

**Cause:** The database specified in the URL hasn't been created.

**Fix:**

```bash
# Create the database
createdb myapp

# Or in SQL:
# CREATE DATABASE myapp;
```

Note: `prisma migrate deploy` will create the database if it doesn't exist (as of Prisma 4.x+).

---

### Error: "Column `X` cannot be cast to type `Y`"

**Cause:** You're changing a column's type to something incompatible with the existing data.

**Fix:** Use the multi-step approach from [Section 5.5](#55-changing-field-types):

1. Add a new column with the target type
2. Copy and transform data
3. Drop the old column
4. Rename the new column

---

### Error: "Cannot drop column, constraint depends on it"

**Cause:** A foreign key, unique constraint, or index references the column you're trying to drop.

**Fix:** Drop the constraint first, then the column. Use `--create-only` and edit the SQL:

```sql
-- Find the constraint name
-- SELECT conname FROM pg_constraint WHERE conrelid = 'table_name'::regclass;

-- Drop constraint first
ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_productId_fkey";

-- Then drop the column
ALTER TABLE "OrderItem" DROP COLUMN "productId";
```

---

### Error: "Table `X` does not exist in the current database"

**Cause:** The table referenced in a query or migration doesn't exist.

**Common reasons:**

1. Migration that creates the table hasn't been applied: `npx prisma migrate status`
2. Table name is case-sensitive: PostgreSQL lowercases unquoted identifiers. `"User"` (quoted) and `user` (unquoted) are different.
3. Implicit M2M join table has unexpected name: Prisma names implicit join tables as `_<ModelA>To<ModelB>` in alphabetical order. If the models were renamed, the join table name changes.

**Fix for implicit M2M naming issues:**

```sql
-- Check what the join table is actually called
SELECT table_name FROM information_schema.tables
WHERE table_name LIKE '_%To%';

-- Rename if needed
ALTER TABLE "_OldNameToOldName" RENAME TO "_NewNameToNewName";
```

Better yet: convert to explicit M2M (see [Section 5.8](#58-relation-changes)).

---

### Error: "Unique constraint failed" during migration

**Cause:** Adding a `@@unique` constraint to a column that has duplicate values.

**Fix:** Clean up duplicates before adding the constraint:

```sql
-- Find duplicates
SELECT "email", COUNT(*) FROM "User"
GROUP BY "email" HAVING COUNT(*) > 1;

-- Remove duplicates (keep the first occurrence)
DELETE FROM "User" a USING "User" b
WHERE a."id" > b."id" AND a."email" = b."email";
```

---

### Error: "Foreign key constraint failed"

**Cause:** Adding a foreign key to a column that has orphaned references (values pointing to non-existent parent rows).

**Fix:** Clean up orphaned references first:

```sql
-- Find orphaned order items (referencing non-existent products)
SELECT oi.* FROM "OrderItem" oi
LEFT JOIN "Product" p ON oi."productId" = p."id"
WHERE p."id" IS NULL;

-- Delete orphaned rows
DELETE FROM "OrderItem"
WHERE "productId" NOT IN (SELECT "id" FROM "Product");
```

---

### Error: "Environment variable not found: DATABASE_URL"

**Cause:** The `.env` file is missing, the variable isn't set, or `dotenv` isn't loaded.

**Fix:**

1. Ensure `.env` exists with the variable defined
2. In Prisma 7, ensure `prisma.config.ts` imports `dotenv`:

```typescript
import "dotenv/config"; // Must be at the top
```

3. In CI/CD, ensure the variable is set as a secret/env var
4. Add a fallback for environments that don't need a real DB:

```typescript
const databaseUrl =
  process.env.DIRECT_URL ||
  "postgresql://placeholder:placeholder@localhost:5432/placeholder";
```

---

### Error: "Using engine type 'client' requires adapter" (Prisma 7)

**Cause:** `PrismaClient` was instantiated without a driver adapter. In Prisma 7, the default engine requires an adapter.

**Fix:**

```typescript
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

const prisma = new PrismaClient({ adapter });
```

Also search for other `new PrismaClient()` calls in your codebase that might not have the adapter:

```bash
grep -r "new PrismaClient" --include="*.ts" --include="*.js"
```

---

### Error: "Timeout waiting for advisory lock"

**Cause:** Another `prisma migrate deploy` is running concurrently, or a long-running transaction holds the lock.

**Fix:**

1. Wait for the other migration to finish
2. Check for stuck transactions:

```sql
SELECT pid, now() - pg_stat_activity.query_start AS duration, query
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY duration DESC;
```

3. If truly stuck, manually release:

```sql
SELECT pg_advisory_unlock_all();
```

4. If the issue is chronic, consider disabling advisory locks (only if you have your own concurrency control):

```bash
PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK=true npx prisma migrate deploy
```

---

### Error: "prepared statement `X` already exists"

**Cause:** Running Prisma through a connection pooler in transaction mode, which doesn't support prepared statements across queries.

**Fix:** Add `?pgbouncer=true` to your pooled connection URL:

```
DATABASE_URL="postgresql://...@pooler.example.com:6543/mydb?pgbouncer=true"
```

And use a direct connection for migrations:

```
DIRECT_URL="postgresql://...@db.example.com:5432/mydb"
```

---

## 15. Best Practices Checklist

1. **Never edit migration files after they are committed.** Checksums in `_prisma_migrations` will mismatch, causing errors in every environment where the migration was applied.

2. **Use descriptive migration names.** `add_order_status_enum` and `create_inventory_table` tell you what happened. `update` and `fix` tell you nothing.

3. **One logical change per migration.** A migration that adds a table AND changes an enum AND backfills data is hard to review, debug, and roll back. Split them.

4. **Always use `@map`/`@@map` for renames.** Without them, Prisma generates a DROP + CREATE, destroying all data in the column.

5. **Prefer explicit join tables over implicit M2M.** Explicit tables give you control over naming, extra fields, and `onDelete` behavior. Implicit tables have naming surprises.

6. **Always set `onDelete` explicitly on relations.** The Prisma default depends on whether the relation is required or optional. Be explicit to avoid cascade-delete surprises.

7. **Review generated SQL before applying.** Use `--create-only` to generate the migration file, inspect `migration.sql`, edit if needed, then apply.

8. **Test migrations with production-like data.** Empty databases hide NOT NULL violations, unique constraint failures, and type casting errors.

9. **Back up before production migrations.** Take a `pg_dump` or verify your PITR is working before running `prisma migrate deploy` in production.

10. **Use `migrate deploy` in CI/CD, `migrate dev` locally.** Never cross the streams. `migrate dev` can reset your database; `migrate deploy` won't.

11. **Add NOT NULL columns in multiple steps.** Nullable first, backfill, then make required. Direct NOT NULL additions fail on populated tables.

12. **Pre-generate rollback scripts.** Since Prisma has no built-in rollback, create companion `rollback.sql` files using `prisma migrate diff`.

13. **Run `prisma validate` in pre-commit hooks.** Catch schema errors before they're committed.

14. **Run `prisma format` to keep schema style consistent.** Reduces diff noise in pull requests.

15. **Keep `prisma.config.ts` env fallbacks for CI.** Build steps that run `prisma generate` don't need a real database connection.

16. **Commit all migration files to version control.** The `prisma/migrations/` directory, including `migration_lock.toml`, is part of your codebase.

17. **Communicate schema changes to the team.** A quick message prevents migration conflicts before they happen.

---

## 16. Cross-References and Resources

### Project-Specific Documentation

If you're working on a specific project that uses Prisma, check for these additional docs:

- [README.md](./README.md) -- The index for this directory, and which of these documents applies to the current posture.
- [00-schema-map.md](./00-schema-map.md) -- Domain diagrams of the schema itself.
- [02-pre-mvp-reset-runbook.md](./02-pre-mvp-reset-runbook.md) -- The one-time reset that finalises the launch schema, and why there is no backfill migration.
- [03-cutover-to-migrations.md](./03-cutover-to-migrations.md) -- The launch-day runbook that puts this database under versioned migrations, including the sidecar step a generated baseline would otherwise miss.
- [04-prisma-7-migration.md](./04-prisma-7-migration.md) -- The record of the Prisma 6 to 7 upgrade and the eight issues it hit.
- `.claude/skills/schema/` -- The `/schema` skill: the change catalog with lock classes, the expand-and-contract playbooks, and the deploy-ordering rules.

#### Familiarise: additive composite indexes (PR #887)

The navigation-performance work added three composite indexes to the Familiarise database. Because adding an index is a non-destructive operation (see [Section 5.7](#57-index-and-constraint-changes)), these were applied additively with `CREATE INDEX CONCURRENTLY` so that the indexes built without locking the underlying tables, rather than through a destructive reset migration. The three indexes are `Payment(userId, organizationId, createdAt)`, `Waitlist(userId, status)` (since removed with the event waitlist), and `ConsultantReview(consultantProfileId)`; the last of these resolves the full-table scan behind the explore page's trending sort (#696). Two further candidates were considered and skipped as redundant: a `Consultation`/`Subscription` index on `(planId, status)` was unnecessary because a superset index on `(planId, status, requestedAt)` already exists and a prefix of that index serves the same lookups.

Each index was created with the name that Prisma generates by convention (for example, `Payment_userId_organizationId_createdAt_idx`), so the schema declaration and the live database agree and no schema drift is introduced. As described in [Section 11](#11-schema-drift), a manually applied index that does not match the name Prisma would generate shows up as drift on the next diff; following the convention avoids that.

The same PR added Prisma slow-query logging in `lib/prisma.ts`. A `query` event hook compares each query's duration against the `PRISMA_SLOW_QUERY_MS` environment variable (default `500` milliseconds) and emits a `[Prisma:SLOW_QUERY]` warning for anything slower, which makes missing indexes and N+1 patterns visible in any environment without turning on full query logging.

### Official Prisma Documentation

- [Prisma Migrate Overview](https://www.prisma.io/docs/orm/prisma-migrate) -- Official migrate documentation
- [Development and Production Workflows](https://www.prisma.io/docs/orm/prisma-migrate/workflows/development-and-production) -- How to use migrate in different environments
- [Team Development](https://www.prisma.io/docs/orm/prisma-migrate/workflows/team-development) -- Coordinating migrations on a team
- [Generating Down Migrations](https://www.prisma.io/docs/orm/prisma-migrate/workflows/generating-down-migrations) -- Creating rollback scripts
- [Squashing Migrations](https://www.prisma.io/docs/orm/prisma-migrate/workflows/squashing-migrations) -- Cleaning up migration history
- [Patching and Hotfixing](https://www.prisma.io/docs/orm/prisma-migrate/workflows/patching-and-hotfixing) -- Handling production hotfixes
- [Troubleshooting](https://www.prisma.io/docs/orm/prisma-migrate/workflows/troubleshooting) -- Common errors and solutions
- [Production Troubleshooting](https://www.prisma.io/docs/guides/migrate/production-troubleshooting) -- Production-specific issues
- [Shadow Database](https://www.prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate/shadow-database) -- How the shadow database works
- [Mental Model](https://www.prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate/mental-model) -- Conceptual overview
- [Prisma Config Reference](https://www.prisma.io/docs/orm/reference/prisma-config-reference) -- `prisma.config.ts` options
- [Prisma Schema Reference](https://www.prisma.io/docs/reference/api-reference/prisma-schema-reference) -- Full schema language reference
- [Upgrade to Prisma 7](https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-7) -- Official v7 upgrade guide
- [Data Migration Guide](https://www.prisma.io/docs/guides/data-migration) -- Expand/contract pattern

### Database Provider Guides

- [Supabase + Prisma](https://supabase.com/docs/guides/database/prisma) -- Official Supabase integration guide
- [Supabase Prisma Troubleshooting](https://supabase.com/docs/guides/database/prisma/prisma-troubleshooting) -- Supabase-specific issues
- [PlanetScale + Prisma](https://www.prisma.io/docs/orm/overview/databases/planetscale) -- PlanetScale integration
- [Neon + Prisma](https://neon.tech/docs/guides/prisma) -- Neon integration

### Community Resources

- [Prisma GitHub Issues](https://github.com/prisma/prisma/issues) -- Bug reports and feature requests
- [Prisma Discord](https://discord.gg/prisma) -- Community support
- [Prisma Changelog](https://www.prisma.io/changelog) -- Latest release notes

---

_This guide is general-purpose and applicable to any Prisma project using PostgreSQL. For project-specific migration procedures, check your project's operations documentation._
