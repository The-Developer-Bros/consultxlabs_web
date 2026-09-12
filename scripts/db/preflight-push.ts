/**
 * Refuse a destructive `prisma db push` before it touches the database.
 *
 * One Postgres project serves development AND production here, and eleven
 * worktrees symlink the same `.env`. Ten of them sit on schemas that predate the
 * newest columns, so `npm run db:push` from any of those proposes to DROP them —
 * and it has already happened once: #1268's push was reverted by a sibling
 * branch and had to be redone by hand.
 *
 * Prisma's own data-loss prompt is not the guard people assume it is. The engine
 * counts NON-NULL values, so dropping a column that is NULL on every row raises
 * no warning at all and needs no `--accept-data-loss`. And neither
 * `DROP INDEX` nor `ALTER INDEX … RENAME TO` warns under any circumstance —
 * which is exactly the shape of the trap that transplanted a partial index's
 * `WHERE` clause onto a unique constraint the schema read as total.
 *
 * So this reads the plan Prisma is about to apply and exits non-zero on any
 * statement that destroys or re-points an existing object. `db:push:schema`
 * chains it ahead of the push, so the refusal happens before the connection is
 * used for DDL — on whatever branch you happen to be standing on, whether or
 * not CI ran, and whether or not Prisma would have prompted.
 *
 * Additive plans pass silently. Nothing here can make a safe push fail.
 *
 * It is a heuristic over Prisma's SQL text, not a proof. It does NOT catch a
 * column type narrowing (`ALTER COLUMN … SET DATA TYPE`), `SET NOT NULL`, a
 * primary-key `DROP CONSTRAINT`, or the drop of a hand-applied partial index
 * whose name does not end in `_key`; and `npx prisma db push` run directly never
 * executes it. Read the `--print` plan when a change is not plainly additive.
 *
 * Usage: `npm run db:preflight`            — gate (exit 1 on a destructive plan)
 *        `npm run db:preflight -- --print` — print the plan and exit 0
 *
 * Skips cleanly (exit 0) when DATABASE_URL is absent, like every other guard.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const SCHEMA = path.join(ROOT, "prisma", "schema.prisma");
const KNOWN_DRIFT = path.join(ROOT, "prisma", "sql", "known-drift.json");

type AllowedEntry = {
  statement: string;
  reason: string;
  trackedBy: string;
  expires: string;
};

/**
 * Every pattern here removes or re-points something that already exists.
 *
 * `ALTER INDEX … RENAME TO` earns its place despite destroying nothing: it is
 * how Prisma "reconciles" a hand-applied partial index whose column tuple it
 * recognises, silently narrowing a constraint the schema declares as total. That
 * is the #1268 trap, and a drop-only gate would wave it through.
 *
 * `DROP CONSTRAINT` is matched only for foreign keys. The sidecar files
 * legitimately drop and re-add their own CHECK constraints on every run, and
 * gating those would refuse every sidecar apply.
 */
/** Collapse whitespace and drop a trailing `;`, so an allowlist entry can be
 *  pasted from `migrate diff --script` verbatim while the plan is split on `;`. */
export const normalise = (s: string) =>
  s.replace(/\s+/g, " ").trim().replace(/;$/, "").trim();

export const DESTRUCTIVE: {
  label: string;
  re?: RegExp;
  /** Matched against Prisma's own `-- Xxx` operation marker, for statements whose
   *  text is not reliably recognisable. */
  marker?: RegExp;
}[] = [
  { label: "DROP COLUMN", re: /\bDROP\s+COLUMN\b/i },
  { label: "DROP TABLE", re: /\bDROP\s+TABLE\b/i },
  { label: "index rename", re: /\bALTER\s+INDEX\b[\s\S]*\bRENAME\s+TO\b/i },
  {
    // Keyed off the OPERATION, not off the name. `_fkey` is only Prisma's default
    // convention: `@relation(map: "…")` names the constraint whatever it likes, and
    // a suffix match waved those drops through — on a gate whose entire job is
    // catching a re-pointed relation. The suffix test stays as a fallback for a
    // plan that arrives without markers.
    label: "DROP a foreign key",
    re: /\bDROP\s+CONSTRAINT\b[^;]*_fkey/i,
    marker: /^DropForeignKey$/i,
  },
  // Dropping a type takes every column typed by it with it.
  { label: "DROP TYPE", re: /\bDROP\s+TYPE\b/i },
  // Only UNIQUE index drops. Prisma names those `*_key` and plain indexes
  // `*_idx`, and replacing an ordinary index is routine — gating it would refuse
  // every legitimate composite change. Dropping a unique is different in kind:
  // it removes an invariant, and it is half of how a partial index gets
  // transplanted onto a constraint the schema reads as total.
  { label: "DROP a unique index", re: /\bDROP\s+INDEX\b[^;]*_key\b/i },
];

/** The gate itself, exported so it can be pinned against a real plan. */
export function findDestructive(
  plan: string,
): { statement: string; label: string }[] {
  const out: { statement: string; label: string }[] = [];
  for (const { marker, statement } of planEntries(plan)) {
    const hit = DESTRUCTIVE.find(
      (d) =>
        (d.re?.test(statement) ?? false) ||
        (d.marker !== undefined && marker !== null && d.marker.test(marker)),
    );
    if (hit) out.push({ statement: normalise(statement), label: hit.label });
  }
  return out;
}

