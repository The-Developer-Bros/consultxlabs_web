/**
 * @jest-environment node
 */

/**
 * #1020 — dispute guard at disbursement. A payout whose earnings sit on a
 * payment with a LIVE dispute must never reach the gateway: pre-claim reject
 * (consultant rail) / in-tx reject before the claim (org rail), with the
 * residual window backstopped by the LOST-handler clawback.
 *
 * Also pins the payment-legs sum trigger's sidecar wiring — the DB enforces
 * what checkPaymentLegsSumToAmount asserts in TS, and the CI sidecar checker
 * auto-discovers the file.
 */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantPayout: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    consultantEarnings: {
      updateMany: jest.fn(),
      findFirst: jest.fn(),
    },
    consultantTaxInfo: { findUnique: jest.fn().mockResolvedValue(null) },
  },
}));
jest.mock("../../lib/feature-flags", () => ({
  ...jest.requireActual("../../lib/feature-flags"),
  ENABLE_LIVE_PAYOUTS: true,
}));
jest.mock("../../lib/payments/payouts/balance-preflight", () => ({
  assertPayoutBalance: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock("../../lib/redis", () => ({
  acquireLock: jest.fn().mockResolvedValue("tok"),
  releaseLock: jest.fn().mockResolvedValue(undefined),
  isMockRedis: jest.fn().mockReturnValue(false),
  checkRedisHealth: jest.fn().mockResolvedValue(true),
  isRedisCircuitOpen: jest.fn().mockReturnValue(false),
}));
jest.mock("../../lib/payments/tax/tds-service", () => ({
  getCurrentFYCumulativePayments: jest.fn().mockResolvedValue(0),
  getFYDateRange: jest.fn(),
  getIndianFinancialYear: jest.fn().mockReturnValue("2026-27"),
  recordTDSDeduction: jest.fn(),
  TDS_THRESHOLD_PAISE: 5_000_000,
}));
jest.mock("../../lib/novu/service", () => ({
  notifyPayoutProcessed: jest.fn(),
}));

import { readFileSync } from "fs";
import path from "path";
import prisma from "../../lib/prisma";
import { processApprovedPayouts } from "../../lib/payments/payouts/payout-service";

/** The Prisma surface processApprovedPayouts touches in these tests. */
interface PayoutPrismaMock {
  consultantPayout: {
    findMany: jest.Mock;
    updateMany: jest.Mock;
    update: jest.Mock;
  };
  consultantEarnings: { updateMany: jest.Mock; findFirst: jest.Mock };
  consultantTaxInfo: { findUnique: jest.Mock };
}

// One seam over the generated client (repo-wide mock idiom): everything
// downstream reads the fully-typed PayoutPrismaMock.
const mocks = prisma as unknown as PayoutPrismaMock;

/** Swap the global fetch for a mock WITHOUT any-casting through globals. */
function stubGlobalFetch(mock: jest.Mock): void {
  Object.defineProperty(globalThis, "fetch", {
    value: mock,
    configurable: true,
    writable: true,
  });
}

const APPROVED = {
  id: "po_1",
  consultantProfileId: "cprof_1",
  amount: 500000,
  currency: "INR",
  provider: "RAZORPAY",
  method: "BANK_TRANSFER",
  idempotencyKey: null,
  retryCount: 0,
  consultantProfile: {
    payoutAccounts: [
      {
        razorpayFundAccId: "fa_x",
        stripeAccountId: null,
        accountType: "BANK_ACCOUNT",
      },
    ],
    user: { name: "Priya", email: "p@x.com" },
  },
};

let gatewayFetch: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.RAZORPAY_KEY_ID = "k";
  process.env.RAZORPAY_SECRET = "s";
  process.env.RAZORPAYX_KEY_SECRET = "x";
  process.env.RAZORPAYX_ACCOUNT_NUMBER = "acc";
  // Same env + fetch stub as process-payouts-false-failed.test.ts: the
  // RazorpayX client goes through global fetch.
  gatewayFetch = jest
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ id: "pout_x" }) });
  stubGlobalFetch(gatewayFetch);
  mocks.consultantTaxInfo.findUnique.mockResolvedValue(null);
  mocks.consultantPayout.updateMany.mockResolvedValue({ count: 1 });
  mocks.consultantEarnings.updateMany.mockResolvedValue({ count: 0 });
});

