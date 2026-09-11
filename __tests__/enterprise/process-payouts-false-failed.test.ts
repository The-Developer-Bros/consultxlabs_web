/**
 * @jest-environment node
 */

/**
 * #785 (task #24) — false-FAILED payout guard, retargeted from the deleted
 * scripts/payouts/process-payouts.ts onto the canonical payout service
 * (#850). If the gateway ALREADY accepted a payout (providerPayoutId set)
 * but a later DB write throws, marking the payout FAILED + unlinking its
 * earnings would re-batch them into a DOUBLE disbursement. The catch must
 * instead quarantine the row PROCESSING with earnings LINKED.
 *
 * Plus the #776 CAS claim the consolidation ported into the service: a
 * payout already claimed by a concurrent run must be skipped without ever
 * touching the gateway.
 */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantPayout: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    // #1020 — the disbursement dispute guard probes for live disputes.
    consultantEarnings: { updateMany: jest.fn(), findFirst: jest.fn().mockResolvedValue(null) },
    consultantTaxInfo: { findUnique: jest.fn().mockResolvedValue(null) },
  },
}));
// #1132 — the consultant rail is now gated on ENABLE_LIVE_PAYOUTS (ADR 11), the
// same freeze the org rail already had. These tests are about the false-FAILED
// guard and the CAS claim, both of which only run once the freeze is lifted, so
// the flag is forced on here. The freeze itself is asserted in
// __tests__/security/audit-1132-security.test.ts.
jest.mock("../../lib/feature-flags", () => ({
  ...jest.requireActual("../../lib/feature-flags"),
  ENABLE_LIVE_PAYOUTS: true,
}));
// #1132 — with ENABLE_LIVE_PAYOUTS forced on above, assertPayoutBalance stops
// short-circuiting and issues its own RazorpayX balance GET. That is a real
// behaviour change, but it is not what these tests assert (they check that the
// PAYOUT submission never reaches the gateway), and leaving it live would make
// the "fetch never called" assertion measure the wrong call.
jest.mock("../../lib/payments/payouts/balance-preflight", () => ({
  assertPayoutBalance: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock("../../lib/redis", () => ({
  acquireLock: jest.fn().mockResolvedValue("tok"),
  releaseLock: jest.fn().mockResolvedValue(undefined),
  // processApprovedPayouts now distinguishes "lock held by a concurrent run"
  // (a clean skip) from "Redis unreachable" (fail closed and page), per ADR
  // 13's degradation policy — acquireLock returns null for both. These tests
  // exercise the happy path, so Redis is present and healthy.
  isMockRedis: jest.fn().mockReturnValue(false),
  checkRedisHealth: jest.fn().mockResolvedValue(true),
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

import prisma from "../../lib/prisma";
import { processApprovedPayouts } from "../../lib/payments/payouts/payout-service";

const cp = (
  prisma as unknown as {
    consultantPayout: {
      findMany: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
    };
    consultantEarnings: { updateMany: jest.Mock };
  }
).consultantPayout;
const ce = (
  prisma as unknown as {
    consultantEarnings: { updateMany: jest.Mock; findFirst: jest.Mock };
  }
).consultantEarnings;

const APPROVED = {
  id: "po_1",
  consultantProfileId: "cprof_1",
  amount: 500000, // ₹5,000 — below the ₹50K FY threshold ⇒ zero TDS, gateway gets the full amount
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

const unlinkedEarnings = () =>
  ce.updateMany.mock.calls.some(
    ([arg]: [{ data?: { payoutId?: unknown } }]) =>
      arg?.data?.payoutId === null,
  );
const markedFailed = () =>
  cp.update.mock.calls.some(
    ([arg]: [{ data?: { status?: unknown } }]) =>
      arg?.data?.status === "FAILED",
  );

beforeEach(() => {
  jest.clearAllMocks();
  // #850 trap: the payout service reads RAZORPAYX_KEY_SECRET || RAZORPAY_SECRET
  // (razorpay-payouts.ts) — NOT RAZORPAY_KEY_SECRET. Both are set here exactly
  // like the workflow env so the config check passes for the same reason.
  process.env.RAZORPAY_KEY_ID = "k";
  process.env.RAZORPAY_KEY_SECRET = "s";
  process.env.RAZORPAY_SECRET = "s";
  process.env.RAZORPAYX_ACCOUNT_NUMBER = "acc";
  (global as unknown as { fetch: unknown }).fetch = jest
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ id: "pout_x" }) });
  (
    prisma as unknown as { consultantTaxInfo: { findUnique: jest.Mock } }
  ).consultantTaxInfo.findUnique.mockResolvedValue(null);
  cp.updateMany.mockResolvedValue({ count: 1 }); // CAS claim APPROVED→PROCESSING
  ce.updateMany.mockResolvedValue({ count: 0 });
});

describe("processApprovedPayouts — #785 false-FAILED guard (service path)", () => {
  it("gateway accepted + post-submit DB write fails → does NOT FAIL or unlink earnings (no double-pay)", async () => {
    cp.findMany.mockResolvedValue([APPROVED]);
    // the persist-after-gateway throws; the catch's re-persist succeeds.
    cp.update
      .mockRejectedValueOnce(new Error("DB write failed"))
      .mockResolvedValue({});

    const results = await processApprovedPayouts();

    expect(
      (global as unknown as { fetch: jest.Mock }).fetch,
    ).toHaveBeenCalled();
    // the double-pay vector — earnings must STAY linked.
    expect(unlinkedEarnings()).toBe(false);
    expect(markedFailed()).toBe(false);
    // quarantined PROCESSING with the gateway id so handle-stuck-payouts reconciles.
    const quarantined = cp.update.mock.calls.some(
      ([arg]: [{ data?: { providerPayoutId?: unknown; status?: unknown } }]) =>
        arg?.data?.providerPayoutId === "pout_x" &&
        arg?.data?.status === "PROCESSING",
    );
    expect(quarantined).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      payoutId: "po_1",
      success: false,
      providerPayoutId: "pout_x",
    });
  });

  it("genuine pre-gateway failure (gateway rejects) → FAILs + unlinks earnings", async () => {
    cp.findMany.mockResolvedValue([APPROVED]);
    cp.update.mockResolvedValue({});
    (global as unknown as { fetch: jest.Mock }).fetch.mockResolvedValue({
      ok: false,
      statusText: "Bad Request",
      json: async () => ({ error: { description: "bad fund account" } }),
    });

    await processApprovedPayouts();

    expect(markedFailed()).toBe(true);
    expect(unlinkedEarnings()).toBe(true);
  });

  it("#776 — CAS claim lost (count 0) → skipped:true and the gateway is NEVER called", async () => {
    cp.findMany.mockResolvedValue([APPROVED]);
    cp.updateMany.mockResolvedValue({ count: 0 }); // concurrent run won the claim

    const results = await processApprovedPayouts();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ payoutId: "po_1", skipped: true });
    expect(
      (global as unknown as { fetch: jest.Mock }).fetch,
    ).not.toHaveBeenCalled();
    expect(markedFailed()).toBe(false);
    expect(unlinkedEarnings()).toBe(false);
  });
});

