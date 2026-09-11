/**
 * Tests for Stream Chat channel actions
 * Tests channel creation and management for v9 SDK compatibility
 */

import {
  createMockPrisma,
  createMockChannelClient,
  createMockChannel,
  createMockLogger,
  createMockChannelCache,
} from "./__mocks__/stream-mocks";

// Create mock instances
const mockPrisma = createMockPrisma();
const mockStreamClient = createMockChannelClient();
const mockChannel = createMockChannel();
const mockLogger = createMockLogger();
const mockCache = createMockChannelCache();

// Mock dependencies using relative paths
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: mockPrisma,
}));

jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: jest.fn(() => mockStreamClient),
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: mockLogger,
}));

jest.mock("../../lib/stream-cache", () => mockCache);

jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUserToStream: jest.fn().mockResolvedValue({}),
  upsertUsersToStream: jest.fn().mockResolvedValue({ users: {} }),
}));

// #899 — addMemberToChannel is session-gated; mocking auth-server also keeps
// jest away from lib/auth's better-auth ESM imports. Default: privileged.
const mockGetSession = jest.fn();
jest.mock("../../lib/auth-server", () => ({
  getSession: () => mockGetSession(),
}));

// auth-helpers imports next/server (NextResponse), which needs the fetch
// globals jest's node env lacks — mirror the real one-liner instead.
jest.mock("../../lib/auth-helpers", () => ({
  isPrivileged: (role?: string | null) => role === "ADMIN" || role === "STAFF",
}));

// The DM eligibility gate is exercised against real query shapes in
// __tests__/security/dm-eligibility.test.ts. Here it is stubbed so these tests
// keep asserting what they are about — id derivation and Stream call shape —
// rather than turning into relationship fixtures. Default: permitted.
const mockAssertCanDirectMessage = jest.fn();
jest.mock("../../lib/stream/dm-eligibility", () => ({
  assertCanDirectMessage: (...args: unknown[]) =>
    mockAssertCanDirectMessage(...args),
}));

