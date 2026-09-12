/**
 * @jest-environment node
 */

/**
 * #1580 §6 — at most three collaborators per plan in PENDING + ACCEPTED, and
 * only one of them a co-presenter. Both checks run inside the Serializable
 * invite transaction, beside the bps guard, so two concurrent invites cannot
 * jointly break either.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: jest.fn(),
}));
jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  removeUserFromEventChannel: jest.fn(),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyCollaboratorInvited: jest.fn(async () => undefined),
  notifyCollaboratorAccepted: jest.fn(),
  notifyCollaboratorRemoved: jest.fn(),
}));

type Row = { role: string; revenueShareBps: number };
let active: Row[] = [];

const tx = {
  collaborator: {
    // The bps guard and the cap guard both list the plan's active rows.
    findMany: jest.fn(async () => active),
    findFirst: jest.fn(async () => null),
    create: jest.fn(async (args: { data: unknown }) => ({
      id: "new",
      ...(args.data as object),
    })),
    update: jest.fn(),
  },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantProfile: {
      findUnique: jest.fn(async () => ({ id: "cp-new", userId: "u-new" })),
    },
    webinarPlan: { findUnique: jest.fn(async () => ({ title: "T" })) },
    classPlan: { findUnique: jest.fn(async () => ({ title: "T" })) },
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  },
}));

import {
  CollaboratorCapError,
  inviteCollaborator,
} from "@/lib/collaborators/service";

const invite = (role: string) =>
  inviteCollaborator("webinar", "plan-1", "cp-new", role, 5, "host-cp");

describe("the collaborator cap", () => {
  beforeEach(() => {
    active = [];
  });

  it("refuses a fourth pending-or-accepted collaborator", async () => {
    active = [
      { role: "CO_HOST", revenueShareBps: 1000 },
      { role: "MODERATOR", revenueShareBps: 500 },
      { role: "TECHNICAL_SUPPORT", revenueShareBps: 500 },
    ];
    await expect(invite("GUEST_SPEAKER")).rejects.toBeInstanceOf(
      CollaboratorCapError,
    );
    expect(tx.collaborator.create).not.toHaveBeenCalled();
  });

  it("refuses a second presenter while one is pending or accepted", async () => {
    active = [{ role: "CO_HOST", revenueShareBps: 1000 }];
    await expect(invite("CO_HOST")).rejects.toThrow("only one co-presenter");
    expect(tx.collaborator.create).not.toHaveBeenCalled();
  });

  it("allows a crew role beside one presenter", async () => {
    active = [{ role: "CO_HOST", revenueShareBps: 1000 }];
    await expect(invite("MODERATOR")).resolves.toMatchObject({
      role: "MODERATOR",
      status: "PENDING",
    });
    expect(tx.collaborator.create).toHaveBeenCalledTimes(1);
  });

  it("counts a re-activated REMOVED row as a new invite", async () => {
    active = [{ role: "CO_HOST", revenueShareBps: 1000 }];
    tx.collaborator.findFirst.mockResolvedValueOnce({
      id: "old",
      status: "REMOVED",
    } as never);
    await expect(invite("CO_HOST")).rejects.toBeInstanceOf(
      CollaboratorCapError,
    );
    expect(tx.collaborator.update).not.toHaveBeenCalled();
  });
});