/**
 * ADR 13's Redis degradation policy for money jobs: a HELD lock is a clean skip
 * (the holder is doing the work), but an UNREACHABLE Redis must fail closed and
 * page. `acquireLock` returns null for both, so before this guard existed a
 * Redis outage was indistinguishable from a concurrent run — payouts returned
 * `[]`, the job logged a warning, and disbursement froze silently for as long
 * as the outage lasted.
 */
describe("processApprovedPayouts — Redis degradation (ADR 13)", () => {
  it("throws (fail closed) when Redis is unreachable, rather than silently returning []", async () => {
    const redis = jest.requireMock("../../lib/redis");
    redis.checkRedisHealth.mockResolvedValueOnce(false);

    await expect(processApprovedPayouts()).rejects.toThrow(/process-payouts/);

    // Crucially: it must not have looked for work or touched the gateway.
    expect(cp.findMany).not.toHaveBeenCalled();
    expect(
      (global as unknown as { fetch: jest.Mock }).fetch,
    ).not.toHaveBeenCalled();
  });

  it("throws (fail closed) when Redis is not configured at all", async () => {
    const redis = jest.requireMock("../../lib/redis");
    redis.isMockRedis.mockReturnValueOnce(true);

    await expect(processApprovedPayouts()).rejects.toThrow(/process-payouts/);
    expect(cp.findMany).not.toHaveBeenCalled();
  });

  it("still treats a HELD lock as a clean skip, not a failure", async () => {
    const redis = jest.requireMock("../../lib/redis");
    redis.acquireLock.mockResolvedValueOnce(null); // another run holds it

    const results = await processApprovedPayouts();

    expect(results).toEqual([]);
    expect(cp.findMany).not.toHaveBeenCalled();
  });
});