describe("Channel Actions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertCanDirectMessage.mockResolvedValue(undefined);
    mockStreamClient.channel.mockReturnValue(mockChannel);
    mockStreamClient.queryChannels.mockResolvedValue([]);
    mockGetSession.mockResolvedValue({
      user: { id: "staff-user", role: "ADMIN" },
    });
  });

  describe("createChannel", () => {
    it("should create a channel with valid input", async () => {
      const { createChannel } =
        await import("../../actions/stream/chat/channel.action");

      mockChannel.query.mockResolvedValueOnce({
        members: { user1: {}, user2: {} },
      });

      const result = await createChannel({
        channelType: "messaging",
        channelId: "test-channel-123",
        channelName: "Test Channel",
        members: ["user1", "user2"],
        createdById: "user1",
      });

      expect(result.channelId).toBe("test-channel-123");
      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "messaging",
        "test-channel-123",
        expect.objectContaining({
          name: "Test Channel",
          created_by_id: "user1",
          members: expect.arrayContaining(["user1", "user2"]),
        }),
      );
      expect(mockChannel.create).toHaveBeenCalled();
    });

    // #1270 — the roster travels inside the create() request body and Stream
    // caps that at 100 members, the same ceiling `upsertUsersToStream` already
    // respects. A 150-seat webinar built a valid roster and then had the whole
    // create rejected, so the attendee who triggered it got no chat at all.
    it("caps the create() roster at 100 and adds the rest in chunks", async () => {
      const { createChannel } = await import(
        "../../actions/stream/chat/channel.action"
      );

      mockChannel.query.mockResolvedValueOnce({ members: {} });
      const members = Array.from({ length: 249 }, (_, i) => `attendee-${i}`);

      const result = await createChannel({
        channelType: "team",
        channelId: "webinar-sold-out",
        members,
        createdById: "host",
      });

      const createData = mockStreamClient.channel.mock.calls.at(-1)?.[2] as {
        members: string[];
      };
      expect(createData.members).toHaveLength(100);
      // The creator has to be inside the atomic call — Stream needs
      // created_by_id to resolve, and the host is the one channel member the
      // channel cannot function without.
      expect(createData.members[0]).toBe("host");

      const followUps = mockChannel.addMembers.mock.calls.map(
        ([batch]: [string[]]) => batch,
      );
      expect(followUps.map((b: string[]) => b.length)).toEqual([100, 50]);

      // Nobody dropped, nobody duplicated, and the caller still sees everyone.
      expect([...createData.members, ...followUps.flat()]).toEqual([
        "host",
        ...members,
      ]);
      expect(result.members).toHaveLength(250);
    });

    it("adds no follow-up request for an ordinary two-person channel", async () => {
      const { createChannel } = await import(
        "../../actions/stream/chat/channel.action"
      );

      mockChannel.query.mockResolvedValueOnce({ members: {} });

      await createChannel({
        channelType: "messaging",
        channelId: "dm-a-b",
        members: ["a", "b"],
        createdById: "a",
      });

      // Chunking must not cost a second round trip on the shape almost every
      // channel actually has.
      expect(mockChannel.addMembers).not.toHaveBeenCalled();
    });

    it("still backfills the roster after losing a create race", async () => {
      const { createChannel } = await import(
        "../../actions/stream/chat/channel.action"
      );

      mockChannel.query.mockResolvedValueOnce({ members: {} });
      mockChannel.create.mockRejectedValueOnce(
        new Error('GetOrCreateChannel failed: "channel already exists"'),
      );

      await createChannel({
        channelType: "team",
        channelId: "webinar-raced",
        members: Array.from({ length: 149 }, (_, i) => `attendee-${i}`),
        createdById: "host",
      });

      // The winner created the same channel from the same roster, so the same
      // remainder is owed either way and addMembers is idempotent.
      expect(mockChannel.addMembers).toHaveBeenCalledTimes(1);
      expect(mockChannel.addMembers.mock.calls[0][0]).toHaveLength(50);
    });

    it("should deduplicate members list", async () => {
      const { createChannel } =
        await import("../../actions/stream/chat/channel.action");

      mockChannel.query.mockResolvedValueOnce({ members: { user1: {} } });

      await createChannel({
        channelType: "team",
        channelId: "dedup-test",
        members: ["user1", "user1", "user1"],
        createdById: "user1",
      });

      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "team",
        "dedup-test",
        expect.objectContaining({
          members: ["user1"],
        }),
      );
    });

    it("should ensure creator is always in members list", async () => {
      const { createChannel } =
        await import("../../actions/stream/chat/channel.action");

      mockChannel.query.mockResolvedValueOnce({
        members: { creator: {}, other: {} },
      });

      await createChannel({
        channelType: "messaging",
        channelId: "creator-test",
        members: ["other"],
        createdById: "creator",
      });

      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "messaging",
        "creator-test",
        expect.objectContaining({
          members: expect.arrayContaining(["creator", "other"]),
        }),
      );
    });

    it.each([
      [
        "plain already-exists message",
        new Error('GetOrCreateChannel failed: "channel already exists"'),
      ],
      [
        "message with unrelated numeric code",
        Object.assign(new Error("channel already exists"), { code: 4 }),
      ],
    ])(
      "adopts an existing channel on duplicate rejection (%s)",
      async (_label, duplicateError) => {
        const { createChannel } =
          await import("../../actions/stream/chat/channel.action");

        mockChannel.create.mockRejectedValueOnce(duplicateError);

        // team type so the post-create path includes the host moderator grant.
        const result = await createChannel({
          channelType: "team",
          channelId: "race-loser",
          members: ["user1"],
          createdById: "user1",
        });

        // Adopted, not failed: same id handed back, no raw payload, and the
        // normal post-create path still ran (moderator grant + cache stamp).
        expect(result.channelId).toBe("race-loser");
        expect(result.channelData).toBeNull();
        expect(mockChannel.assignRoles).toHaveBeenCalled();
        expect(mockCache.markChannelExists).toHaveBeenCalled();
      },
    );

    it("rethrows Not Allowed (code 17) failures instead of adopting", async () => {
      // Stream's error table defines 17 as Not Allowed / HTTP 403 — a
      // permission failure, never a duplicate. The predicate must not swallow
      // it into the adopt path or creation would be skipped silently.
      const forbidden = Object.assign(new Error("Not Allowed"), { code: 17 });
      mockChannel.create.mockRejectedValueOnce(forbidden);

      const { createChannel } =
        await import("../../actions/stream/chat/channel.action");

      await expect(
        createChannel({
          channelType: "messaging",
          channelId: "forbidden-channel",
          members: ["user1"],
          createdById: "user1",
        }),
      ).rejects.toThrow("Not Allowed");
      expect(mockCache.markChannelExists).not.toHaveBeenCalled();
    });

    it("rethrows non-duplicate create failures", async () => {
      const { createChannel } =
        await import("../../actions/stream/chat/channel.action");

      mockChannel.create.mockRejectedValueOnce(new Error("Stream 500"));

      await expect(
        createChannel({
          channelType: "messaging",
          channelId: "real-failure",
          members: ["user1"],
          createdById: "user1",
        }),
      ).rejects.toThrow("Stream 500");
    });

    it("should reject invalid channel type", async () => {
      const { createChannel } =
        await import("../../actions/stream/chat/channel.action");

      await expect(
        createChannel({
          channelType: "invalid" as "messaging" | "team",
          channelId: "test",
          members: ["user1"],
          createdById: "user1",
        }),
      ).rejects.toThrow();
    });

    it("should reject empty channel ID", async () => {
      const { createChannel } =
        await import("../../actions/stream/chat/channel.action");

      await expect(
        createChannel({
          channelType: "messaging",
          channelId: "",
          members: ["user1"],
          createdById: "user1",
        }),
      ).rejects.toThrow();
    });

    it("should reject empty members array", async () => {
      const { createChannel } =
        await import("../../actions/stream/chat/channel.action");

      await expect(
        createChannel({
          channelType: "messaging",
          channelId: "test",
          members: [],
          createdById: "user1",
        }),
      ).rejects.toThrow();
    });
  });

  describe("createDirectMessageChannel", () => {
    it("should create DM channel with sorted user IDs", async () => {
      const { createDirectMessageChannel } =
        await import("../../actions/stream/chat/channel.action");

      mockChannel.query.mockResolvedValueOnce({
        members: { alice: {}, bob: {} },
      });

      const result = await createDirectMessageChannel("bob", "alice");

      expect(result.channelId).toBe("dm-alice-bob");
      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "messaging",
        "dm-alice-bob",
        expect.anything(),
      );
    });

    it("should create consistent channel ID regardless of user order", async () => {
      const { createDirectMessageChannel } =
        await import("../../actions/stream/chat/channel.action");

      mockChannel.query.mockResolvedValue({ members: {} });

      const result1 = await createDirectMessageChannel("user-z", "user-a");

      mockStreamClient.channel.mockClear();
      const result2 = await createDirectMessageChannel("user-a", "user-z");

      expect(result1.channelId).toBe(result2.channelId);
    });

    it("should reject empty user IDs", async () => {
      const { createDirectMessageChannel } =
        await import("../../actions/stream/chat/channel.action");

      await expect(createDirectMessageChannel("", "user2")).rejects.toThrow();
      await expect(createDirectMessageChannel("user1", "")).rejects.toThrow();
    });

    it("consults the eligibility gate before creating anything", async () => {
      const { createDirectMessageChannel } =
        await import("../../actions/stream/chat/channel.action");

      mockChannel.query.mockResolvedValue({ members: {} });
      await createDirectMessageChannel("bob", "alice");

      expect(mockAssertCanDirectMessage).toHaveBeenCalledWith("bob", "alice");
    });

    it("creates no channel when the pair has no booking link", async () => {
      const { createDirectMessageChannel } =
        await import("../../actions/stream/chat/channel.action");

      mockAssertCanDirectMessage.mockRejectedValue(
        new Error("Direct messages are only available between people who share a booking."),
      );

      await expect(
        createDirectMessageChannel("stranger-a", "stranger-b"),
      ).rejects.toThrow("share a booking");

      // The gate has to run BEFORE the Stream call, not alongside it — a
      // refusal that still creates the channel is not a refusal.
      expect(mockStreamClient.channel).not.toHaveBeenCalled();
    });

    it("refuses a self-pair at id derivation", async () => {
      const { createDirectMessageChannel } =
        await import("../../actions/stream/chat/channel.action");

      // The gate is stubbed permissive here, so this asserts the SECOND line of
      // defence: getDmChannelId itself rejects `a === a` rather than producing
      // `dm-a-a`, which createChannel would then de-duplicate into a
      // one-member channel that renders as its own raw id.
      await expect(
        createDirectMessageChannel("same-user", "same-user"),
      ).rejects.toThrow(/self-DM/i);
    });
  });

  describe("addMemberToChannel", () => {
    it("should add member to existing channel", async () => {
      const { addMemberToChannel } =
        await import("../../actions/stream/chat/member.action");

      const result = await addMemberToChannel(
        "consultation-123",
        "new-user-id",
      );

      expect(result.success).toBe(true);
      expect(mockChannel.addMembers).toHaveBeenCalledWith(["new-user-id"]);
    });

    it("should infer messaging type for consultation channels", async () => {
      const { addMemberToChannel } =
        await import("../../actions/stream/chat/member.action");

      await addMemberToChannel("consultation-abc", "user123");

      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "messaging",
        "consultation-abc",
      );
    });

    it("should infer messaging type for subscription channels", async () => {
      const { addMemberToChannel } =
        await import("../../actions/stream/chat/member.action");

      await addMemberToChannel("subscription-xyz", "user456");

      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "messaging",
        "subscription-xyz",
      );
    });

    it("should infer team type for other channels", async () => {
      const { addMemberToChannel } =
        await import("../../actions/stream/chat/member.action");

      await addMemberToChannel("webinar-123", "user789");

      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "team",
        "webinar-123",
      );
    });

    it("should reject invalid inputs", async () => {
      const { addMemberToChannel } =
        await import("../../actions/stream/chat/member.action");

      await expect(addMemberToChannel("", "user")).rejects.toThrow();
      await expect(addMemberToChannel("channel", "")).rejects.toThrow();
    });

    // #899 — server-side Stream calls bypass Stream's permission system, so
    // the app-layer guard is the only gate.
    it("should reject unauthenticated callers", async () => {
      mockGetSession.mockResolvedValueOnce(null);

      const { addMemberToChannel } =
        await import("../../actions/stream/chat/member.action");

      await expect(
        addMemberToChannel("consultation-123", "new-user-id"),
      ).rejects.toThrow("Unauthorized");
      expect(mockChannel.addMembers).not.toHaveBeenCalled();
    });

    it("should reject a non-privileged caller who is not the creator", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "random-user", role: "CONSULTEE" },
      });
      // mockReset flushes unconsumed query Onces leaked from earlier tests
      // (clearAllMocks doesn't), which would otherwise shift this value
      mockChannel.query.mockReset();
      mockChannel.query.mockResolvedValue({
        channel: { created_by: { id: "someone-else" } },
      });

      const { addMemberToChannel } =
        await import("../../actions/stream/chat/member.action");

      await expect(
        addMemberToChannel("consultation-123", "new-user-id"),
      ).rejects.toThrow("Forbidden");
      expect(mockChannel.addMembers).not.toHaveBeenCalled();
      expect(mockChannel.create).not.toHaveBeenCalled();
    });

    it("should allow the channel creator without lazy channel creation", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "creator-user", role: "CONSULTANT" },
      });
      mockChannel.query.mockReset();
      mockChannel.query.mockResolvedValue({
        channel: { created_by: { id: "creator-user" } },
      });

      const { addMemberToChannel } =
        await import("../../actions/stream/chat/member.action");

      const result = await addMemberToChannel(
        "consultation-123",
        "new-user-id",
      );

      expect(result.success).toBe(true);
      expect(mockChannel.addMembers).toHaveBeenCalledWith(["new-user-id"]);
      expect(mockChannel.create).not.toHaveBeenCalled();
    });
  });
});

