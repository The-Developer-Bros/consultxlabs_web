/**
 * #676 A1–A4 — apply booking/payment CHECK constraints (prisma/sql/check-constraints.sql).
 *
 * `prisma db push` / `prisma migrate` do NOT manage these, so this must run
 * after every push/reset (same sidecar pattern as apply-ledger-triggers.ts).
 * Idempotent (DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT).
 *
 * Usage: `npm run db:constraints`            — apply
 *        `npm run db:constraints -- --dry-run` — print statements only
 */
import { readFileSync } from "fs";
import { join } from "path";

import prisma from "../../lib/prisma";
import { splitSqlStatements } from "./sql-chunks";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const sqlPath = join(process.cwd(), "prisma", "sql", "check-constraints.sql");
  const raw = readFileSync(sqlPath, "utf8");

  const statements = splitSqlStatements(raw);

  for (const stmt of statements) {
    if (dryRun) {
      console.log(stmt.replace(/^(--.*\n)+/, "").trim());
      continue;
    }
    await prisma.$executeRawUnsafe(stmt);
  }

  console.log(
    dryRun
      ? `🔎 Dry run: ${statements.length} statements from ${sqlPath} (nothing executed)`
      : `✅ Applied CHECK constraints (${statements.length} statements) from ${sqlPath}`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error("❌ Failed to apply CHECK constraints:", err);
    return prisma.$disconnect().finally(() => process.exit(1));
  });
