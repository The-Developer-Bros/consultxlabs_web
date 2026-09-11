/**
 * @jest-environment node
 */

/**
 * #692 referral correctness pins:
 *  - REF-2: a refund must not restore credit onto a credit that has since
 *    expired (resurrecting dead balance the expiry cron re-zeroes).
 *  - REF-3: reward qualification claims atomically — the qualification window
 *    is asserted in the updateMany WHERE, not as a separate app-side check.
 */

import { QUALIFICATION_WINDOW_DAYS } from "@/lib/referrals/constants";

// processQualifyingAction runs inside withSerializableRetry(() => prisma.$transaction()).
// Mock both so the body executes against a controllable fake tx.
const mockTx = {
  referral: {
    findUnique: jest.fn(),
    updateMany: jest.fn(),
    update: jest.fn(),
  },
  referralCredit: { create: jest.fn(), findMany: jest.fn() },
  referralCode: { update: jest.fn() },
  referralProgramConfig: { upsert: jest.fn(), update: jest.fn() },
  user: { findUnique: jest.fn() },
};

// #880 — default program config (active, unlimited budget, ₹300 ramp stage).
const THIS_MONTH = new Date().toISOString().slice(0, 7);
const activeConfig = (over: Record<string, unknown> = {}) => ({
  id: "singleton",
  isActive: true,
  monthlyBudgetPaise: null,
  currentPeriod: THIS_MONTH,
  currentMonthSpentPaise: 0,
  referrerRewardPaise: 30000,
  ...over,
});

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (fn: (tx: unknown) => unknown) => fn(mockTx),
  },
}));
jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => unknown) => fn(),
}));

import {
  reverseCreditsForPayment,
  processQualifyingAction,
} from "@/lib/referrals/service";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("REF-2 — reverseCreditsForPayment skips expired credits", () => {
  it("restores live credits and leaves expired ones untouched", async () => {
    const past = new Date(Date.now() - DAY_MS); // already expired
    const future = new Date(Date.now() + 30 * DAY_MS); // still valid

    const tx = {
      referralCreditUsage: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "use-expired",
            creditId: "credit-expired",
            amount: 500,
            originalAmount: 500,
            restoredAmount: 0,
            credit: { expiresAt: past },
          },
          {
            id: "use-live",
            creditId: "credit-live",
            amount: 300,
            originalAmount: 300,
            restoredAmount: 0,
            credit: { expiresAt: future },
          },
        ]),
        delete: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      referralCredit: { update: jest.fn().mockResolvedValue({}) },
    };

    // Full refund (no refundAmount) → restore everything still live.
    const restored = await reverseCreditsForPayment("pay-1", tx as never);

    expect(restored).toBe(300); // only the live credit
    expect(tx.referralCredit.update).toHaveBeenCalledTimes(1);
    expect(tx.referralCredit.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "credit-live" } }),
    );
    // The expired credit must never be incremented back to life.
    expect(tx.referralCredit.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "credit-expired" } }),
    );
    expect(tx.referralCreditUsage.delete).toHaveBeenCalledWith({
      where: { id: "use-live" },
    });
  });

  it("treats null expiresAt as never-expiring (restores it)", async () => {
    const tx = {
      referralCreditUsage: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "use-1",
            creditId: "credit-1",
            amount: 200,
            originalAmount: 200,
            restoredAmount: 0,
            credit: { expiresAt: null },
          },
        ]),
        delete: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      referralCredit: { update: jest.fn().mockResolvedValue({}) },
    };

    const restored = await reverseCreditsForPayment("pay-2", tx as never);
    expect(restored).toBe(200);
    expect(tx.referralCredit.update).toHaveBeenCalledTimes(1);
  });
});

