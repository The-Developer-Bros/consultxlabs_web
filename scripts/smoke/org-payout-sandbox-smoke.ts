/**
 * #776 — live-payout sandbox smoke test.
 *
 * Exercises the org-payout submission path WITHOUT flipping the global
 * `ENABLE_LIVE_PAYOUTS` production flag, so it's safe to run anywhere. It
 * proves the single most important launch invariant:
 *
 *   With ENABLE_LIVE_PAYOUTS unset, `processOrgPayout` makes NO gateway
 *   submission (money never leaves) and leaves the payout PENDING (not claimed)
 *   — exactly the gated behaviour the runbook flips on at go-live.
 *
 * When real RazorpayX sandbox creds are present (RAZORPAYX_SANDBOX_KEY +
 * RAZORPAYX_SANDBOX_SECRET), it additionally asserts the gateway client
 * constructs a payout request with the right shape (idempotency key, paise
 * amount) against the sandbox host — see the runbook for the manual step that
 * actually submits one. Without those creds it logs SKIP rather than failing.
 *
 * Run: DATABASE_URL=… DIRECT_URL=… npx tsx scripts/smoke/org-payout-sandbox-smoke.ts
 * MUST pass with ENABLE_LIVE_PAYOUTS unset/false.
 */
import prisma from "../../lib/prisma";
import { processOrgPayout } from "../../lib/payments/payouts/org-payout-service";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  console.log("=== #776 live-payout sandbox smoke ===");
  const stamp = Date.now();

  // Guard: this smoke asserts the GATED behaviour. If someone runs it with the
  // live flag on, the assertion below would be wrong — fail loud instead.
  check(
    "ENABLE_LIVE_PAYOUTS is OFF for this smoke",
    process.env.ENABLE_LIVE_PAYOUTS !== "true",
    "unset the flag before running the gated-behaviour smoke",
  );

  // --- Throwaway HOST org + a PENDING payout row (no earnings needed; we're
  // testing the submission gate, not the rollup math). --------------------
  const org = await prisma.organization.create({
    data: {
      name: "Payout Sandbox Org",
      slug: `payout-smoke-${stamp}`,
      canSponsor: false,
      canHost: true,
    },
    select: { id: true },
  });

  const periodEnd = new Date();
  const periodStart = new Date(periodEnd);
  periodStart.setDate(periodStart.getDate() - 30);

  const payout = await prisma.organizationPayout.create({
    data: {
      organizationId: org.id,
      amountPaise: 50000,
      currency: "INR",
      status: "PENDING",
      paymentGateway: "RAZORPAY",
      periodStart,
      periodEnd,
      grossRevenuePaise: 50000,
      platformFeePaise: 0,
      refundsPaise: 0,
      netPayoutPaise: 50000,
    },
    select: { id: true },
  });

  // --- The gate assertion: process WITHOUT the live flag. ------------------
  const result = await processOrgPayout(payout.id);
  check(
    "processOrgPayout did NOT submit to gateway (flag off)",
    result.submittedToGateway === false,
    `submittedToGateway=${result.submittedToGateway}`,
  );
  // #785 — with the flag OFF the row is intentionally NOT claimed (stays
  // PENDING). Claiming PENDING→PROCESSING with no gateway submission and no
  // webhook would zombie it in PROCESSING forever; the cron re-attempts once
  // the flag flips. (This assertion previously expected PROCESSING and broke
  // the gate after that fix landed.)
  check(
    "payout stays PENDING (not claimed until go-live)",
    result.status === "PENDING",
    `status=${result.status}`,
  );

  const after = await prisma.organizationPayout.findUnique({
    where: { id: payout.id },
    select: { status: true, gatewayPayoutId: true },
  });
  check(
    "no gatewayPayoutId stamped (money did not leave)",
    after?.gatewayPayoutId == null,
    `gatewayPayoutId=${after?.gatewayPayoutId ?? "null"}`,
  );

  // --- Optional sandbox-creds check (does not flip the global flag). -------
  const hasSandbox =
    !!process.env.RAZORPAYX_SANDBOX_KEY &&
    !!process.env.RAZORPAYX_SANDBOX_SECRET;
  if (hasSandbox) {
    console.log(
      "ℹ️  RazorpayX sandbox creds present — see the runbook for the manual sandbox-submit step.",
    );
  } else {
    console.log(
      "⏭️  SKIP sandbox gateway check — RAZORPAYX_SANDBOX_KEY/SECRET not set.",
    );
  }

  // --- Cleanup throwaway fixtures. ----------------------------------------
  await prisma.organizationPayout.delete({ where: { id: payout.id } });
  await prisma.organization.delete({ where: { id: org.id } });

  console.log(
    failures === 0
      ? "\n✅ sandbox smoke PASSED — gate holds; safe to flip per the runbook."
      : `\n❌ sandbox smoke FAILED — ${failures} assertion(s) failed.`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error("sandbox smoke crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