describe("Entity Channel Creation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStreamClient.channel.mockReturnValue(mockChannel);
    mockChannel.query.mockResolvedValue({ members: {} });
  });

  describe("createWebinarChannel", () => {
    it("should create channel for webinar registrants", async () => {
      mockPrisma.webinar.findUnique.mockResolvedValueOnce({
        id: "webinar-123",
        webinarPlan: {
          title: "Test Webinar",
          consultantProfile: { user: { id: "consultant-1" } },
        },
        appointment: {
          slotsOfAppointment: [{ user: [{ id: "user-3" }, { id: "user-1" }] }],
        },
      });

      const { createWebinarChannel } =
        await import("../../actions/stream/chat/channel.action");

      const result = await createWebinarChannel("webinar-123");

      expect(result.channelId).toBe("webinar-webinar-123");
      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "team",
        "webinar-webinar-123",
        expect.objectContaining({
          name: "Test Webinar",
          created_by_id: "consultant-1",
          webinar_id: "webinar-123",
        }),
      );
    });

    it("should throw error when webinar not found", async () => {
      mockPrisma.webinar.findUnique.mockResolvedValueOnce(null);

      const { createWebinarChannel } =
        await import("../../actions/stream/chat/channel.action");

      await expect(createWebinarChannel("nonexistent")).rejects.toThrow(
        "Webinar not found: nonexistent",
      );
    });

    it("should throw error when consultant missing", async () => {
      mockPrisma.webinar.findUnique.mockResolvedValueOnce({
        id: "webinar-123",
        webinarPlan: { title: "Test", consultantProfile: null },
        appointment: null,
      });

      const { createWebinarChannel } =
        await import("../../actions/stream/chat/channel.action");

      await expect(createWebinarChannel("webinar-123")).rejects.toThrow(
        "Consultant not found for webinar",
      );
    });

    it("should reject empty webinar ID", async () => {
      const { createWebinarChannel } =
        await import("../../actions/stream/chat/channel.action");

      await expect(createWebinarChannel("")).rejects.toThrow();
    });
  });

  describe("createClassChannel", () => {
    it("should create channel for class with multiple appointments", async () => {
      mockPrisma.class.findUnique.mockResolvedValueOnce({
        id: "class-456",
        classPlan: {
          title: "Test Class",
          consultantProfile: { user: { id: "consultant-2" } },
        },
        appointments: [
          { slotsOfAppointment: [{ user: [{ id: "user-b" }] }] },
          { slotsOfAppointment: [{ user: [{ id: "user-c" }] }] },
        ],
      });

      const { createClassChannel } =
        await import("../../actions/stream/chat/channel.action");

      const result = await createClassChannel("class-456");

      expect(result.channelId).toBe("class-class-456");
      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "team",
        "class-class-456",
        expect.objectContaining({
          name: "Test Class",
          created_by_id: "consultant-2",
          class_id: "class-456",
        }),
      );
    });

    it("should throw error when class not found", async () => {
      mockPrisma.class.findUnique.mockResolvedValueOnce(null);

      const { createClassChannel } =
        await import("../../actions/stream/chat/channel.action");

      await expect(createClassChannel("nonexistent")).rejects.toThrow(
        "Class not found: nonexistent",
      );
    });

    it("should throw error when consultant missing", async () => {
      mockPrisma.class.findUnique.mockResolvedValueOnce({
        id: "class-456",
        classPlan: { title: "Test", consultantProfile: { user: null } },
        appointments: [],
      });

      const { createClassChannel } =
        await import("../../actions/stream/chat/channel.action");

      await expect(createClassChannel("class-456")).rejects.toThrow(
        "Consultant not found for class",
      );
    });
  });

  describe("createConsultationChannel", () => {
    it("should create messaging channel between consultant and consultee", async () => {
      mockPrisma.consultation.findUnique.mockResolvedValueOnce({
        id: "consultation-789",
        consultationPlan: {
          consultantProfile: { user: { id: "consultant-3" } },
        },
        requestedBy: { user: { id: "consultee-1" } },
      });

      const { createConsultationChannel } =
        await import("../../actions/stream/chat/channel.action");

      const result = await createConsultationChannel("consultation-789");
      expect(result).not.toBeNull();

      // IDs sorted: "consultant-3" < "consultee-1" alphabetically
      expect(result!.channelId).toBe("dm-consultant-3-consultee-1");
      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "messaging",
        "dm-consultant-3-consultee-1",
        expect.objectContaining({
          created_by_id: "consultant-3",
          dm_consultant_user_id: "consultant-3",
          dm_consultee_user_id: "consultee-1",
        }),
      );
    });

    it("should throw error when consultation not found", async () => {
      mockPrisma.consultation.findUnique.mockResolvedValueOnce(null);

      const { createConsultationChannel } =
        await import("../../actions/stream/chat/channel.action");

      await expect(createConsultationChannel("nonexistent")).rejects.toThrow(
        "Consultation not found: nonexistent",
      );
    });

    it("should throw error when participants missing", async () => {
      mockPrisma.consultation.findUnique.mockResolvedValueOnce({
        id: "consultation-789",
        consultationPlan: { consultantProfile: { user: { id: null } } },
        requestedBy: { user: { id: "consultee-1" } },
      });

      const { createConsultationChannel } =
        await import("../../actions/stream/chat/channel.action");

      await expect(
        createConsultationChannel("consultation-789"),
      ).rejects.toThrow("Participants not found for consultation");
    });
  });

  describe("createSubscriptionChannel", () => {
    it("should create messaging channel for subscription", async () => {
      mockPrisma.subscription.findUnique.mockResolvedValueOnce({
        id: "subscription-101",
        subscriptionPlan: {
          consultantProfile: { user: { id: "consultant-4" } },
        },
        requestedBy: { user: { id: "subscriber-1" } },
        // Production includes the org-tagged appointments relation (take:1), so
        // it's always an array; the mock must provide it (else appointments[0]
        // dereferences undefined). Empty = no org-hosted appointment.
        appointments: [],
      });

      const { createSubscriptionChannel } =
        await import("../../actions/stream/chat/channel.action");

      const result = await createSubscriptionChannel("subscription-101");
      expect(result).not.toBeNull();

      // IDs sorted: "consultant-4" < "subscriber-1" alphabetically
      expect(result!.channelId).toBe("dm-consultant-4-subscriber-1");
      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "messaging",
        "dm-consultant-4-subscriber-1",
        expect.objectContaining({
          created_by_id: "consultant-4",
          dm_consultant_user_id: "consultant-4",
          dm_consultee_user_id: "subscriber-1",
        }),
      );
    });

    it("should throw error when subscription not found", async () => {
      mockPrisma.subscription.findUnique.mockResolvedValueOnce(null);

      const { createSubscriptionChannel } =
        await import("../../actions/stream/chat/channel.action");

      await expect(createSubscriptionChannel("nonexistent")).rejects.toThrow(
        "Subscription not found: nonexistent",
      );
    });

    it("should throw error when participants missing", async () => {
      mockPrisma.subscription.findUnique.mockResolvedValueOnce({
        id: "subscription-101",
        subscriptionPlan: {
          consultantProfile: { user: { id: "consultant-4" } },
        },
        requestedBy: { user: { id: null } },
      });

      const { createSubscriptionChannel } =
        await import("../../actions/stream/chat/channel.action");

      await expect(
        createSubscriptionChannel("subscription-101"),
      ).rejects.toThrow("Participants not found for subscription");
    });
  });
});

describe("addMemberToChannel error handling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStreamClient.channel.mockReturnValue(mockChannel);
    mockGetSession.mockResolvedValue({
      user: { id: "staff-user", role: "ADMIN" },
    });
  });

  it("should throw error when addMembers fails", async () => {
    mockChannel.addMembers.mockRejectedValueOnce(new Error("API error"));

    const { addMemberToChannel } =
      await import("../../actions/stream/chat/member.action");

    await expect(
      addMemberToChannel("test-channel", "user-123"),
    ).rejects.toThrow("API error");

    expect(mockLogger.error).toHaveBeenCalledWith(
      "Failed to add member to channel",
      expect.any(Error),
      expect.objectContaining({
        channelId: "test-channel",
        userId: "user-123",
      }),
    );
  });
});
