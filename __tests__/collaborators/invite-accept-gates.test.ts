/**
 * @jest-environment node
 */

/**
 * #1580 C-P1-9 — an invite and an accept are refused when the invitee is
 * deleted, unverified, banned or erased, when they already hold a seat on
 * one of the plan's events, or when the plan is archived. Accept re-runs
 * the same gates because standing can change between the two calls.
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
  notifyCollaboratorDeclined: jest.fn(),
  notifyCollaboratorWithdrawn: jest.fn(),
}));

type Invitee = {
  userId: string;
  deletedAt: Date | null;
  verificationStatus: string;
  user: {
    id: string;
    banned: boolean | null;
    banExpires: Date | null;
    erasedAt: Date | null;
  };
};
const eligible = (): Invitee => ({
  userId: "u-new",
  deletedAt: null,
  verificationStatus: "VERIFIED",
  user: { id: "u-new", banned: false, banExpires: null, erasedAt: null },
});
let invitee: Invitee = eligible();
let plan: { title: string; archivedAt: Date | null } | null = {
  title: "T",
  archivedAt: null,
};
let seat: { id: string } | null = null;

const tx = {
  collaborator: {
    findMany: jest.fn(async () => []),
    findFirst: jest.fn(async () => null),
    create: jest.fn(async (args: { data: unknown }) => ({
      id: "new",
      ...(args.data as object),
    })),
    update: jest.fn(),
  },
  appointmentParticipant: { createMany: jest.fn(async () => ({ count: 1 })) },
};
// The accept write is a CAS `updateMany` on status PENDING (#1580); the row is
// re-read afterwards. `collaboratorUpdate` spies on the CAS and shapes the re-read.
const collaboratorUpdate = jest.fn(async (..._args: unknown[]) => ({
  id: "c-1",
  role: "MODERATOR",
  status: "ACCEPTED",
}));
let lastWrite: { id: string; role: string; status: string } | null = null;
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantProfile: { findUnique: jest.fn(async () => invitee) },
    webinarPlan: { findUnique: jest.fn(async () => plan) },
    classPlan: { findUnique: jest.fn(async () => plan) },
    slotOfAppointment: { findFirst: jest.fn(async () => seat) },
    appointment: {
      findMany: jest.fn(async () => [{ id: "appt-1", organizationId: null }]),
    },
    collaborator: {
      findUnique: jest.fn(async () => ({
        id: "c-1",
        consultantProfileId: "cp-new",
        webinarPlanId: "plan-1",
        classPlanId: null,
        status: "PENDING",
      })),
      // Referenced lazily: the factory is hoisted above the const.
      updateMany: async (...args: unknown[]) => {
        lastWrite = (await collaboratorUpdate(...args)) as typeof lastWrite;
        return { count: 1 };
      },
      findUniqueOrThrow: async () => lastWrite,
    },
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  },
}));

import {
  inviteCollaborator,
  respondToInvitation,
} from "@/lib/collaborators/service";

const past = new Date(Date.now() - 86_400_000);
const future = new Date(Date.now() + 86_400_000);

const cases: Array<{
  name: string;
  arrange: () => void;
  status: 400 | 409;
}> = [
  {
    name: "a soft-deleted profile",
    arrange: () => (invitee.deletedAt = new Date()),
    status: 400,
  },
  {
    name: "an unverified profile",
    arrange: () => (invitee.verificationStatus = "UNDER_REVIEW"),
    status: 400,
  },
  {
    name: "an erased account",
    arrange: () => (invitee.user.erasedAt = new Date()),
    status: 400,
  },
  {
    name: "an active ban",
    arrange: () => {
      invitee.user.banned = true;
      invitee.user.banExpires = future;
    },
    status: 400,
  },
  {
    name: "an attendee of one of the plan's events",
    arrange: () => (seat = { id: "slot-1" }),
    status: 409,
  },
  {
    name: "an archived plan",
    arrange: () => (plan = { title: "T", archivedAt: new Date() }),
    status: 409,
  },
];

describe("invite and accept gates", () => {
  beforeEach(() => {
    invitee = eligible();
    plan = { title: "T", archivedAt: null };
    seat = null;
    jest.clearAllMocks();
  });

  describe.each(cases)("refuses $name", ({ arrange, status }) => {
    it("on invite", async () => {
      arrange();
      await expect(
        inviteCollaborator("webinar", "plan-1", "cp-new", "MODERATOR", 5, "h"),
      ).rejects.toMatchObject({
        name: "CollaboratorIneligibleError",
        httpStatus: status,
      });
      expect(tx.collaborator.create).not.toHaveBeenCalled();
    });

    it("on accept", async () => {
      arrange();
      await expect(
        respondToInvitation("webinar", "c-1", "cp-new", "ACCEPTED"),
      ).rejects.toMatchObject({
        name: "CollaboratorIneligibleError",
        httpStatus: status,
      });
      expect(collaboratorUpdate).not.toHaveBeenCalled();
    });
  });

  it("treats an expired ban as no ban and lets the accept through", async () => {
    invitee.user.banned = true;
    invitee.user.banExpires = past;
    await expect(
      respondToInvitation("webinar", "c-1", "cp-new", "ACCEPTED"),
    ).resolves.toMatchObject({ status: "ACCEPTED" });
    // The shadow participant edge (#1319 A9) is written for the accepted seat.
    expect(tx.appointmentParticipant.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          appointmentId: "appt-1",
          userId: "u-new",
          role: "COLLABORATOR",
          status: "CONFIRMED",
        }),
      ],
      skipDuplicates: true,
    });
  });

  it("does not gate a decline", async () => {
    plan = { title: "T", archivedAt: new Date() };
    collaboratorUpdate.mockResolvedValueOnce({
      id: "c-1",
      role: "MODERATOR",
      status: "DECLINED",
    });
    await expect(
      respondToInvitation("webinar", "c-1", "cp-new", "DECLINED"),
    ).resolves.toMatchObject({ status: "DECLINED" });
  });
});
