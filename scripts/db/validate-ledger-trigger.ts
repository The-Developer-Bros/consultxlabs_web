/**
 * #776 — validate the ledger-balance CONSTRAINT TRIGGER (prisma/sql/ledger-triggers.sql).
 *
 * Run AFTER `npm run db:triggers`:
 *   npx tsx -r dotenv/config scripts/db/validate-ledger-trigger.ts
 *
 * Asserts:
 *   1. A balanced posting (via postLedgerTxn) COMMITS.
 *   2. A directly-inserted UNBALANCED transaction is REJECTED at COMMIT by the
 *      deferred trigger (bypasses postLedgerTxn's app-level assertion on purpose).
 *
 * Exit 0 = trigger behaves correctly; non-zero = trigger missing/incorrect.
 */
import prisma from "../../lib/prisma";
import { postLedgerTxn } from "../../lib/payments/ledger/post";

async function main(): Promise<void> {
  const stamp = `${Date.now()}`;
  let ok = true;

  // --- 1. Balanced posting via the real path must COMMIT.
  try {
    await prisma.$transaction(async (tx) => {
      await postLedgerTxn(tx, {
        idempotencyKey: `trigger-validate-balanced:${stamp}`,
        kind: "BOOKING",
        postings: [
          { account: { kind: "CASH" }, direction: "DEBIT", amountPaise: 100 },
          { account: { kind: "PLATFORM_FEE" }, direction: "CREDIT", amountPaise: 100 },
        ],
      });
    });
    console.log("✅ balanced posting committed (trigger allows balanced txns)");
  } catch (err) {
    ok = false;
    console.error(
      "❌ balanced posting was REJECTED — trigger is too strict:",
      err instanceof Error ? err.message : err,
    );
  }

  // --- 2. Directly-inserted UNBALANCED transaction must be REJECTED at COMMIT.
  // Bypass postLedgerTxn (which would assert before any write). Ensure the two
  // accounts exist, then create a transaction whose entries don't net to zero.
  const cashId = "CASH|_|_|INR";
  const feeId = "PLATFORM_FEE|_|_|INR";
  for (const [id, kind] of [
    [cashId, "CASH"],
    [feeId, "PLATFORM_FEE"],
  ] as const) {
    await prisma.ledgerAccount.upsert({
      where: { id },
      create: { id, kind, currency: "INR" },
      update: {},
    });
  }

  let rejected = false;
  try {
    await prisma.ledgerTransaction.create({
      data: {
        idempotencyKey: `trigger-validate-unbalanced:${stamp}`,
        kind: "BOOKING",
        entries: {
          create: [
            { accountId: cashId, direction: "DEBIT", amountPaise: BigInt(100) },
            { accountId: feeId, direction: "CREDIT", amountPaise: BigInt(50) },
          ],
        },
      },
    });
  } catch (err) {
    rejected = true;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `✅ unbalanced posting was REJECTED at COMMIT (trigger fired): ${msg.split("\n")[0]}`,
    );
  }
  if (!rejected) {
    ok = false;
    console.error(
      "❌ unbalanced posting COMMITTED — the trigger is NOT installed/working. " +
        "Run `npm run db:triggers`.",
    );
    // Clean up the bad row so it doesn't poison reconcile.
    await prisma.ledgerTransaction.deleteMany({
      where: { idempotencyKey: `trigger-validate-unbalanced:${stamp}` },
    });
  }

  await prisma.$disconnect();
  if (!ok) process.exit(1);
  console.log("\n🎉 Ledger balance trigger validated.");
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