describe("consultant rail — live-dispute disbursement block (#1020)", () => {
  it("a disputed earning blocks submission BEFORE the CAS claim or any gateway call", async () => {
    mocks.consultantPayout.findMany.mockResolvedValue([APPROVED]);
    mocks.consultantEarnings.findFirst.mockResolvedValue({ id: "ce_1" });

    const results = await processApprovedPayouts();

    // Guard fires pre-claim: no APPROVED→PROCESSING write, no gateway fetch.
    expect(mocks.consultantEarnings.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ payoutId: "po_1" }),
      }),
    );
    expect(mocks.consultantPayout.updateMany).not.toHaveBeenCalled();
    expect(gatewayFetch).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ success: false, skipped: true });

    // Earnings stay linked + BATCHED — the dispute resolves first, then the
    // normal batch/release flow resumes.
    expect(mocks.consultantEarnings.updateMany).not.toHaveBeenCalled();
  });

  it("no live dispute → the normal claim + submit path runs", async () => {
    mocks.consultantPayout.findMany.mockResolvedValue([APPROVED]);
    mocks.consultantEarnings.findFirst.mockResolvedValue(null);

    await processApprovedPayouts();

    // Reached the claim (gateway call happens past it).
    expect(mocks.consultantPayout.updateMany).toHaveBeenCalled();
    expect(gatewayFetch).toHaveBeenCalled();
  });
});

describe("payment-legs sum trigger — sidecar wiring (source contract)", () => {
  const sqlPath = path.join(
    process.cwd(),
    "prisma",
    "sql",
    "payment-legs-triggers.sql",
  );

  it("the trigger exists, is deferred, and guards all three write shapes", () => {
    const sql = readFileSync(sqlPath, "utf8");
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER payment_legs_sum_to_amount/);
    expect(sql).toMatch(/DEFERRABLE INITIALLY DEFERRED/);
    expect(sql).toMatch(/AFTER INSERT OR UPDATE OR DELETE ON "PaymentLeg"/);
    // Funding-sum semantics mirror checkPaymentLegsSumToAmount: non-reversal
    // legs only.
    expect(sql).toMatch(/'_REVERSAL'/);
    // Reversal pair semantics: negative + capped by the sibling sum.
    expect(sql).toMatch(/amountPaise" >= 0/);
  });

  it("the apply script targets this file and is chained into db:sidecars", () => {
    const script = readFileSync(
      path.join(
        process.cwd(),
        "scripts",
        "db",
        "apply-payment-legs-triggers.ts",
      ),
      "utf8",
    );
    expect(script).toContain("payment-legs-triggers.sql");

    const pkg = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    );
    expect(pkg.scripts["db:leg-triggers"]).toContain(
      "apply-payment-legs-triggers.ts",
    );
    expect(pkg.scripts["db:sidecars"]).toContain("db:leg-triggers");

    // The CI sidecar checker (scripts/ci/check-db-sidecars.ts) auto-discovers
    // every prisma/sql/*.sql and parses trigger declarations into expected
    // live-catalog objects (line 57). The contract is canonical formatting —
    // verify ours matches the exact shape that regex is built for.
    const checker = readFileSync(
      // #1319 — the parser moved to the shared module both entry points use.
      path.join(process.cwd(), "scripts", "db", "sidecar-objects.ts"),
      "utf8",
    );
    expect(checker).toContain("TRIGGER\\s+(\\w+)"); // parser exists
    const sidecarSql = readFileSync(sqlPath, "utf8");
    const declared = sidecarSql.match(/CREATE CONSTRAINT TRIGGER (\w+)/);
    expect(declared).not.toBeNull();
    expect(declared![1]).toBe("payment_legs_sum_to_amount");
  });
});
