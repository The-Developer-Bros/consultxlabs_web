# Prisma and database schema documentation

This directory holds everything about the database schema: the general reference
for Prisma Migrate, the two runbooks that take this database from its current
`db push` posture to versioned migrations, the record of the Prisma 6 to 7
upgrade, and the model-by-model map of the schema itself.

Start here rather than in an individual file, because which document applies
depends on whether you are reasoning generally or working in this repository.

| Document                   | What it is                                                                                                                                                                                                       | Read it when                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `migrations-guide.md`      | The general-purpose reference for Prisma Migrate — every command, safe and dangerous operations, expand and contract, drift, rollback, troubleshooting. Written against a fictional schema so it stays portable. | You need to know what a Prisma command does, or how a class of change is handled in general. |
| `cutover-to-migrations.md` | The launch-day runbook that puts this database under versioned migrations, including the sidecar step that a generated baseline would otherwise miss.                                                            | On launch day, or when planning it.                                                          |
| `pre-mvp-reset-runbook.md` | The ordered procedure for the one-time reset that finalises the launch schema, and the reasoning behind having no backfill migrations.                                                                           | On reset day, or when asked why a change has no backfill.                                    |
| `schema-map.md`            | Twenty-four domain diagrams of the Prisma schema, plus the enum reference table.                                                                                                                                 | Orienting in an unfamiliar part of the schema, or tracing how two models relate.             |
| `prisma-7-migration.md`    | The historical record of the Prisma 6 to 7 upgrade — the eight issues hit and how each was resolved. The upgrade is complete; this is kept for reference.                                                        | Debugging something that smells like a Prisma 7 client or adapter problem.                   |

## The one thing to know first

This repository does not use versioned migrations yet. There is no
`prisma/migrations` directory, no `_prisma_migrations` table, and nothing for
`prisma migrate deploy` to apply. The schema is managed with `prisma db push`,
and the constraints and triggers that `db push` cannot express are applied
separately from `prisma/sql/` and asserted by `npm run db:assert-sidecars`.

That means `migrations-guide.md` describes the world this repository is moving
towards rather than the one it is in. Its command reference and its treatment of
safe and dangerous operations apply in full; its workflow chapters apply after
the cutover. `cutover-to-migrations.md` is the bridge between the two.

Because one Postgres project serves both development and production, every push,
seed and data script is a production operation. The current schema is also
frozen: additive changes only, with renames, drops and type changes deferred to
reset day. Both rules are stated at the top of `prisma/schema.prisma` and
enforced in review.

## Related material

The portable doctrine behind all of this — the change catalog with lock classes,
the expand and contract playbooks, the deploy ordering rules — is the `/schema`
skill in `.claude/skills/schema/`. Its `references/this-repo.md` is the short
version of this page for an agent that is about to edit the schema.

Keeping the seed suite in sync with a schema change is covered by the
`/maintenance` skill. The money invariants that the sidecars enforce, and why
they cannot live in the Prisma schema, are covered by `/finance`.
