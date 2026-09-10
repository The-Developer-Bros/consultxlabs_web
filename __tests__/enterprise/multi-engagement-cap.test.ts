/**
 * @jest-environment node
 */

/**
 * Issue #710: LICENSED_SEAT cap counts engagements (calendar
 * occurrences) per Appointment row, not per checkout.
 *
 * Covers:
 *   - CONSULTATION/WEBINAR debit 1 at checkout
 *   - CLASS debits N at enrolment (one per class day Appointment)
 *   - SUBSCRIPTION skips checkout-time debit (lazy at allocation)
 *   - SUBSCRIPTION lazy debit accumulates engagementsConsumed via upsert
 *   - Cap with BLOCK throws ProgramAssignmentLimitError when exceeded
 *   - Cap with CHARGE_MEMBER / CHARGE_ORG marks wasOverage and continues
 *   - reverseBookingUtilization decrements engagementsUsed by the row's full count
 *   - #1372: the MONEY meter, not just the count meter — a CREDIT_POOL reversal
 *     decrements consumedPaise, a LICENSED_SEAT reversal leaves it alone, and a
 *     refundRatio reverses price in proportion to the money actually refunded
 *
 * Architecture note: the helper does an upsert on `paymentId` (which is
 * @unique on BookingUtilization). For SUBSCRIPTION, the first allocation
 * creates the row; subsequent allocations increment engagementsConsumed
 * by the new delta. Each call always appends a fresh UsageLedgerEntry,
 * so `sum(UsageLedgerEntry.engagementsConsumed) === BookingUtilization.engagementsConsumed`
 * is preserved.
 */

import {
  recordBookingUtilization,
  reverseBookingUtilization,
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
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  usageLedgerEntry: {
    create: jest.Mock;
    aggregate: jest.Mock;
  };
  overageEvent: {
    updateMany: jest.Mock;
  };
};

function makeAssignmentLookup(opts: {
  cap: number | null;
  behavior: "BLOCK" | "CHARGE_MEMBER" | "CHARGE_ORG";
}) {
  return jest.fn().mockResolvedValue({
    programId: "prog-1",
    membershipId: "mem-1",
    program: {
      licensedSeatConfig: {
        coveredEngagementsPerCycle: opts.cap,
        overageBehavior: opts.behavior,
      },
    },
  });
}

