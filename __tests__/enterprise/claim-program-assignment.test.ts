/**
 * @jest-environment node
 */

/**
 * #785 — claimProgramAssignment must report whether THIS call created the row
 * so the assignment route increments activeSeatCount exactly once. Replaces the
 * old upsert + racy preexisting-probe (two concurrent identical POSTs could both
 * seat-count one logical seat). createMany({ skipDuplicates }) is INSERT … ON
 * CONFLICT DO NOTHING: count===1 for the racer that wins the unique key,
 * count===0 for a re-claim — and, unlike a caught P2002, never poisons the tx.
 */
import { claimProgramAssignment } from "@/lib/api/organizations/program-helpers";

type MockTx = {
  programAssignment: {
    createMany: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    findFirst: jest.Mock;
  };
};

const params = {
  programId: "prog_1",
  membershipId: "mem_1",
  periodStart: new Date("2026-04-01"),
  periodEnd: new Date("2026-05-01"),
};

function makeTx(insertedCount: number, overlapping: { id: string } | null = null): MockTx {
  return {
    programAssignment: {
      createMany: jest.fn().mockResolvedValue({ count: insertedCount }),
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ id: "assign_1", ...params }),
      // #778 §B overlap guard probe — null = no overlapping ACTIVE cycle.
      findFirst: jest.fn().mockResolvedValue(overlapping),
    },
  };
}

describe("claimProgramAssignment (#785 seat double-count guard)", () => {
  it("created=true when the row is genuinely inserted (count===1)", async () => {
    const tx = makeTx(1);
    const r = await claimProgramAssignment(tx as never, params);
    expect(r.created).toBe(true);
    expect(r.assignment.id).toBe("assign_1");
    // skipDuplicates so a concurrent duplicate insert is a no-op, not a throw.
    expect(tx.programAssignment.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });

  it("created=false on a re-claim / concurrent duplicate (count===0)", async () => {
    const tx = makeTx(0);
    const r = await claimProgramAssignment(tx as never, params);
    expect(r.created).toBe(false);
    // still returns the existing row so the caller can respond 201/200 uniformly
    expect(r.assignment.id).toBe("assign_1");
  });

  it("rejects an overlapping ACTIVE cycle (#778 §B) before inserting", async () => {
    const tx = makeTx(1, { id: "assign_other_cycle" });
    await expect(claimProgramAssignment(tx as never, params)).rejects.toThrow(
      /overlapping period/,
    );
    expect(tx.programAssignment.createMany).not.toHaveBeenCalled();
  });
});
