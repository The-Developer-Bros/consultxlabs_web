/**
 * @jest-environment node
 */

/**
 * #1580 C-P0-3 — `updateCollaborator` had no status check, so the host could
 * rewrite an ACCEPTED collaborator's share the night before the event. The
 * fix refuses rather than re-consents: flipping the row back to PENDING would
 * drop the collaborator from every ACCEPTED-only reader, and a settlement in
 * that window would pay their share to the host as the residual party.
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

const tx = {
  collaborator: {
    findFirst: jest.fn(),
    findMany: jest.fn(async (): Promise<{ role: string }[]> => []),
    update: jest.fn(async (args: { data: unknown }) => ({
      id: "c1",
      ...(args.data as object),
    })),
  },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  },
}));

import {
  CollaboratorCapError,
  CollaboratorNotFoundError,
  CollaboratorTermsLockedError,
  updateCollaborator,
} from "@/lib/collaborators/service";

const run = () =>
  updateCollaborator("webinar", "c1", "plan-1", { revenueSharePercentage: 1 });

describe("updateCollaborator by row status", () => {
  it("ACCEPTED: refuses with the typed error and writes nothing", async () => {
    tx.collaborator.findFirst.mockResolvedValue({
      id: "c1",
      status: "ACCEPTED",
    });
    await expect(run()).rejects.toBeInstanceOf(CollaboratorTermsLockedError);
    await expect(run()).rejects.toThrow(
      "Accepted terms cannot be changed; remove the collaborator and re-invite with the new terms",
    );
    expect(tx.collaborator.update).not.toHaveBeenCalled();
  });

  it.each(["REMOVED", "DECLINED"])("%s: reports not found", async (status) => {
    tx.collaborator.findFirst.mockResolvedValue({ id: "c1", status });
    await expect(run()).rejects.toBeInstanceOf(CollaboratorNotFoundError);
    expect(tx.collaborator.update).not.toHaveBeenCalled();
  });

  it("PENDING: proceeds as before", async () => {
    tx.collaborator.findFirst.mockResolvedValue({
      id: "c1",
      status: "PENDING",
    });
    await expect(run()).resolves.toMatchObject({ revenueShareBps: 100 });
    expect(tx.collaborator.update).toHaveBeenCalledTimes(1);
  });

  it("PENDING: a re-role to a presenter is refused while another presenter is active", async () => {
    // The invite cap would otherwise be bypassed by inviting as MODERATOR and
    // PATCHing to CO_HOST (#1580 §6).
    tx.collaborator.findFirst.mockResolvedValue({
      id: "c1",
      status: "PENDING",
      role: "MODERATOR",
    });
    tx.collaborator.findMany.mockResolvedValueOnce([{ role: "CO_HOST" }]);
    await expect(
      updateCollaborator("webinar", "c1", "plan-1", { role: "CO_HOST" }),
    ).rejects.toBeInstanceOf(CollaboratorCapError);
    expect(tx.collaborator.update).not.toHaveBeenCalled();
    // The row itself is excluded from the check, so the sole presenter can be
    // re-saved as a presenter: the query must carry `id: { not: "c1" }`, or the
    // row would block its own re-role.
    tx.collaborator.findFirst.mockResolvedValue({
      id: "c1",
      status: "PENDING",
      role: "CO_HOST",
    });
    tx.collaborator.findMany.mockResolvedValueOnce([]);
    await expect(
      updateCollaborator("webinar", "c1", "plan-1", { role: "CO_HOST" }),
    ).resolves.toMatchObject({ role: "CO_HOST" });
    expect(tx.collaborator.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { not: "c1" } }),
      }),
    );
  });
});
