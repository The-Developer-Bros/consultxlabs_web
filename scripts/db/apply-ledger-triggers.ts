/**
 * #776 — apply the ledger balance CONSTRAINT TRIGGER (prisma/sql/ledger-triggers.sql).
 *
 * `prisma db push` / `prisma migrate` do NOT manage triggers, so this must run
 * after every push/reset. Idempotent (DROP TRIGGER IF EXISTS + CREATE OR REPLACE).
 *
 * Usage: `npm run db:triggers`  (or `npx tsx -r dotenv/config scripts/db/apply-ledger-triggers.ts`)
 */
import { readFileSync } from "fs";
import { join } from "path";

import prisma from "../../lib/prisma";
import { splitSqlStatements } from "./sql-chunks";

async function main(): Promise<void> {
  const sqlPath = join(process.cwd(), "prisma", "sql", "ledger-triggers.sql");
  const raw = readFileSync(sqlPath, "utf8");

  const statements = splitSqlStatements(raw);

  for (const stmt of statements) {
    await prisma.$executeRawUnsafe(stmt);
  }

  console.log(
    `✅ Applied ledger balance trigger (${statements.length} statements) from ${sqlPath}`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error("❌ Failed to apply ledger triggers:", err);
    return prisma.$disconnect().finally(() => process.exit(1));
  });
