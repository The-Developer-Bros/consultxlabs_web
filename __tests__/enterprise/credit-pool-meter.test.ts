/**
 * @jest-environment node
 */

/**
 * #775/#753 — CREDIT_POOL money-meter in recordBookingUtilization.
 *
 * LICENSED_SEAT meters by engagement COUNT; CREDIT_POOL meters by PAISE against
 * `creditBudgetPerCycle × 100`. This pins that a credit pool:
 *   - BLOCKs when consumedPaise + price would exceed the budget,
 *   - flags overage (wasOverage) under CHARGE_* when over budget,
 *   - returns the money-meter post values for the caller.
 */

import { recordBookingUtilization } from "@/lib/api/organizations/program-helpers";

type MockTx = {
  programAssignment: {
    findUniqueOrThrow: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  bookingUtilization: { upsert: jest.Mock; findUnique: jest.Mock };
  usageLedgerEntry: { create: jest.Mock };
};

function makeCreditTx(opts: {
  creditBudgetPerCycle: number;
  behavior: "BLOCK" | "CHARGE_MEMBER" | "CHARGE_ORG";
  consumedPaise: number;
  blockUpdateRows?: number;
  chargeReturning?: { engagementsUsed: number; consumedPaise: number }[];
}): MockTx {
  return {
    programAssignment: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        programId: "prog-cp",
        membershipId: "mem-1",
        engagementsUsed: 0,
        consumedPaise: opts.consumedPaise,
        program: {
          type: "CREDIT_POOL",
          licensedSeatConfig: null,
          creditPoolConfig: {
            creditBudgetPerCycle: opts.creditBudgetPerCycle,
            overageBehavior: opts.behavior,
          },
        },
      }),
      // CHARGE_* credit path resolves to the post-increment row (the helper
      // reads updated.consumedPaise). overageCount bump shares this mock.
      update: jest.fn().mockResolvedValue(opts.chargeReturning?.[0] ?? {}),
      // BLOCK path: count===0 ⇒ over budget → throws.
      updateMany: jest
        .fn()
        .mockResolvedValue({ count: opts.blockUpdateRows ?? 1 }),
    },
    bookingUtilization: {
      upsert: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    usageLedgerEntry: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe("recordBookingUtilization — CREDIT_POOL money-meter", () => {
  it("BLOCK: within budget proceeds and debits paise", async () => {
    const tx = makeCreditTx({
      creditBudgetPerCycle: 1000, // budget = 100_000 paise
      behavior: "BLOCK",
      consumedPaise: 50_000,
      blockUpdateRows: 1, // 50_000 + 30_000 <= 100_000
    });
    const r = await recordBookingUtilization(tx as never, {
      programAssignmentId: "asg-cp",
      paymentId: "pay-cp-1",
      engagementsConsumed: 1,
      priceAtBookingPaise: 30_000,
    });
    expect(r.programType).toBe("CREDIT_POOL");
    expect(r.creditBudgetPaise).toBe(100_000);
    expect(r.wasOverage).toBe(false);
    // The conditional UPDATE includes the consumedPaise guard.
    expect(tx.programAssignment.updateMany).toHaveBeenCalled();
  });

  it("BLOCK: over budget rejects (0 rows touched → throws)", async () => {
    const tx = makeCreditTx({
      creditBudgetPerCycle: 1000,
      behavior: "BLOCK",
      consumedPaise: 90_000,
      blockUpdateRows: 0, // 90_000 + 30_000 > 100_000 → guard fails
    });
    await expect(
      recordBookingUtilization(tx as never, {
        programAssignmentId: "asg-cp",
        paymentId: "pay-cp-2",
        engagementsConsumed: 1,
        priceAtBookingPaise: 30_000,
      }),
    ).rejects.toBeTruthy();
    expect(tx.bookingUtilization.upsert).not.toHaveBeenCalled();
  });

  it("CHARGE_ORG: over budget flags overage + returns post consumedPaise", async () => {
    const tx = makeCreditTx({
      creditBudgetPerCycle: 1000,
      behavior: "CHARGE_ORG",
      consumedPaise: 90_000,
      chargeReturning: [{ engagementsUsed: 1, consumedPaise: 120_000 }],
    });
    const r = await recordBookingUtilization(tx as never, {
      programAssignmentId: "asg-cp",
      paymentId: "pay-cp-3",
      engagementsConsumed: 1,
      priceAtBookingPaise: 30_000,
    });
    expect(r.wasOverage).toBe(true);
    expect(r.consumedPaiseAfter).toBe(120_000);
    expect(tx.programAssignment.update).toHaveBeenCalled();
  });
});
