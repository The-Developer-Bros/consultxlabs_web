/**
 * #1580 — the collaborator coordination channel is created with members Stream
 * has never seen unless they are upserted first; every other creator in
 * channel.action.ts does so, this one did not, and the channel never existed
 * (Sentry FAMILIARISE_WEB-37). Pins the upsert-before-create order.
 */

const mockChannel = {
  create: jest.fn(),
  query: jest.fn(),
  addMembers: jest.fn().mockResolvedValue({}),
  removeMembers: jest.fn().mockResolvedValue({}),
  assignRoles: jest.fn().mockResolvedValue({}),
  id: "collab-webinar-plan-1",
  type: "messaging",
};
const mockStreamClient = { channel: jest.fn(), queryChannels: jest.fn() };
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
const mockCache = {
  isChannelCached: jest.fn(() => false),
  markChannelExists: jest.fn(),
  initialSyncCompletedUsers: new Set<string>(),
};
const calls: string[] = [];

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    webinarPlan: {
      findUnique: jest.fn(async () => ({
        title: "Intro Webinar",
        consultantProfile: { user: { id: "host-user" } },
        collaborators: [{ consultantProfile: { user: { id: "collab-user" } } }],
      })),
    },
  },
}));

jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: jest.fn(() => mockStreamClient),
  withStreamCircuitBreaker: jest.fn((op: () => unknown) => op()),
  StreamUnavailableError: class StreamUnavailableError extends Error {},
  isExpectedStreamError: jest.fn(() => false),
}));
jest.mock("../../lib/stream-logger", () => ({ streamLogger: mockLogger }));
jest.mock("../../lib/stream-cache", () => mockCache);
jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUserToStream: jest.fn().mockResolvedValue({}),
  upsertUsersToStream: jest.fn(async (ids: string[]) => {
    calls.push(`upsert:${ids.join(",")}`);
    return { users: {} };
  }),
}));

describe("createCollaboratorChannel", () => {
  it("upserts the host and every accepted collaborator before creating the channel", async () => {
    // Imported here, after the mocks above are initialised (hoisting).
    const { createCollaboratorChannel } =
      await import("../../actions/stream/chat/channel.action");
    mockChannel.create.mockImplementation(async () => {
      calls.push("create");
      return {};
    });
    mockChannel.query.mockResolvedValue({
      members: [{ user_id: "host-user" }, { user_id: "collab-user" }],
    });
    mockStreamClient.channel.mockReturnValue(mockChannel);

    await createCollaboratorChannel("webinar", "plan-1");

    expect(calls.slice(0, 2)).toEqual([
      "upsert:host-user,collab-user",
      "create",
    ]);
  });
});
