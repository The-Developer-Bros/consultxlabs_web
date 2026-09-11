/**
 * CI guard — the SQL sidecars must actually be applied to the live database.
 *
 * Prisma manages neither triggers nor CHECK/EXCLUDE constraints, so every money
 * invariant that cannot be expressed in PSL lives in `prisma/sql/*.sql` and is
 * applied by `npm run db:sidecars`. The trap is that `npm run db:push:schema`
 * exists as a standalone script: run it on its own and the ledger balance
 * trigger plus every money CHECK silently disappear, with nothing in the
 * application or the test suite noticing. The double-entry invariant would then
 * be enforced by application code alone.
 *
 * This asserts that every named object declared in the sidecars is present in
 * the live catalog. It parses the SQL rather than hard-coding a list, so adding
 * a constraint to the sidecar automatically extends the guard.
 *
 * Skips cleanly (exit 0) when DATABASE_URL is absent, so forks and PRs without
 * secrets are not punished.
 */
// Without this the script reads a bare process.env, finds no DATABASE_URL, and
// self-skips with exit 0 — which is how this guard reported success on every CI
// run while never once executing. CI writes the secret to .env as a FILE; only
// Next loads that implicitly. Every other DB-touching script here does the same.
import "dotenv/config";
import path from "node:path";

import prisma from "../../lib/prisma";

const ROOT = path.join(__dirname, "..", "..");
const SQL_DIR = path.join(ROOT, "prisma", "sql");

import {
  parseSidecarDirectory,
  stripSqlComments,
  type SidecarObject,
} from "../db/sidecar-objects";

// Re-exported so the existing comment-stripping test keeps its import path;
// the implementation lives in scripts/db/sidecar-objects.ts (#1319).
export { stripSqlComments };

type Expected = SidecarObject;

function parseSidecars(): Expected[] {
  return parseSidecarDirectory(SQL_DIR);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("check-db-sidecars: DATABASE_URL unset — skipping");
    return;
  }

  const expected = parseSidecars();
  if (expected.length === 0) {
    console.error(
      "check-db-sidecars: parsed zero objects from prisma/sql — the parser or the sidecars changed shape",
    );
    process.exitCode = 1;
    return;
  }

  const constraints = new Set(
    (
      await prisma.$queryRaw<{ conname: string }[]>`
        SELECT c.conname FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace AND n.nspname = 'public'
      `
    ).map((r) => r.conname),
  );
  const indexes = new Set(
    (
      await prisma.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
      `
    ).map((r) => r.indexname),
  );
  const triggers = new Set(
    (
      await prisma.$queryRaw<{ tgname: string }[]>`
        SELECT t.tgname FROM pg_trigger t
        JOIN pg_class cl ON cl.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
        WHERE NOT t.tgisinternal
      `
    ).map((r) => r.tgname),
  );

  const missing: Expected[] = [];
  for (const e of expected) {
    const present =
      e.kind === "constraint"
        ? constraints.has(e.name)
        : e.kind === "index"
          ? indexes.has(e.name)
          : triggers.has(e.name);
    if (!present) missing.push(e);
  }

  if (missing.length > 0) {
    console.error(
      `check-db-sidecars: FAILED — ${missing.length} of ${expected.length} sidecar objects are missing from the live database:\n`,
    );
    for (const m of missing) {
      console.error(
        `  - ${m.kind} "${m.name}"${m.table ? ` on "${m.table}"` : ""} (declared in prisma/sql/${m.source})`,
      );
    }
    console.error(
      "\nRun `npm run db:sidecars` against this database. If this fired right after a schema " +
        "change, someone almost certainly ran `npm run db:push:schema` instead of `npm run db:push` — " +
        "the former does not reapply the trigger or the CHECK constraints.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `check-db-sidecars: ok (${expected.length} sidecar objects present — ` +
      `${expected.filter((e) => e.kind === "constraint").length} constraints, ` +
      `${expected.filter((e) => e.kind === "index").length} indexes, ` +
      `${expected.filter((e) => e.kind === "trigger").length} triggers)`,
  );
}

// Only run when invoked as a script. `stripSqlComments` is unit-tested, and a
// bare `main()` at module scope meant importing it opened a database connection
// and raced the test runner's teardown.
if (process.argv[1] && /check-db-sidecars/.test(process.argv[1])) {
  main()
    .catch((err) => {
      console.error("check-db-sidecars: fatal", err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
