/**
 * CI guard — the live database's enum types must match prisma/schema.prisma.
 *
 * Prisma's generated client encodes the schema's enum labels. When the database
 * carries a label the client does not know, any read of a column typed by that
 * enum fails with P2023 ("Value 'X' not found in enum") — even when no row uses
 * the stale label. That is a whole-endpoint outage triggered by a catalog
 * mismatch, and it is invisible until something reads the column.
 *
 * It has already happened here: commit 183d0e72 dropped LEMON_SQUEEZY and XFLOW
 * from PaymentGateway, `db push` could not remove them from the live type
 * (Postgres has no ALTER TYPE ... DROP VALUE), and reconcile-disputes plus
 * cleanup-abandoned-payments were red for weeks with nobody paged.
 *
 * Drift in the other direction — a label in the schema that the database lacks —
 * is just as bad and fails on write instead of read, so both directions are
 * checked.
 *
 * Known, tracked drift lives in prisma/sql/known-drift.json with an expiry date.
 *
 * Skips cleanly (exit 0) when DATABASE_URL is absent.
 */
// Without this the script reads a bare process.env, finds no DATABASE_URL, and
// self-skips with exit 0 — which is how this guard reported success on every CI
// run while never once executing. CI writes the secret to .env as a FILE; only
// Next loads that implicitly. Every other DB-touching script here does the same.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import prisma from "../../lib/prisma";

const ROOT = path.join(__dirname, "..", "..");
const SCHEMA = path.join(ROOT, "prisma", "schema.prisma");
const KNOWN_DRIFT = path.join(ROOT, "prisma", "sql", "known-drift.json");

type KnownEntry = {
  enum: string;
  labels: string[];
  reason: string;
  trackedBy: string;
  expires: string;
};

function schemaEnums(): Map<string, string[]> {
  const text = fs.readFileSync(SCHEMA, "utf8");
  const out = new Map<string, string[]>();
  for (const m of text.matchAll(/^enum\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const labels = m[2]
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, "").trim())
      .filter((l) => l.length > 0 && !l.startsWith("@@"));
    out.set(m[1], labels);
  }
  return out;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("check-db-drift: DATABASE_URL unset — skipping");
    return;
  }

  const known: KnownEntry[] = JSON.parse(
    fs.readFileSync(KNOWN_DRIFT, "utf8"),
  ).enumLabelsInDbNotInSchema;

  // `now` is only used to expire allowlist entries; a stale allowlist must not
  // outlive its own deadline.
  const today = new Date().toISOString().slice(0, 10);

  const rows = await prisma.$queryRaw<{ enum_name: string; labels: string }[]>`
    SELECT t.typname AS enum_name,
           string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace AND n.nspname = 'public'
     GROUP BY t.typname
  `;
  const live = new Map(rows.map((r) => [r.enum_name, r.labels.split(",")]));
  const declared = schemaEnums();

  const errors: string[] = [];
  const tolerated: string[] = [];

  for (const [name, schemaLabels] of declared) {
    const liveLabels = live.get(name);
    if (!liveLabels) {
      // Not every schema enum is materialised as a Postgres type (unused ones
      // may not be), so absence alone is not drift.
      continue;
    }

    const dbOnly = liveLabels.filter((l) => !schemaLabels.includes(l));
    const schemaOnly = schemaLabels.filter((l) => !liveLabels.includes(l));

    if (dbOnly.length > 0) {
      const entry = known.find((k) => k.enum === name);
      const covered =
        entry && dbOnly.every((l) => entry.labels.includes(l)) ? entry : null;
      if (covered && covered.expires >= today) {
        tolerated.push(
          `${name}: db-only ${dbOnly.join(", ")} — known drift, tracked by ${covered.trackedBy}, expires ${covered.expires}`,
        );
      } else if (covered) {
        errors.push(
          `${name}: db-only label(s) ${dbOnly.join(", ")} — the allowlist entry EXPIRED on ${covered.expires} (tracked by ${covered.trackedBy}). Either land the fix or re-review the entry.`,
        );
      } else {
        errors.push(
          `${name}: database has label(s) the schema does not: ${dbOnly.join(", ")}. ` +
            `Every read of a column typed \`${name}\` will fail with Prisma P2023. ` +
            `Postgres cannot DROP an enum value, so fixing this means creating a replacement ` +
            `type and swapping the columns over.`,
        );
      }
    }

    if (schemaOnly.length > 0) {
      errors.push(
        `${name}: schema has label(s) the database does not: ${schemaOnly.join(", ")}. ` +
          `Any write using one will fail. Run \`npm run db:push\`.`,
      );
    }
  }

  for (const t of tolerated) console.log(`  tolerated ${t}`);

  if (errors.length > 0) {
    console.error(
      `\ncheck-db-drift: FAILED — ${errors.length} enum drift(s):\n`,
    );
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      `\nIf the drift is deliberate and tracked, add it to prisma/sql/known-drift.json ` +
        `with a reason, a tracking reference, and an expiry date.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `check-db-drift: ok (${declared.size} schema enums checked against ${live.size} live types, ` +
      `${tolerated.length} tolerated)`,
  );
}

main()
  .catch((err) => {
    console.error("check-db-drift: fatal", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
