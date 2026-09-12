/**
 * @jest-environment node
 */

/**
 * #1580 C-P0-1 — settlement calls `calculateRevenueSplit` from inside the
 * earnings transaction. Under PG_POOL_MAX=1 a read on the GLOBAL client there
 * queues behind the connection the transaction holds (the #1435 shape), so the
 * split must be read through whichever client the caller hands over.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: jest.fn(),
}));
jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  removeUserFromEventChannel: jest.fn(),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyCollaboratorInvited: jest.fn(),
  notifyCollaboratorAccepted: jest.fn(),
  notifyCollaboratorRemoved: jest.fn(),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    collaborator: { findMany: jest.fn() },
    webinarPlan: { findUnique: jest.fn() },
    classPlan: { findUnique: jest.fn() },
  },
}));

import globalPrisma from "@/lib/prisma";
import { calculateRevenueSplit } from "@/lib/collaborators/service";

function makeTx() {
  return {
    collaborator: {
      findMany: jest.fn().mockResolvedValue([
        {
          consultantProfileId: "collab-1",
          status: "ACCEPTED",
          role: "CO_HOST",
          revenueShareBps: 3000,
        },
      ]),
    },
    webinarPlan: {
      findUnique: jest.fn().mockResolvedValue({ consultantProfileId: "owner" }),
    },
    classPlan: { findUnique: jest.fn() },
  };
}

describe("calculateRevenueSplit reads through the client it is given", () => {
  it("performs every read on the passed client and none on the global one", async () => {
    const tx = makeTx();

    const splits = await calculateRevenueSplit(
      "webinar",
      "plan-1",
      10_000,
      tx as never,
    );

    expect(tx.collaborator.findMany).toHaveBeenCalledTimes(1);
    expect(tx.webinarPlan.findUnique).toHaveBeenCalledTimes(1);
    expect(globalPrisma.collaborator.findMany).not.toHaveBeenCalled();
    expect(globalPrisma.webinarPlan.findUnique).not.toHaveBeenCalled();
    expect(globalPrisma.classPlan.findUnique).not.toHaveBeenCalled();
    expect(splits).toEqual([
      { consultantProfileId: "owner", share: 7000, role: "OWNER" },
      { consultantProfileId: "collab-1", share: 3000, role: "CO_HOST" },
    ]);
  });
});