/** One planned statement, with the `-- Xxx` operation marker Prisma writes above
 *  it. The marker is the only part of the plan that names the OPERATION rather
 *  than describing the object, so anything the object's name cannot be trusted for
 *  is decided from here. */
export type PlanEntry = { marker: string | null; statement: string };

/** Prisma emits one statement per `;`, each preceded by a `-- comment` line. */
export function planEntries(plan: string): PlanEntry[] {
  return plan
    .split(";")
    .map((chunk) => ({
      marker: /^[ \t]*--[ \t]*(\S.*)$/m.exec(chunk)?.[1]?.trim() ?? null,
      statement: chunk.replace(/^[ \t]*(--[^\n]*\n)+/gm, "").trim(),
    }))
    .filter((e) => e.statement.length > 0 && !e.statement.startsWith("--"));
}

export function planStatements(plan: string): string[] {
  return planEntries(plan).map((e) => e.statement);
}

function allowlist(): AllowedEntry[] {
  if (!fs.existsSync(KNOWN_DRIFT)) return [];
  const parsed: unknown = JSON.parse(fs.readFileSync(KNOWN_DRIFT, "utf8"));
  const raw = (parsed as Record<string, unknown>).destructiveStatementsAllowed;
  return Array.isArray(raw) ? (raw as AllowedEntry[]) : [];
}

function main(): void {
  if (!process.env.DATABASE_URL) {
    console.log("db:preflight: DATABASE_URL unset — skipping");
    return;
  }

  // The project's OWN Prisma binary, by absolute path — not `npx prisma`.
  //
  // Two reasons, and they point the same way. Resolving a bare command name goes
  // through `PATH`, so what runs depends on the environment rather than on the
  // repository, which is what Sonar's S4036 is about. And this guard exists to
  // decide whether a DDL plan is safe to apply, so it had better be computed by
  // the same Prisma version the push will use, not by whichever one is first on
  // the path.
  const PRISMA_BIN = path.join(ROOT, "node_modules", ".bin", "prisma");
  if (!fs.existsSync(PRISMA_BIN)) {
    console.error(
      `db:preflight: cannot find ${PRISMA_BIN}. Run \`npm ci\` before pushing.`,
    );
    process.exit(1);
  }

  let plan: string;
  try {
    plan = execFileSync(
      PRISMA_BIN,
      [
        "migrate",
        "diff",
        "--from-config-datasource",
        "--to-schema",
        SCHEMA,
        "--script",
      ],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    // A diff that cannot run is not a pass. Refusing here is the whole point:
    // an unreadable plan is the one case where pushing blind is worst.
    console.error("db:preflight: could not compute the migration plan.");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const statements = planStatements(plan);

  if (statements.length === 0) {
    console.log(
      "db:preflight: nothing to apply — the database matches the schema.",
    );
    return;
  }

  const allowed = allowlist();
  const now = new Date();
  const offences: { statement: string; label: string }[] = [];

  for (const { statement, label } of findDestructive(plan)) {
    const entry = allowed.find(
      (a) => normalise(a.statement) === normalise(statement),
    );
    // An expired entry is not an entry. An allowlist without a live expiry is a
    // permanently disabled check, which is how the ledger reconciler ended up
    // ignored — known-drift.json says so itself.
    if (entry && new Date(entry.expires) > now) {
      console.log(
        `db:preflight: allowed (${entry.trackedBy}, expires ${entry.expires}) — ${statement}`,
      );
      continue;
    }
    if (entry) {
      console.error(
        `db:preflight: allowlist entry for this statement EXPIRED on ${entry.expires} (${entry.trackedBy}).`,
      );
    }
    offences.push({ statement, label });
  }

  console.log(`db:preflight: ${statements.length} statement(s) planned:`);
  for (const s of statements) console.log(`  ${normalise(s)}`);

  // The docblock had promised `--print` since this file was written and `main()`
  // never read `process.argv`, so the one way to see a plan was to run the gate
  // and have it exit 1 at you. Reading a destructive plan is exactly when you most
  // want to look without failing.
  if (process.argv.includes("--print")) {
    for (const o of offences) console.log(`  (destructive) ${o.label}`);
    console.log("db:preflight: --print — plan only, nothing gated.");
    return;
  }

  if (offences.length === 0) {
    console.log("db:preflight: additive — safe to push.");
    return;
  }

  console.error(
    `\ndb:preflight: REFUSING — ${offences.length} destructive statement(s) in the plan.\n`,
  );
  for (const o of offences) {
    console.error(`  ✗ ${o.label}: ${o.statement}`);
  }
  console.error(
    [
      "",
      "This is almost always the wrong branch, not a wanted change. Check:",
      "  git branch --show-current",
      "",
      "One database serves dev and prod, and every worktree shares one .env, so a",
      "push from a branch that predates a column proposes to drop it. If the drop",
      "IS intended — a pre-MVP reset step — add the exact statement to",
      "prisma/sql/known-drift.json under `destructiveStatementsAllowed` with an",
      "owner, a reason, an issue and an expiry.",
    ].join("\n"),
  );
  process.exit(1);
}

// Only as a CLI. `require.main` is undefined when jest imports this for the
// pattern pin, and running a database guard from a test would be worse than
// leaving it untested.
if (require.main === module) main();
