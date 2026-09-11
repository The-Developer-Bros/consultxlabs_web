/**
 * @jest-environment node
 */

/**
 * #705 — the number that says whether the tree works.
 *
 * "What fraction of conversations resolve without a person" was unanswerable
 * here, and not merely unmeasured: the platform scope returned before any write
 * at all, so a user the tree helped left no trace to count after the fact.
 *
 * The read side deliberately reports null rather than 0% on an empty window.
 * No traffic and no deflection are different facts, and a dashboard that
 * renders them identically invites the wrong decision.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    supportFlowOutcome: { create: jest.fn(), groupBy: jest.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { deflectionSince, recordFlowOutcome } from "@/lib/support/deflection";

const mockPrisma = prisma as unknown as {
  supportFlowOutcome: { create: jest.Mock; groupBy: jest.Mock };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.supportFlowOutcome.create.mockResolvedValue({});
});

describe("recording an outcome", () => {
  it("stores the dimensions and no message body", async () => {
    await recordFlowOutcome({
      scope: "PLATFORM",
      flowKey: "PAYMENTS_BILLING",
      terminalNodeId: "tracking",
      reason: "refund_status",
      outcome: "RESOLVED",
      userId: "u1",
    });
    const { data } = mockPrisma.supportFlowOutcome.create.mock.calls[0][0];
    expect(data).toEqual({
      scope: "PLATFORM",
      flowKey: "PAYMENTS_BILLING",
      terminalNodeId: "tracking",
      reason: "refund_status",
      outcome: "RESOLVED",
      userId: "u1",
      organizationId: null,
    });
    // This is a counter, not a transcript.
    expect(Object.keys(data)).not.toContain("body");
    expect(Object.keys(data)).not.toContain("message");
  });

  it("never lets a failed counter take down the support turn", async () => {
    // A metric outage must not become a support outage.
    mockPrisma.supportFlowOutcome.create.mockRejectedValue(new Error("db down"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      recordFlowOutcome({
        scope: "APPOINTMENT",
        flowKey: "CANCEL_REFUND",
        outcome: "ESCALATED",
        userId: "u1",
      }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("shares the caller's transaction when given one, so it can be rolled back", async () => {
    const tx = { supportFlowOutcome: { create: jest.fn().mockResolvedValue({}) } };
    await recordFlowOutcome(
      { scope: "APPOINTMENT", flowKey: "RESCHEDULE", outcome: "RESOLVED", userId: "u1" },
      tx as never,
    );
    expect(tx.supportFlowOutcome.create).toHaveBeenCalled();
    expect(mockPrisma.supportFlowOutcome.create).not.toHaveBeenCalled();
  });
});

describe("reading the rate", () => {
  it("computes deflection to one decimal", async () => {
    mockPrisma.supportFlowOutcome.groupBy.mockResolvedValue([
      { outcome: "RESOLVED", _count: { _all: 7 } },
      { outcome: "ESCALATED", _count: { _all: 3 } },
    ]);
    const s = await deflectionSince(new Date(0));
    expect(s).toEqual({
      resolved: 7,
      escalated: 3,
      total: 10,
      deflectionRate: 70,
    });
  });

  it("reports null, not zero, on an empty window", async () => {
    mockPrisma.supportFlowOutcome.groupBy.mockResolvedValue([]);
    const s = await deflectionSince(new Date(0));
    expect(s.total).toBe(0);
    expect(s.deflectionRate).toBeNull();
  });

  it("reports 0 when every conversation escalated", async () => {
    // Distinct from the empty case above: this one is a real, bad number.
    mockPrisma.supportFlowOutcome.groupBy.mockResolvedValue([
      { outcome: "ESCALATED", _count: { _all: 4 } },
    ]);
    const s = await deflectionSince(new Date(0));
    expect(s.deflectionRate).toBe(0);
  });
});
