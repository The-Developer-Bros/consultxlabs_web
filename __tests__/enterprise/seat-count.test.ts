/**
 * @jest-environment node
 */

/**
 * Issue #699 ENT-1: BillingSubscription.activeSeatCount writer.
 *
 * Covers:
 *   - +1 / -1 deltas applied via raw SQL conditional UPDATE
 *   - LICENSED_SEAT programs increment, others no-op
 *   - Programs without an associated subscription (e.g. unbundled
 *     contracts) silently no-op
 *   - delta=0 returns applied:false without DB I/O
 *   - Underflow guard: -1 against count=0 throws SeatCountUnderflowError
 *     (the conditional UPDATE matches 0 rows)
 */

import {
  adjustActiveSeatCount,
  SeatCountUnderflowError,
} from "@/lib/api/organizations/seat-count";

type SubLookup = { id: string; activeSeatCount: number };

type MockTx = {
  program: { findUnique: jest.Mock };
  billingSubscription: {
    findUniqueOrThrow: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
};

function makeTx(opts: {
  programType: "LICENSED_SEAT" | "CREDIT_POOL" | "PROJECT" | "RETAINER";
  subscription: SubLookup | null;
  /** Rows touched by the conditional updateMany; 0 simulates underflow. */
  updateRows?: number;
  /** Post-update activeSeatCount returned to the caller. */
  postValue?: number;
}): MockTx {
  return {
    program: {
      findUnique: jest.fn().mockResolvedValue({
        type: opts.programType,
        contract: {
          subscription: opts.subscription,
        },
      }),
    },
    // #776 — seat-count writer now uses the ORM (atomic update / conditional
    // updateMany) instead of raw SQL.
    billingSubscription: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        activeSeatCount: opts.postValue ?? 0,
      }),
      update: jest.fn().mockResolvedValue({
        activeSeatCount: opts.postValue ?? 0,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: opts.updateRows ?? 1 }),
    },
  };
}

describe("adjustActiveSeatCount — BillingSubscription.activeSeatCount writer", () => {
  it("+1 on a LICENSED_SEAT program increments the subscription counter", async () => {
    const tx = makeTx({
      programType: "LICENSED_SEAT",
      subscription: { id: "sub-1", activeSeatCount: 3 },
      postValue: 4,
    });
    const result = await adjustActiveSeatCount(tx as never, {
      programId: "prog-1",
      delta: +1,
    });
    expect(result.applied).toBe(true);
    expect(result.balanceAfter).toBe(4);
    expect(tx.billingSubscription.update).toHaveBeenCalledTimes(1);
  });

  it("-1 with sufficient balance decrements", async () => {
    const tx = makeTx({
      programType: "LICENSED_SEAT",
      subscription: { id: "sub-1", activeSeatCount: 3 },
      updateRows: 1,
      postValue: 2,
    });
    const result = await adjustActiveSeatCount(tx as never, {
      programId: "prog-1",
      delta: -1,
    });
    expect(result.applied).toBe(true);
    expect(result.balanceAfter).toBe(2);
  });

  it("-1 with zero balance throws SeatCountUnderflowError", async () => {
    const tx = makeTx({
      programType: "LICENSED_SEAT",
      subscription: { id: "sub-1", activeSeatCount: 0 },
      updateRows: 0, // conditional UPDATE matched no rows
    });
    await expect(
      adjustActiveSeatCount(tx as never, {
        programId: "prog-1",
        delta: -1,
      }),
    ).rejects.toBeInstanceOf(SeatCountUnderflowError);
  });

  it("CREDIT_POOL programs no-op (not LICENSED_SEAT)", async () => {
    const tx = makeTx({
      programType: "CREDIT_POOL",
      subscription: { id: "sub-1", activeSeatCount: 3 },
    });
    const result = await adjustActiveSeatCount(tx as never, {
      programId: "prog-1",
      delta: +1,
    });
    expect(result.applied).toBe(false);
    expect(result.balanceAfter).toBeNull();
    expect(tx.billingSubscription.update).not.toHaveBeenCalled();
    expect(tx.billingSubscription.updateMany).not.toHaveBeenCalled();
  });

  it("LICENSED_SEAT with no subscription on the contract no-ops", async () => {
    const tx = makeTx({
      programType: "LICENSED_SEAT",
      subscription: null,
    });
    const result = await adjustActiveSeatCount(tx as never, {
      programId: "prog-1",
      delta: +1,
    });
    expect(result.applied).toBe(false);
    expect(tx.billingSubscription.update).not.toHaveBeenCalled();
  });

  it("delta=0 short-circuits without any DB lookup", async () => {
    const tx = makeTx({
      programType: "LICENSED_SEAT",
      subscription: { id: "sub-1", activeSeatCount: 3 },
    });
    const result = await adjustActiveSeatCount(tx as never, {
      programId: "prog-1",
      delta: 0,
    });
    expect(result.applied).toBe(false);
    expect(tx.program.findUnique).not.toHaveBeenCalled();
  });

  it("missing program no-ops (caller passed a stale id)", async () => {
    const tx: MockTx = {
      program: { findUnique: jest.fn().mockResolvedValue(null) },
      billingSubscription: {
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    const result = await adjustActiveSeatCount(tx as never, {
      programId: "prog-missing",
      delta: +1,
    });
    expect(result.applied).toBe(false);
    expect(tx.billingSubscription.update).not.toHaveBeenCalled();
  });
});