function makeTx(opts: {
  cap: number | null;
  behavior: "BLOCK" | "CHARGE_MEMBER" | "CHARGE_ORG";
  blockUpdateRows?: number; // for BLOCK path: rows touched by conditional UPDATE
  chargeReturning?: { engagementsUsed: number }[]; // for CHARGE_* path
}): MockTx {
  return {
    programAssignment: {
      findUniqueOrThrow: makeAssignmentLookup(opts),
      // CHARGE_* / unlimited record path resolves to the post-increment row;
      // reverseBookingUtilization also uses this mock but ignores the return.
      update: jest.fn().mockResolvedValue(opts.chargeReturning?.[0] ?? {}),
      // BLOCK path: count===0 ⇒ cap exceeded → throws.
      updateMany: jest
        .fn()
        .mockResolvedValue({ count: opts.blockUpdateRows ?? 1 }),
    },
    bookingUtilization: {
      upsert: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    usageLedgerEntry: {
      create: jest.fn().mockResolvedValue({}),
      // Defaults to "no prior reversals" for fresh tests; partial-reversal
      // tests override this to simulate cumulative-reversed state.
      aggregate: jest
        .fn()
        .mockResolvedValue({ _sum: { engagementsConsumed: 0 } }),
    },
    overageEvent: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

describe("recordBookingUtilization — engagement counting (issue #710)", () => {
  it("CONSULTATION/WEBINAR pattern: passes engagementsConsumed=1 cleanly", async () => {
    const tx = makeTx({ cap: 10, behavior: "BLOCK" });
    await recordBookingUtilization(tx as never, {
      programAssignmentId: "asg-1",
      paymentId: "pay-1",
      engagementsConsumed: 1,
      priceAtBookingPaise: 50_000,
    });
    expect(tx.bookingUtilization.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { paymentId: "pay-1" },
        create: expect.objectContaining({ engagementsConsumed: 1 }),
        update: expect.objectContaining({
          engagementsConsumed: { increment: 1 },
        }),
      }),
    );
    expect(tx.usageLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ engagementsConsumed: 1 }),
      }),
    );
  });

  it("CLASS pattern: passes engagementsConsumed = N (count of distinct enrolled appointments)", async () => {
    const tx = makeTx({ cap: 20, behavior: "BLOCK" });
    await recordBookingUtilization(tx as never, {
      programAssignmentId: "asg-1",
      paymentId: "pay-class-1",
      engagementsConsumed: 8, // 8-week class
      priceAtBookingPaise: 200_000,
    });
    expect(tx.bookingUtilization.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ engagementsConsumed: 8 }),
      }),
    );
    expect(tx.usageLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ engagementsConsumed: 8 }),
      }),
    );
  });

  it("SUBSCRIPTION pattern: incremental upsert — second call increments engagementsConsumed", async () => {
    const tx = makeTx({ cap: null, behavior: "BLOCK" }); // unlimited cap
    // First allocation
    await recordBookingUtilization(tx as never, {
      programAssignmentId: "asg-1",
      paymentId: "pay-sub-1",
      engagementsConsumed: 1,
      priceAtBookingPaise: 600_000, // full sub price on first call
    });
    // Second allocation
    await recordBookingUtilization(tx as never, {
      programAssignmentId: "asg-1",
      paymentId: "pay-sub-1",
      engagementsConsumed: 1,
      priceAtBookingPaise: 0, // zero on subsequent
    });
    expect(tx.bookingUtilization.upsert).toHaveBeenCalledTimes(2);
    // Both calls go through upsert; the update branch uses { increment: 1 }
    // so two allocations end at engagementsConsumed = 2 in the DB.
    const calls = tx.bookingUtilization.upsert.mock.calls;
    expect(calls[0][0].update.engagementsConsumed).toEqual({ increment: 1 });
    expect(calls[1][0].update.engagementsConsumed).toEqual({ increment: 1 });
    // The ledger gets a fresh row each call.
    expect(tx.usageLedgerEntry.create).toHaveBeenCalledTimes(2);
  });

  it("BLOCK overage: throws ProgramAssignmentLimitError when conditional UPDATE matches 0 rows", async () => {
    const tx = makeTx({
      cap: 10,
      behavior: "BLOCK",
      blockUpdateRows: 0, // simulating cap exceeded
    });
    await expect(
      recordBookingUtilization(tx as never, {
        programAssignmentId: "asg-1",
        paymentId: "pay-overflow",
        engagementsConsumed: 5,
        priceAtBookingPaise: 100_000,
      }),
    ).rejects.toBeInstanceOf(ProgramAssignmentLimitError);
    // Booking utilization must NOT have been upserted on cap rejection.
    expect(tx.bookingUtilization.upsert).not.toHaveBeenCalled();
    expect(tx.usageLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("CHARGE_ORG overage: marks wasOverage=true when post-increment count exceeds cap", async () => {
    const tx = makeTx({
      cap: 10,
      behavior: "CHARGE_ORG",
      chargeReturning: [{ engagementsUsed: 11 }], // post-increment > cap
    });
    const result = await recordBookingUtilization(tx as never, {
      programAssignmentId: "asg-1",
      paymentId: "pay-overage",
      engagementsConsumed: 1,
      priceAtBookingPaise: 50_000,
    });
    expect(result.wasOverage).toBe(true);
    expect(tx.bookingUtilization.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ wasOverage: true }),
      }),
    );
  });

  it("CHARGE_MEMBER non-overage: wasOverage=false when post-increment fits within cap", async () => {
    const tx = makeTx({
      cap: 10,
      behavior: "CHARGE_MEMBER",
      chargeReturning: [{ engagementsUsed: 7 }],
    });
    const result = await recordBookingUtilization(tx as never, {
      programAssignmentId: "asg-1",
      paymentId: "pay-fits",
      engagementsConsumed: 2,
      priceAtBookingPaise: 50_000,
    });
    expect(result.wasOverage).toBe(false);
  });

  // PR-1e (G3): SUBSCRIPTION reallocation idempotency via appointmentIds.
  describe("appointmentIds idempotency (PR-1e)", () => {
    it("first call with appointmentIds=[a,b] increments by 2", async () => {
      const tx = makeTx({ cap: null, behavior: "BLOCK" });
      // First call: no existing BookingUtilization row.
      tx.bookingUtilization.findUnique = jest.fn().mockResolvedValue(null);
      const result = await recordBookingUtilization(tx as never, {
        programAssignmentId: "asg-1",
        paymentId: "pay-sub",
        engagementsConsumed: 2,
        priceAtBookingPaise: 600_000,
        appointmentIds: ["a", "b"],
      });
      expect(result.engagementsConsumedDelta).toBe(2);
      expect(tx.programAssignment.update).toHaveBeenCalledTimes(1);
      // Upsert was called with appointmentIds in create branch
      expect(
        tx.bookingUtilization.upsert.mock.calls[0][0].create,
      ).toMatchObject({
        engagementsConsumed: 2,
        appointmentIds: ["a", "b"],
      });
    });

    it("second call with same appointmentIds is a no-op (zero delta)", async () => {
      const tx = makeTx({ cap: null, behavior: "BLOCK" });
      // Existing row already tracks both ids.
      tx.bookingUtilization.findUnique = jest.fn().mockResolvedValue({
        appointmentIds: ["a", "b"],
      });
      const result = await recordBookingUtilization(tx as never, {
        programAssignmentId: "asg-1",
        paymentId: "pay-sub",
        engagementsConsumed: 2,
        priceAtBookingPaise: 0,
        appointmentIds: ["a", "b"], // same as already tracked
      });
      expect(result.engagementsConsumedDelta).toBe(0);
      expect(result.wasOverage).toBe(false);
      // No DB writes on a zero-delta call
      expect(tx.programAssignment.update).not.toHaveBeenCalled();
      expect(tx.programAssignment.updateMany).not.toHaveBeenCalled();
      expect(tx.bookingUtilization.upsert).not.toHaveBeenCalled();
      expect(tx.usageLedgerEntry.create).not.toHaveBeenCalled();
    });

    it("third call with appointmentIds=[a,b,c] when row tracks [a,b] increments by 1 (only c is new)", async () => {
      const tx = makeTx({ cap: null, behavior: "BLOCK" });
      tx.bookingUtilization.findUnique = jest.fn().mockResolvedValue({
        appointmentIds: ["a", "b"],
      });
      const result = await recordBookingUtilization(tx as never, {
        programAssignmentId: "asg-1",
        paymentId: "pay-sub",
        engagementsConsumed: 3,
        priceAtBookingPaise: 0,
        appointmentIds: ["a", "b", "c"],
      });
      expect(result.engagementsConsumedDelta).toBe(1);
      // Upsert append-pushes only the new id
      expect(
        tx.bookingUtilization.upsert.mock.calls[0][0].update.appointmentIds,
      ).toEqual({
        push: ["c"],
      });
    });

    it("legacy callers (no appointmentIds) keep the old additive semantics", async () => {
      const tx = makeTx({ cap: null, behavior: "BLOCK" });
      tx.bookingUtilization.findUnique = jest.fn().mockResolvedValue({
        appointmentIds: [],
      });
      const result = await recordBookingUtilization(tx as never, {
        programAssignmentId: "asg-1",
        paymentId: "pay-legacy",
        engagementsConsumed: 1,
        priceAtBookingPaise: 50_000,
        // no appointmentIds → old behavior: increment by params.engagementsConsumed
      });
      expect(result.engagementsConsumedDelta).toBe(1);
    });

    it("rejects negative engagementsConsumed defensively", async () => {
      const tx = makeTx({ cap: null, behavior: "BLOCK" });
      await expect(
        recordBookingUtilization(tx as never, {
          programAssignmentId: "asg-1",
          paymentId: "pay-neg",
          engagementsConsumed: -3,
          priceAtBookingPaise: 0,
        }),
      ).rejects.toThrow(/non-negative/);
    });
  });
});

