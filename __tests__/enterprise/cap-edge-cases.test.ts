/**
 * @jest-environment node
 */

/**
 * PR-1e Phase C: explicit edge-case sweep for the engagement-cap math.
 *
 * The happy paths and overage modes are covered in
 * `multi-engagement-cap.test.ts`. This file pins the corner cases that
 * are easy to regress on and produce silent financial effects:
 *
 *   - cap = 0 (zero engagements covered) — every booking should reject
 *     under BLOCK and overage under CHARGE_*.
 *   - cap = null (unlimited) — booking always succeeds, never flags
 *     overage.
 *   - engagementsConsumed = 0 — defensive no-op without partial-debit
 *     side effects.
 *   - engagementsConsumed < 0 — should throw (defensive). The helper
 *     never wrote a negative delta historically; future callers might
 *     mistakenly pass a refund amount here.
 */

import {
  recordBookingUtilization,
  ProgramAssignmentLimitError,
} from "@/lib/api/organizations/program-helpers";

type MockTx = {
  programAssignment: {
    findUniqueOrThrow: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  bookingUtilization: {
    upsert: jest.Mock;
    findUnique: jest.Mock;
  };
  usageLedgerEntry: {
    create: jest.Mock;
    aggregate: jest.Mock;
  };
};

function makeTx(opts: {
  cap: number | null;
  behavior: "BLOCK" | "CHARGE_MEMBER" | "CHARGE_ORG";
  blockUpdateRows?: number;
  chargeReturning?: { engagementsUsed: number }[];
}): MockTx {
  return {
    programAssignment: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        programId: "prog-1",
        membershipId: "mem-1",
        program: {
          licensedSeatConfig: {
            coveredEngagementsPerCycle: opts.cap,
            overageBehavior: opts.behavior,
          },
        },
      }),
      // CHARGE_* / unlimited path: resolves to the post-increment row.
      update: jest
        .fn()
        .mockResolvedValue(opts.chargeReturning?.[0] ?? {}),
      // BLOCK path: count===0 ⇒ cap exceeded → throws.
      updateMany: jest
        .fn()
        .mockResolvedValue({ count: opts.blockUpdateRows ?? 1 }),
    },
    bookingUtilization: {
      upsert: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    usageLedgerEntry: {
      create: jest.fn().mockResolvedValue({}),
      aggregate: jest.fn().mockResolvedValue({ _sum: { engagementsConsumed: 0 } }),
    },
  };
}

describe("cap edge cases — cap=0 (zero engagements covered)", () => {
  it("BLOCK rejects every booking, even a 1-engagement consultation", async () => {
    const tx = makeTx({
      cap: 0,
      behavior: "BLOCK",
      blockUpdateRows: 0, // 0 + 1 <= 0 is false → 0 rows touched
    });
    await expect(
      recordBookingUtilization(tx as never, {
        programAssignmentId: "asg-1",
        paymentId: "pay-zero-cap",
        engagementsConsumed: 1,
        priceAtBookingPaise: 50_000,
      }),
    ).rejects.toBeInstanceOf(ProgramAssignmentLimitError);
    expect(tx.bookingUtilization.upsert).not.toHaveBeenCalled();
  });

  it("CHARGE_ORG cap=0 succeeds with wasOverage=true", async () => {
    const tx = makeTx({
      cap: 0,
      behavior: "CHARGE_ORG",
      chargeReturning: [{ engagementsUsed: 1 }],
    });
    const result = await recordBookingUtilization(tx as never, {
      programAssignmentId: "asg-1",
      paymentId: "pay-zero-cap-overage",
      engagementsConsumed: 1,
      priceAtBookingPaise: 50_000,
    });
    expect(result.wasOverage).toBe(true);
  });
});

describe("cap edge cases — cap=null (unlimited)", () => {
  it("never throws regardless of engagementsConsumed", async () => {
    const tx = makeTx({ cap: null, behavior: "BLOCK" });
    const result = await recordBookingUtilization(tx as never, {
      programAssignmentId: "asg-1",
      paymentId: "pay-unlimited",
      engagementsConsumed: 1_000, // would blow any finite cap
      priceAtBookingPaise: 50_000_000,
    });
    expect(result.wasOverage).toBe(false);
    expect(tx.programAssignment.update).toHaveBeenCalledTimes(1);
  });

  it("CHARGE_MEMBER + cap=null: wasOverage stays false (the cap path is bypassed)", async () => {
    const tx = makeTx({ cap: null, behavior: "CHARGE_MEMBER" });
    const result = await recordBookingUtilization(tx as never, {
      programAssignmentId: "asg-1",
      paymentId: "pay-unlimited-charge-member",
      engagementsConsumed: 50,
      priceAtBookingPaise: 0,
    });
    expect(result.wasOverage).toBe(false);
  });
});

describe("cap edge cases — degenerate inputs", () => {
  it("engagementsConsumed=0 with no appointmentIds: no DB writes (defensive no-op)", async () => {
    const tx = makeTx({ cap: 10, behavior: "BLOCK" });
    const result = await recordBookingUtilization(tx as never, {
      programAssignmentId: "asg-1",
      paymentId: "pay-zero-delta",
      engagementsConsumed: 0,
      priceAtBookingPaise: 0,
    });
    expect(result.engagementsConsumedDelta).toBe(0);
    expect(tx.programAssignment.update).not.toHaveBeenCalled();
    expect(tx.programAssignment.updateMany).not.toHaveBeenCalled();
    expect(tx.bookingUtilization.upsert).not.toHaveBeenCalled();
    expect(tx.usageLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("engagementsConsumed<0 throws — never write a negative delta from this helper", async () => {
    const tx = makeTx({ cap: 10, behavior: "BLOCK" });
    await expect(
      recordBookingUtilization(tx as never, {
        programAssignmentId: "asg-1",
        paymentId: "pay-negative",
        engagementsConsumed: -5,
        priceAtBookingPaise: 0,
      }),
    ).rejects.toThrow(/non-negative/);
  });

  it("appointmentIds=[] with engagementsConsumed=0: no-op (caller decided nothing changed)", async () => {
    const tx = makeTx({ cap: 10, behavior: "BLOCK" });
    tx.bookingUtilization.findUnique = jest.fn().mockResolvedValue({
      appointmentIds: ["x"],
    });
    const result = await recordBookingUtilization(tx as never, {
      programAssignmentId: "asg-1",
      paymentId: "pay-empty-ids",
      engagementsConsumed: 0,
      priceAtBookingPaise: 0,
      appointmentIds: [],
    });
    expect(result.engagementsConsumedDelta).toBe(0);
    expect(tx.programAssignment.update).not.toHaveBeenCalled();
    expect(tx.programAssignment.updateMany).not.toHaveBeenCalled();
  });
});
