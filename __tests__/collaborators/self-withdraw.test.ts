/**
 * @jest-environment node
 */

/**
 * #1580 C-P1-7 — a collaborator may withdraw their own PENDING/ACCEPTED row
 * through the same REMOVED path the owner uses; the notice then goes to the
 * host, not to them. A third party's withdraw attempt matches no row.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: jest.fn(() => ({
    channel: () => ({ removeMembers: jest.fn(async () => undefined) }),
  })),
}));
jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  removeUserFromEventChannel: jest.fn(async () => ({ success: true })),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyCollaboratorInvited: jest.fn(),
  notifyCollaboratorAccepted: jest.fn(),
  notifyCollaboratorRemoved: jest.fn(async () => undefined),
  notifyCollaboratorWithdrawn: jest.fn(async () => undefined),
}));

const row = {
  id: "c-1",
  consultantProfileId: "cp-collab",
  webinarPlanId: "plan-1",
  status: "ACCEPTED",
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    collaborator: {
      // Honour the ownership filter the withdraw path adds to the where.
      findFirst: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          where.consultantProfileId === undefined ||
          where.consultantProfileId === row.consultantProfileId
            ? row
            : null,
      ),
      update: jest.fn(async () => ({ ...row, status: "REMOVED" })),
    },
    consultantProfile: {
      findUnique: jest.fn(async () => ({
        userId: "u-collab",
        user: { name: "Collab" },
      })),
    },
    webinarPlan: {
      findUnique: jest.fn(async () => ({
        title: "T",
        consultantProfile: { userId: "u-host" },
      })),
    },
    webinar: { findMany: jest.fn(async () => []) },
  },
}));

import {
  notifyCollaboratorRemoved,
  notifyCollaboratorWithdrawn,
} from "@/lib/novu/service";
import prisma from "@/lib/prisma";
import { removeCollaborator } from "@/lib/collaborators/service";

describe("collaborator self-withdraw", () => {
  beforeEach(() => jest.clearAllMocks());

  it("lets the collaborator withdraw their own row and notifies the host", async () => {
    const result = await removeCollaborator("webinar", "c-1", "plan-1", {
      withdrawnByProfileId: "cp-collab",
    });
    expect(result).toMatchObject({ status: "REMOVED", accessRevoked: true });
    expect(notifyCollaboratorWithdrawn).toHaveBeenCalledWith(
      "u-host",
      expect.objectContaining({
        collaboratorName: "Collab",
        planType: "webinar",
      }),
    );
    expect(notifyCollaboratorRemoved).not.toHaveBeenCalled();
  });

  it("matches no row for a third party", async () => {
    const result = await removeCollaborator("webinar", "c-1", "plan-1", {
      withdrawnByProfileId: "cp-stranger",
    });
    expect(result).toBeNull();
    expect(prisma.collaborator.update).not.toHaveBeenCalled();
    expect(notifyCollaboratorWithdrawn).not.toHaveBeenCalled();
  });
});