describe("reverseBookingUtilization — refund cap reversal (full + partial)", () => {
  it("default (no engagementsToReverse) reverses the full count + stamps reversedAt", async () => {
    const tx = makeTx({ cap: 10, behavior: "BLOCK" });
    tx.bookingUtilization.findUnique = jest.fn().mockResolvedValue({
      programAssignmentId: "asg-1",
      engagementsConsumed: 8, // CLASS that enrolled 8 sessions
      priceAtBookingPaise: 200_000,
      wasOverage: false,
      reversedAt: null,
      programAssignment: { membershipId: "mem-1" },
    });
    const result = await reverseBookingUtilization(tx as never, {
      paymentId: "pay-class-1",
      reason: "Refund",
    });
    expect(result).toEqual({
      reversed: true,
      engagementsReversed: 8,
      fullyReversed: true,
    });
    expect(tx.programAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          engagementsUsed: { decrement: 8 },
        }),
      }),
    );
    expect(tx.usageLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          engagementsConsumed: -8,
          priceAtBookingPaise: -200_000,
        }),
      }),
    );
    expect(tx.bookingUtilization.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reversedAt: expect.any(Date) }),
      }),
    );
  });

  it("partial reversal: 50% refund of an 8-session class reverses 4 cap units", async () => {
    const tx = makeTx({ cap: 10, behavior: "BLOCK" });
    tx.bookingUtilization.findUnique = jest.fn().mockResolvedValue({
      programAssignmentId: "asg-1",
      engagementsConsumed: 8,
      priceAtBookingPaise: 200_000,
      wasOverage: false,
      reversedAt: null,
      programAssignment: { membershipId: "mem-1" },
    });
    const result = await reverseBookingUtilization(tx as never, {
      paymentId: "pay-class-partial",
      engagementsToReverse: 4, // caller computed Math.round(8 * 0.5)
      reason: "Partial refund (100000/200000)",
    });
    expect(result).toEqual({
      reversed: true,
      engagementsReversed: 4,
      fullyReversed: false,
    });
    expect(tx.programAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          engagementsUsed: { decrement: 4 },
        }),
      }),
    );
    // Price reversal is prorated: 200_000 * (4/8) = 100_000
    expect(tx.usageLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          engagementsConsumed: -4,
          priceAtBookingPaise: -100_000,
        }),
      }),
    );
    // reversedAt NOT stamped — partial reversal leaves the row open
    expect(tx.bookingUtilization.update).not.toHaveBeenCalled();
  });

  it("partial reversal: subsequent calls accumulate, last one stamps reversedAt", async () => {
    const tx = makeTx({ cap: 10, behavior: "BLOCK" });
    tx.bookingUtilization.findUnique = jest.fn().mockResolvedValue({
      programAssignmentId: "asg-1",
      engagementsConsumed: 8,
      priceAtBookingPaise: 200_000,
      wasOverage: false,
      reversedAt: null,
      programAssignment: { membershipId: "mem-1" },
    });
    // Simulate 3 already reversed (e.g., a prior partial refund of 37.5%)
    tx.usageLedgerEntry.aggregate = jest.fn().mockResolvedValue({
      _sum: { engagementsConsumed: -3 },
    });
    // Caller wants to reverse 5 more (the remaining 62.5%)
    const result = await reverseBookingUtilization(tx as never, {
      paymentId: "pay-class-2nd-partial",
      engagementsToReverse: 5,
    });
    expect(result).toEqual({
      reversed: true,
      engagementsReversed: 5,
      fullyReversed: true, // 3 + 5 = 8 = full
    });
    expect(tx.bookingUtilization.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reversedAt: expect.any(Date) }),
      }),
    );
  });

  it("partial reversal clamps to remaining: caller asks for 10, only 2 remain → reverses 2", async () => {
    const tx = makeTx({ cap: 10, behavior: "BLOCK" });
    tx.bookingUtilization.findUnique = jest.fn().mockResolvedValue({
      programAssignmentId: "asg-1",
      engagementsConsumed: 8,
      priceAtBookingPaise: 200_000,
      wasOverage: false,
      reversedAt: null,
      programAssignment: { membershipId: "mem-1" },
    });
    tx.usageLedgerEntry.aggregate = jest.fn().mockResolvedValue({
      _sum: { engagementsConsumed: -6 }, // 6 already reversed; 2 remaining
    });
    const result = await reverseBookingUtilization(tx as never, {
      paymentId: "pay-clamp",
      engagementsToReverse: 10, // caller over-asks; helper clamps
    });
    expect(result.engagementsReversed).toBe(2);
    expect(result.fullyReversed).toBe(true);
  });

  it("idempotent: already fully reversed via ledger sum returns reversed=false", async () => {
    const tx = makeTx({ cap: 10, behavior: "BLOCK" });
    tx.bookingUtilization.findUnique = jest.fn().mockResolvedValue({
      programAssignmentId: "asg-1",
      engagementsConsumed: 8,
      priceAtBookingPaise: 200_000,
      wasOverage: false,
      reversedAt: new Date(),
      programAssignment: { membershipId: "mem-1" },
    });
    tx.usageLedgerEntry.aggregate = jest.fn().mockResolvedValue({
      _sum: { engagementsConsumed: -8 }, // fully reversed already
    });
    const result = await reverseBookingUtilization(tx as never, {
      paymentId: "pay-already-reversed",
    });
    expect(result).toEqual({
      reversed: false,
      engagementsReversed: 0,
      fullyReversed: true,
    });
    expect(tx.programAssignment.update).not.toHaveBeenCalled();
  });

  it("missing utilization row: returns reversed=false (PERSONAL booking that never wrote a util)", async () => {
    const tx = makeTx({ cap: 10, behavior: "BLOCK" });
    tx.bookingUtilization.findUnique = jest.fn().mockResolvedValue(null);
    const result = await reverseBookingUtilization(tx as never, {
      paymentId: "pay-personal",
    });
    expect(result.reversed).toBe(false);
    expect(result.fullyReversed).toBe(false);
  });

  it("zero / negative engagementsToReverse: no-op, no DB writes", async () => {
    const tx = makeTx({ cap: 10, behavior: "BLOCK" });
    tx.bookingUtilization.findUnique = jest.fn().mockResolvedValue({
      programAssignmentId: "asg-1",
      engagementsConsumed: 8,
      priceAtBookingPaise: 200_000,
      wasOverage: false,
      reversedAt: null,
      programAssignment: { membershipId: "mem-1" },
    });
    const result = await reverseBookingUtilization(tx as never, {
      paymentId: "pay-zero",
      engagementsToReverse: 0,
    });
    expect(result.reversed).toBe(false);
    expect(tx.programAssignment.update).not.toHaveBeenCalled();
    expect(tx.usageLedgerEntry.create).not.toHaveBeenCalled();
  });

  // #1372 — every case above meters ENGAGEMENTS. A CREDIT_POOL program meters
  // PAISE, and that arm had no assertions at all, so `consumedPaise` could have
  // reversed the wrong amount (or not at all) without a single test noticing.
  // `makeTx`'s single `aggregate` mock answers both aggregates; `sumPaise` of an
  // undefined sum is 0, so the price clamp below is inert and the proportional
  // amount is what lands.
  it("#1372 CREDIT_POOL: a full reversal decrements consumedPaise by the whole price", async () => {
    const tx = makeTx({ cap: 10, behavior: "BLOCK" });
    tx.bookingUtilization.findUnique = jest.fn().mockResolvedValue({
      programAssignmentId: "asg-1",
      engagementsConsumed: 2,
      priceAtBookingPaise: 200_000,
      wasOverage: false,
      reversedAt: null,
      programAssignment: {
        membershipId: "mem-1",
        program: { type: "CREDIT_POOL" },
      },
    });

    await reverseBookingUtilization(tx as never, {
      paymentId: "pay-credit-pool",
      reason: "Refund",
    });

    expect(tx.programAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          engagementsUsed: { decrement: 2 },
          consumedPaise: { decrement: 200_000 },
        }),
      }),
    );
  });

  it("#1372 LICENSED_SEAT: consumedPaise is left untouched", async () => {
    const tx = makeTx({ cap: 10, behavior: "BLOCK" });
    tx.bookingUtilization.findUnique = jest.fn().mockResolvedValue({
      programAssignmentId: "asg-1",
      engagementsConsumed: 2,
      priceAtBookingPaise: 200_000,
      wasOverage: false,
      reversedAt: null,
      programAssignment: {
        membershipId: "mem-1",
        program: { type: "LICENSED_SEAT" },
      },
    });

    await reverseBookingUtilization(tx as never, {
      paymentId: "pay-licensed-seat",
      reason: "Refund",
    });

    // A seat program meters seats, so writing paise back would be inventing a
    // number. `undefined` is the deliberate absence, not a forgotten branch.
    expect(tx.programAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({
          consumedPaise: expect.anything(),
        }),
      }),
    );
  });

  it("#1372 refundRatio: reverses price in proportion to the money refunded", async () => {
    // The docblock's own example: a ₹750 refund of a 2 × ₹1,000 booking releases
    // one seat but reverses ₹750 of price, not the ₹1,000 the seat count implies.
    const tx = makeTx({ cap: 10, behavior: "BLOCK" });
    tx.bookingUtilization.findUnique = jest.fn().mockResolvedValue({
      programAssignmentId: "asg-1",
      engagementsConsumed: 2,
      priceAtBookingPaise: 200_000,
      wasOverage: false,
      reversedAt: null,
      programAssignment: {
        membershipId: "mem-1",
        program: { type: "CREDIT_POOL" },
      },
    });

    const result = await reverseBookingUtilization(tx as never, {
      paymentId: "pay-refund-ratio",
      engagementsToReverse: 1,
      refundRatio: { refundAmountPaise: 75_000, paymentAmountPaise: 200_000 },
      reason: "Partial refund",
    });

    expect(result.engagementsReversed).toBe(1);
    expect(tx.programAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          engagementsUsed: { decrement: 1 },
          consumedPaise: { decrement: 75_000 },
        }),
      }),
    );
    // The ledger has to agree with the meter or the two drift apart silently.
    expect(tx.usageLedgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          engagementsConsumed: -1,
          priceAtBookingPaise: -75_000,
        }),
      }),
    );
  });

  it("overageCount only decrements on the LAST (fully-reversing) reversal", async () => {
    const tx = makeTx({ cap: 10, behavior: "BLOCK" });
    tx.bookingUtilization.findUnique = jest.fn().mockResolvedValue({
      programAssignmentId: "asg-1",
      engagementsConsumed: 8,
      priceAtBookingPaise: 200_000,
      wasOverage: true, // booking went over cap
      reversedAt: null,
      programAssignment: { membershipId: "mem-1" },
    });
    // First partial: 4 of 8 — overageCount should NOT decrement
    const partial = await reverseBookingUtilization(tx as never, {
      paymentId: "pay-overage",
      engagementsToReverse: 4,
    });
    expect(partial.fullyReversed).toBe(false);
    expect(tx.programAssignment.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({
          overageCount: expect.anything(),
        }),
      }),
    );
    // Now the second half — overageCount SHOULD decrement
    tx.usageLedgerEntry.aggregate = jest.fn().mockResolvedValue({
      _sum: { engagementsConsumed: -4 },
    });
    const final = await reverseBookingUtilization(tx as never, {
      paymentId: "pay-overage",
      engagementsToReverse: 4,
    });
    expect(final.fullyReversed).toBe(true);
    expect(tx.programAssignment.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          overageCount: { decrement: 1 },
        }),
      }),
    );
  });
});
