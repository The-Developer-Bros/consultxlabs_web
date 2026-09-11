/**
 * #771 — double-entry ledger smoke test.
 *
 * Unlike the bulk seed (which inserts balances/counters directly and never
 * touches `postLedgerTxn`), this drives REAL money flows through the live
 * ledger code paths, then runs reconcile and asserts:
 *   - the top-up posts a balanced Dr CASH / Cr WALLET, and the fresh org's
 *     `walletBalance` cache == the derived ledger WALLET balance,
 *   - completing a payout posts a balanced Dr CONSULTANT_PAYABLE / Cr CASH (+TDS),
 *   - reconcile reports ZERO `LEDGER_TXN_IMBALANCE` (the real AF-4 gate).
 *
 * Run: DATABASE_URL=… DIRECT_URL=… npx tsx scripts/smoke/ledger-smoke.ts
 * Read-/write-light: creates one throwaway org + wallet top-up; payout uses a
 * seeded PROCESSING payout if present.
 */
import prisma from "../../lib/prisma";
import { initiateTopUp, confirmTopUp } from "../../lib/api/organizations/wallet";
import { handlePayoutWebhook } from "../../lib/payments/payouts";
import { runReconcileLedgers } from "../reconcile/reconcile-ledgers";
import { ledgerBalancePaise } from "../../lib/payments/ledger/post";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  console.log("=== #771 ledger smoke test ===");
  const stamp = Date.now();

  // --- 1. Fresh org + WALLET billing account (isolated from seed data) -------
  const org = await prisma.organization.create({
    data: {
      name: "Ledger Smoke Org",
      slug: `smoke-${stamp}`,
      canSponsor: true,
      canHost: false,
    },
    select: { id: true },
  });
  const ba = await prisma.billingAccount.create({
    data: {
      ownerOrgId: org.id,
      currency: "INR",
      fundingSource: "WALLET",
      walletBalance: 0,
      billingEmail: `smoke-${stamp}@example.com`,
    },
    select: { id: true },
  });

  // --- 2. TOP-UP via the live path → Dr CASH / Cr WALLET ---------------------
  const orderId = `smoke-topup-${stamp}`;
  await initiateTopUp(prisma, {
    billingAccountId: ba.id,
    amountPaise: 100000,
    providerOrderId: orderId,
  });
  await confirmTopUp(prisma, {
    providerOrderId: orderId,
    providerPaymentId: `smoke-pay-${stamp}`,
    amountPaise: 100000,
  });

  const baAfter = await prisma.billingAccount.findUniqueOrThrow({
    where: { id: ba.id },
    select: { walletBalance: true },
  });
  // WALLET is credit-normal: amount owed to the org = Σcredit − Σdebit = −signed.
  const walletSigned = await ledgerBalancePaise(prisma, {
    kind: "WALLET",
    organizationId: org.id,
  });
  const owedByLedger = -walletSigned;
  check(
    "top-up: walletBalance cache == 100000",
    baAfter.walletBalance === 100000,
    `got ${baAfter.walletBalance}`,
  );
  check(
    "top-up: derived ledger WALLET balance == 100000",
    owedByLedger === 100000,
    `got ${owedByLedger}`,
  );
  check(
    "top-up: cache == ledger (fresh org reconciles)",
    baAfter.walletBalance === owedByLedger,
  );

  // --- 3. PAYOUT completion via the live path → Dr CONSULTANT_PAYABLE / Cr CASH (+TDS)
  const payout = await prisma.consultantPayout.findFirst({
    where: { status: "PROCESSING", providerPayoutId: { not: null } },
    select: { id: true, providerPayoutId: true },
  });
  if (payout?.providerPayoutId) {
    // handlePayoutWebhook ignores its first arg (the lookup is by
    // providerPayoutId); pass any valid PaymentGateway literal.
    await handlePayoutWebhook("RAZORPAY", payout.providerPayoutId, "COMPLETED");
    const after = await prisma.consultantPayout.findUniqueOrThrow({
      where: { id: payout.id },
      select: { status: true },
    });
    check("payout: transitioned PROCESSING → COMPLETED", after.status === "COMPLETED");
    const txn = await prisma.ledgerTransaction.findUnique({
      where: { idempotencyKey: `payout:${payout.id}` },
      select: { id: true },
    });
    check("payout: balanced ledger txn posted", !!txn, `key payout:${payout.id}`);
  } else {
    console.log("ℹ️  no seeded PROCESSING payout with providerPayoutId — skipping payout leg");
  }

  // --- 4. RECONCILE — the real gate: zero double-entry imbalances ------------
  const report = await runReconcileLedgers({ scope: "full" });
  const imbalances = report.findings.filter(
    (f) => f.kind === "LEDGER_TXN_IMBALANCE",
  );
  check(
    "reconcile: 0 LEDGER_TXN_IMBALANCE findings",
    imbalances.length === 0,
    `found ${imbalances.length}`,
  );
  console.log(
    `   reconcile report ${report.id}: ok=${report.ok}, total findings=${report.summary.discrepanciesCount} (non-imbalance = seed-data drift)`,
  );
  if (imbalances.length) console.log(JSON.stringify(imbalances, null, 2));

  console.log(
    `\n=== smoke result: ${failures === 0 ? "PASS ✅" : `FAIL (${failures} check(s)) ❌`} ===`,
  );
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(1);
});
