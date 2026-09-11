/**
 * @jest-environment node
 */

/**
 * #785 (task #25) — abandoned overage-charge sweeper. Never-paid PENDING
 * CHARGE_MEMBER side-charges count toward the per-cycle circuit-breaker ceiling
 * (cycleOverageSoFarPaise excludes only REVERSED/BLOCKED/FAILED). This job FAILs
 * the abandoned ones so they stop blocking legit bookings.
 */
jest.mock("../../lib/prisma", () => {
  const client = {
    overageEvent: { findMany: jest.fn() },
    // #812 — the sweep claims per-event in a tx (FAIL + basePaise restore).
    $transaction: jest.fn(
      (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(client),
    ),
  };
  return { __esModule: true, default: client };
});
jest.mock("../../lib/payments/billing/overage-transitions", () => ({
  transitionOverage: jest.fn(),
}));
jest.mock("../../lib/payments/billing/overage-base-carve", () => ({
  restoreOverageBaseCarve: jest.fn().mockResolvedValue("restored"),
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: jest.fn().mockResolvedValue(undefined),
}));


// #476 — the sweep cores are now wrapped in withCronLock; pass through so
// these unit tests exercise the sweep logic, not the lock (covered in
// with-cron-lock.test.ts).
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: jest.fn((_job: string, _opts: unknown, fn: () => unknown) => fn()),
  CronLockHeldError: class CronLockHeldError extends Error {},
  CronLockUnavailableError: class CronLockUnavailableError extends Error {},
  LONG_JOB_TTL_MS: 35 * 60 * 1000,
}));

import prisma from "../../lib/prisma";
import { transitionOverage } from "../../lib/payments/billing/overage-transitions";
import { sweepAbandonedOverageCharges } from "../../scripts/cleanup/sweep-abandoned-overage-charges";

const mockFindMany = (
  prisma as unknown as { overageEvent: { findMany: jest.Mock } }
).overageEvent.findMany;
const mockTransition = transitionOverage as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe("sweepAbandonedOverageCharges (#785)", () => {
  it("FAILs abandoned PENDING CHARGE_MEMBER charges to free the ceiling", async () => {
    mockFindMany.mockResolvedValue([{ id: "ov_1" }, { id: "ov_2" }]);
    mockTransition.mockResolvedValue(2);

    const r = await sweepAbandonedOverageCharges({ ageDays: 7 });

    expect(r).toMatchObject({ scanned: 2, failed: 2 });
    const where = mockFindMany.mock.calls[0][0].where;
    expect(where.chargeStatus).toBe("PENDING");
    expect(where.overageBehavior).toBe("CHARGE_MEMBER");
    expect(where.createdAt).toHaveProperty("lt");
    // Only never-STARTED side-charges: no payment, or a non-SUCCEEDED payment
    // whose paymentIntent is still the synthetic `overage:<parentId>` (the order
    // route overwrites it with the real gateway id once the member opens
    // checkout). #785 — a charge whose intent was replaced may be captured-but-
    // webhook-stuck, so it must NOT be swept (FAILing it would strand money).
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { paymentId: null },
        {
          payment: {
            is: {
              paymentStatus: { not: "SUCCEEDED" },
              paymentIntent: { startsWith: "overage:" },
            },
          },
        },
      ]),
    );
    // #812 — per-event tx now: PENDING→FAILED claim (transitionOverage
    // appends the legal-from guard) + basePaise restore land together,
    // stamping an auditable write-off reason (#779 §A).
    expect(mockTransition).toHaveBeenCalledTimes(2);
    for (const id of ["ov_1", "ov_2"]) {
      expect(mockTransition).toHaveBeenCalledWith(
        expect.anything(),
        { id },
        "FAILED",
        { chargeFailureReason: expect.stringContaining("swept at 7d") },
      );
    }
  });

  it("empty scan → no transition", async () => {
    mockFindMany.mockResolvedValue([]);
    const r = await sweepAbandonedOverageCharges();
    expect(r).toMatchObject({ scanned: 0, failed: 0 });
    expect(mockTransition).not.toHaveBeenCalled();
  });
});