describe("REF-3 — processQualifyingAction claims reward atomically", () => {
  beforeEach(() => {
    mockTx.referral.findUnique.mockReset();
    mockTx.referral.updateMany.mockReset();
    mockTx.referral.update.mockReset();
    mockTx.referralCredit.create.mockReset();
    mockTx.referralCredit.findMany.mockReset().mockResolvedValue([]);
    mockTx.referralCode.update.mockReset();
    mockTx.referralProgramConfig.upsert
      .mockReset()
      .mockResolvedValue(activeConfig());
    mockTx.referralProgramConfig.update.mockReset();
    mockTx.user.findUnique.mockReset().mockResolvedValue({ role: "CONSULTEE" });
  });

  const signedUpReferral = {
    id: "ref-1",
    status: "SIGNED_UP",
    signedUpAt: new Date(),
    referralCodeId: "code-1",
    referredUserId: "referee-1",
    referrerRewardAmount: 50000,
    refereeRewardAmount: 20000,
    referralCode: { userId: "referrer-1" },
  };

  it("rewards via a WHERE that asserts status + window, then issues both bonuses", async () => {
    mockTx.referral.findUnique.mockResolvedValue(signedUpReferral);
    mockTx.referral.updateMany.mockResolvedValue({ count: 1 });

    await processQualifyingAction("referee-1", "first_paid_booking");

    expect(mockTx.referral.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "ref-1",
          status: "SIGNED_UP",
          signedUpAt: expect.objectContaining({ gte: expect.any(Date) }),
        }),
        data: expect.objectContaining({ status: "REWARDED" }),
      }),
    );
    // Referrer + referee bonuses both created.
    expect(mockTx.referralCredit.create).toHaveBeenCalledTimes(2);
  });

  it("expires (status+window guard) and pays nothing when the claim matches no row", async () => {
    mockTx.referral.findUnique.mockResolvedValue({
      ...signedUpReferral,
      signedUpAt: new Date(Date.now() - (QUALIFICATION_WINDOW_DAYS + 5) * DAY_MS),
    });
    // Reward claim matches nothing (past window); expire claim flips one row.
    mockTx.referral.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await processQualifyingAction("referee-1", "first_paid_booking");

    // Second updateMany is the expire path, guarded on a past-window SIGNED_UP row.
    expect(mockTx.referral.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          status: "SIGNED_UP",
          signedUpAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
        data: { status: "EXPIRED" },
      }),
    );
    expect(mockTx.referralCredit.create).not.toHaveBeenCalled();
  });
});

describe("#880 — role weighting, caps and program budget", () => {
  beforeEach(() => {
    mockTx.referral.findUnique.mockReset();
    mockTx.referral.updateMany.mockReset().mockResolvedValue({ count: 1 });
    mockTx.referralCredit.create.mockReset();
    mockTx.referralCredit.findMany.mockReset().mockResolvedValue([]);
    mockTx.referralCode.update.mockReset();
    mockTx.referralProgramConfig.upsert
      .mockReset()
      .mockResolvedValue(activeConfig());
    mockTx.referralProgramConfig.update.mockReset();
    mockTx.user.findUnique.mockReset().mockResolvedValue({ role: "CONSULTEE" });
  });

  const baseReferral = {
    id: "ref-1",
    status: "SIGNED_UP",
    signedUpAt: new Date(),
    referralCodeId: "code-1",
    referredUserId: "referee-1",
    referrerRewardAmount: 30000,
    refereeRewardAmount: 30000,
    referralCode: { userId: "referrer-1" },
  };

  it("skips the booking credit for a consultant referee (they get the waiver)", async () => {
    mockTx.referral.findUnique.mockResolvedValue(baseReferral);
    mockTx.user.findUnique.mockResolvedValue({ role: "CONSULTANT" });

    await processQualifyingAction("referee-1", "first_paid_booking_received");

    expect(mockTx.referralCredit.create).toHaveBeenCalledTimes(1);
    expect(mockTx.referralCredit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ source: "REFERRAL_BONUS" }),
      }),
    );
  });

  it("grants nothing and does not claim when the program is paused", async () => {
    mockTx.referral.findUnique.mockResolvedValue(baseReferral);
    mockTx.referralProgramConfig.upsert.mockResolvedValue(
      activeConfig({ isActive: false }),
    );

    await processQualifyingAction("referee-1", "first_paid_booking");

    expect(mockTx.referral.updateMany).not.toHaveBeenCalled();
    expect(mockTx.referralCredit.create).not.toHaveBeenCalled();
  });

  it("defers (no claim) when the monthly budget is exhausted", async () => {
    mockTx.referral.findUnique.mockResolvedValue(baseReferral);
    mockTx.referralProgramConfig.upsert.mockResolvedValue(
      activeConfig({ monthlyBudgetPaise: 10000, currentMonthSpentPaise: 10000 }),
    );

    await processQualifyingAction("referee-1", "first_paid_booking");

    expect(mockTx.referral.updateMany).not.toHaveBeenCalled();
    expect(mockTx.referralCredit.create).not.toHaveBeenCalled();
  });

  it("clamps the referrer grant by the annual per-referrer cap", async () => {
    mockTx.referral.findUnique.mockResolvedValue(baseReferral);
    // Already earned ₹9,990 this year → only ₹10 (1000 paise) of headroom.
    mockTx.referralCredit.findMany.mockResolvedValue([{ amount: 999000 }]);

    await processQualifyingAction("referee-1", "first_paid_booking");

    expect(mockTx.referralCredit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: "REFERRAL_BONUS",
          amount: 1000,
        }),
      }),
    );
  });
});
