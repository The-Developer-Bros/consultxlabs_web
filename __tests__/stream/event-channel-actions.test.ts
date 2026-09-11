/**
 * Tests for Stream Chat event channel actions
 * Tests channel creation, user syncing, and event-based channel management
 */

import {
  createMockPrisma,
  createMockChannelClient,
  createMockChannel,
  createMockLogger,
  createMockChannelCache,
} from "./__mocks__/stream-mocks";
import { DM_ELIGIBLE_STATUSES } from "@/lib/stream/dm-eligibility-statuses";

// Create mock instances
const mockPrisma = createMockPrisma();
const mockStreamClient = createMockChannelClient();
const mockChannel = createMockChannel();
const mockLogger = createMockLogger();
const mockCache = createMockChannelCache();

// Mock dependencies
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: mockPrisma,
}));

jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: jest.fn(() => mockStreamClient),
  // #473 — pass-through breaker (closed-state behaviour): run the operation
  // directly so existing assertions on the Stream calls still hold.
  withStreamCircuitBreaker: jest.fn((op: () => unknown) => op()),
  StreamUnavailableError: class StreamUnavailableError extends Error {},
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: mockLogger,
}));

jest.mock("../../lib/stream-cache", () => mockCache);

jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUserToStream: jest.fn().mockResolvedValue({}),
  upsertUsersToStream: jest.fn().mockResolvedValue({ users: {} }),
}));

// syncUserEventChannels is session-gated (F-HIGH-1 sibling); mocking
// auth-server also keeps jest away from lib/auth's better-auth ESM imports.
// Default: privileged staff, which passes the self-or-privileged gate for
// every userId these tests drive.
const mockGetSession = jest.fn();
jest.mock("../../lib/auth-server", () => ({
  getSession: (disableCookieCache?: boolean) =>
    mockGetSession(disableCookieCache),
}));

// auth-helpers imports next/server (NextResponse), which needs the fetch
// globals jest's node env lacks — mirror the real one-liner instead.
jest.mock("../../lib/auth-helpers", () => ({
  isPrivileged: (role?: string | null) => role === "ADMIN" || role === "STAFF",
}));

describe("Event Channel Actions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStreamClient.channel.mockReturnValue(mockChannel);
    mockStreamClient.queryChannels.mockResolvedValue([]);
    mockCache.initialSyncCompletedUsers.clear();
    mockGetSession.mockResolvedValue({
      user: { id: "staff-user", role: "ADMIN" },
    });
  });

  describe("checkEventChannelExists", () => {
    it("should return cached value when channel is cached as true", async () => {
      mockCache.isChannelCached.mockReturnValue(true);

      const { checkEventChannelExists } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await checkEventChannelExists("webinar", "webinar-123");

      expect(result).toBe(true);
      expect(mockStreamClient.channel).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Channel existence from cache",
        expect.objectContaining({ exists: true }),
      );
    });

    it("should return cached value when channel is cached as false", async () => {
      mockCache.isChannelCached.mockReturnValue(false);

      const { checkEventChannelExists } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await checkEventChannelExists("class", "class-456");

      expect(result).toBe(false);
      expect(mockStreamClient.channel).not.toHaveBeenCalled();
    });

    it("should query API and cache result on cache miss", async () => {
      mockCache.isChannelCached.mockReturnValue(undefined);
      mockChannel.query.mockResolvedValue({ state: {} });

      const { checkEventChannelExists } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await checkEventChannelExists("consultation", "cons-789");

      expect(result).toBe(true);
      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "messaging",
        "consultation-cons-789",
      );
      expect(mockChannel.query).toHaveBeenCalled();
      expect(mockCache.markChannelExists).toHaveBeenCalled();
    });

    it("should return false when channel query fails", async () => {
      mockCache.isChannelCached.mockReturnValue(undefined);
      mockChannel.query.mockRejectedValue(new Error("Channel not found"));

      const { checkEventChannelExists } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await checkEventChannelExists("subscription", "sub-abc");

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Channel does not exist",
        expect.any(Object),
      );
    });

    it("should return team type for webinar", async () => {
      mockCache.isChannelCached.mockReturnValue(undefined);
      mockChannel.query.mockResolvedValue({});

      const { checkEventChannelExists } =
        await import("../../actions/stream/chat/event-channel.action");

      await checkEventChannelExists("webinar", "web-123");

      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "team",
        "webinar-web-123",
      );
    });

    it("should return team type for class", async () => {
      mockCache.isChannelCached.mockReturnValue(undefined);
      mockChannel.query.mockResolvedValue({});

      const { checkEventChannelExists } =
        await import("../../actions/stream/chat/event-channel.action");

      await checkEventChannelExists("class", "cls-123");

      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "team",
        "class-cls-123",
      );
    });

    it("should throw on invalid event type", async () => {
      const { checkEventChannelExists } =
        await import("../../actions/stream/chat/event-channel.action");

      await expect(
        checkEventChannelExists("invalid" as any, "id-123"),
      ).rejects.toThrow();
    });

    it("should throw on empty event ID", async () => {
      const { checkEventChannelExists } =
        await import("../../actions/stream/chat/event-channel.action");

      await expect(checkEventChannelExists("webinar", "")).rejects.toThrow();
    });
  });

  describe("addUserToEventChannel", () => {
    it("should return early when user membership is cached", async () => {
      mockCache.getMembershipCached.mockReturnValue(true);

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await addUserToEventChannel(
        "webinar",
        "web-123",
        "user-456",
      );

      expect(result.success).toBe(true);
      expect(result.channelId).toBe("webinar-web-123");
      expect(mockStreamClient.channel).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "User already member (cached)",
        expect.any(Object),
      );
    });

    it("should add user to existing channel", async () => {
      mockCache.getMembershipCached.mockReturnValue(false);
      mockChannel.addMembers.mockResolvedValue({});

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await addUserToEventChannel(
        "consultation",
        "cons-123",
        "user-789",
      );

      expect(result.success).toBe(true);
      expect(result.channelId).toBe("consultation-cons-123");
      expect(mockChannel.addMembers).toHaveBeenCalledWith(["user-789"]);
      expect(mockCache.markMembership).toHaveBeenCalled();
    });

    it("adopts the winner's channel when creation loses the race (F-HIGH-3)", async () => {
      mockCache.getMembershipCached.mockReturnValue(false);
      // First addMembers miss → fall through to creation; second call is the
      // post-adoption membership retry against the winner's channel.
      mockChannel.addMembers
        .mockRejectedValueOnce(new Error("Channel not found"))
        .mockResolvedValueOnce({});
      const duplicateError = new Error(
        'GetOrCreateChannel failed: "channel already exists"',
      );
      mockChannel.create.mockRejectedValueOnce(duplicateError);

      mockPrisma.webinar.findUnique.mockResolvedValue({
        id: "web-race",
        webinarPlan: {
          title: "Raced Webinar",
          consultantProfile: { user: { id: "consultant-1" } },
        },
        appointment: {
          slotsOfAppointment: [{ user: [{ id: "user-3" }] }],
        },
      });

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await addUserToEventChannel(
        "webinar",
        "web-race",
        "raced-user",
      );

      expect(result.success).toBe(true);
      expect(mockChannel.addMembers).toHaveBeenCalledWith(["raced-user"]);
      expect(mockCache.markMembership).toHaveBeenCalledWith(
        "webinar-web-race",
        "raced-user",
        true,
      );
    });

    it("leaves membership UNCACHED when the post-adoption retry fails", async () => {
      mockCache.getMembershipCached.mockReturnValue(false);
      // First miss → creation attempt; adoption wins; then BOTH membership
      // attempts fail.
      mockChannel.addMembers
        .mockRejectedValueOnce(new Error("Channel not found"))
        .mockRejectedValueOnce(new Error("retry failed too"));
      mockChannel.create.mockRejectedValueOnce(
        new Error('GetOrCreateChannel failed: "channel already exists"'),
      );

      mockPrisma.webinar.findUnique.mockResolvedValue({
        id: "web-race-2",
        webinarPlan: {
          title: "Raced Webinar 2",
          consultantProfile: { user: { id: "consultant-1" } },
        },
        appointment: {
          slotsOfAppointment: [{ user: [{ id: "user-3" }] }],
        },
      });

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      // Still resolves — a failed join must not fail the caller; the next
      // sync reconciles.
      const result = await addUserToEventChannel(
        "webinar",
        "web-race-2",
        "unlucky-user",
      );
      expect(result.success).toBe(true);

      // But nothing may cache "is member": a cached true would suppress every
      // future add attempt until the TTL lapses.
      expect(mockCache.markMembership).not.toHaveBeenCalledWith(
        "webinar-web-race-2",
        "unlucky-user",
        true,
      );
    });

    it("should create new channel when addMembers fails and event exists", async () => {
      mockCache.getMembershipCached.mockReturnValue(false);
      mockChannel.addMembers.mockRejectedValue(new Error("Channel not found"));
      mockChannel.create.mockResolvedValue({});

      // Mock webinar data
      mockPrisma.webinar.findUnique.mockResolvedValue({
        id: "web-123",
        webinarPlan: {
          title: "Test Webinar",
          consultantProfile: {
            user: { id: "consultant-1" },
          },
        },
        appointment: {
          slotsOfAppointment: [{ user: [{ id: "user-3" }] }],
        },
      });

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await addUserToEventChannel(
        "webinar",
        "web-123",
        "new-user",
      );

      expect(result.success).toBe(true);
      expect(result.created).toBe(true);
      expect(mockChannel.create).toHaveBeenCalled();
      expect(mockCache.markChannelExists).toHaveBeenCalled();
    });

    it("should throw error when event not found", async () => {
      mockCache.getMembershipCached.mockReturnValue(false);
      mockChannel.addMembers.mockRejectedValue(new Error("Channel not found"));
      mockPrisma.webinar.findUnique.mockResolvedValue(null);

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      await expect(
        addUserToEventChannel("webinar", "nonexistent", "user-123"),
      ).rejects.toThrow("webinar not found: nonexistent");
    });

    it("should throw on empty user ID", async () => {
      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      await expect(
        addUserToEventChannel("webinar", "web-123", ""),
      ).rejects.toThrow();
    });

    it("should use messaging type for consultation", async () => {
      mockCache.getMembershipCached.mockReturnValue(false);
      mockChannel.addMembers.mockResolvedValue({});

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      await addUserToEventChannel("consultation", "cons-123", "user-123");

      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "messaging",
        "consultation-cons-123",
      );
    });

    it("should use messaging type for subscription", async () => {
      mockCache.getMembershipCached.mockReturnValue(false);
      mockChannel.addMembers.mockResolvedValue({});

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      await addUserToEventChannel("subscription", "sub-123", "user-123");

      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "messaging",
        "subscription-sub-123",
      );
    });
  });

  describe("getEventData via addUserToEventChannel", () => {
    beforeEach(() => {
      mockCache.getMembershipCached.mockReturnValue(false);
      mockChannel.addMembers.mockRejectedValue(new Error("Channel not found"));
      mockChannel.create.mockResolvedValue({});
    });

    it("should fetch class data with consultant and members", async () => {
      mockPrisma.class.findUnique.mockResolvedValue({
        id: "class-123",
        classPlan: {
          title: "Test Class",
          consultantProfile: {
            user: { id: "consultant-1" },
          },
        },
        appointments: [
          {
            slotsOfAppointment: [
              { user: [{ id: "user-2" }, { id: "user-3" }] },
            ],
          },
        ],
      });

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await addUserToEventChannel(
        "class",
        "class-123",
        "new-user",
      );

      expect(result.success).toBe(true);
      expect(mockPrisma.class.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "class-123" },
        }),
      );
    });

    it("should return null for class without consultant", async () => {
      mockPrisma.class.findUnique.mockResolvedValue({
        id: "class-123",
        classPlan: {
          title: "Test Class",
          consultantProfile: null,
        },
        appointments: [],
      });

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      await expect(
        addUserToEventChannel("class", "class-123", "user-123"),
      ).rejects.toThrow("class not found");
    });

    it("should fetch consultation data", async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue({
        id: "cons-123",
        consultationPlan: {
          title: "Test Consultation",
          consultantProfile: {
            user: { id: "consultant-1" },
          },
        },
        requestedBy: {
          user: { id: "consultee-1" },
        },
      });

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await addUserToEventChannel(
        "consultation",
        "cons-123",
        "new-user",
      );

      expect(result.success).toBe(true);
      expect(mockPrisma.consultation.findUnique).toHaveBeenCalled();
    });

    it("should return null for consultation without consultee", async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue({
        id: "cons-123",
        consultationPlan: {
          title: "Test Consultation",
          consultantProfile: {
            user: { id: "consultant-1" },
          },
        },
        requestedBy: null,
      });

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      await expect(
        addUserToEventChannel("consultation", "cons-123", "user-123"),
      ).rejects.toThrow("consultation not found");
    });

    it("should fetch subscription data", async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue({
        id: "sub-123",
        subscriptionPlan: {
          title: "Test Subscription",
          consultantProfile: {
            user: { id: "consultant-1" },
          },
        },
        requestedBy: {
          user: { id: "subscriber-1" },
        },
      });

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await addUserToEventChannel(
        "subscription",
        "sub-123",
        "new-user",
      );

      expect(result.success).toBe(true);
      expect(mockPrisma.subscription.findUnique).toHaveBeenCalled();
    });
  });

  describe("syncUserEventChannels", () => {
    it("should skip when user already synced", async () => {
      mockCache.initialSyncCompletedUsers.add("user-already-synced");

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await syncUserEventChannels("user-already-synced");

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(true);
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it("rejects syncing another user's channels as a non-privileged caller", async () => {
      mockGetSession.mockResolvedValue({
        user: { id: "attacker", role: "USER" },
      });

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      await expect(syncUserEventChannels("victim-user")).rejects.toThrow(
        "Forbidden: cannot sync channels for another user",
      );
      // The gate fires before ANY Stream/DB work happens.
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
      // And it reads the session with the cookie cache disabled, so a
      // just-demoted/banned identity cannot ride a stale cached session.
      expect(mockGetSession).toHaveBeenCalledWith(true);
    });

    it("rejects unauthenticated callers outright", async () => {
      mockGetSession.mockResolvedValue(null);

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      await expect(syncUserEventChannels("anyone")).rejects.toThrow(
        "Unauthorized: sign in to sync channels",
      );
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it("rejects a banned user even when syncing their own channels", async () => {
      mockGetSession.mockResolvedValue({
        user: { id: "banned-user", role: "USER", banned: true },
      });

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      await expect(syncUserEventChannels("banned-user")).rejects.toThrow(
        "Forbidden: account suspended",
      );
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it("should return error when user not found", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await syncUserEventChannels("nonexistent-user");

      expect(result.success).toBe(false);
      expect(result.error).toBe("User not found");
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "User not found for sync",
        expect.any(Object),
      );
    });

    it("should return success with 0 channels when user has no events", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: null,
        consulteeProfileId: "consultee-123",
      });
      mockPrisma.webinar.findMany.mockResolvedValue([]);
      mockPrisma.class.findMany.mockResolvedValue([]);
      mockPrisma.consultation.findMany.mockResolvedValue([]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await syncUserEventChannels("user-no-events");

      expect(result.success).toBe(true);
      expect(result.channelsSynced).toBe(0);
      expect(mockCache.initialSyncCompletedUsers.has("user-no-events")).toBe(
        true,
      );
    });

    it("should sync user to all their event channels", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: "consultant-123",
        consulteeProfileId: null,
      });

      // Mock consultant webinars
      mockPrisma.webinar.findMany.mockResolvedValue([
        { id: "webinar-1" },
        { id: "webinar-2" },
      ]);

      // Mock consultant classes
      mockPrisma.class.findMany.mockResolvedValue([{ id: "class-1" }]);

      // Mock consultations — include requestedBy so getDmPairsForUser can build the pair
      mockPrisma.consultation.findMany.mockResolvedValue([
        { id: "cons-1", requestedBy: { user: { id: "consultee-1" } } },
      ]);

      // Mock subscriptions
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      // Mock successful channel operations
      mockCache.getMembershipCached.mockReturnValue(false);
      mockChannel.addMembers.mockResolvedValue({});

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await syncUserEventChannels("consultant-user");

      expect(result.success).toBe(true);
      expect(result.channelsSynced).toBe(4); // 2 webinars + 1 class + 1 DM pair
      expect(result.durationMs).toBeDefined();
      expect(mockCache.initialSyncCompletedUsers.has("consultant-user")).toBe(
        true,
      );
    });

    // Was "should handle partial failures gracefully", asserting the add
    // pass's success/fail tally. That pass is gone: the sync no longer creates
    // or joins channels, it only removes memberships the user is no longer
    // entitled to. `POST /api/stream/channels/open` provisions on demand
    // instead, so the sync's unbounded per-pair Stream calls — which grew with
    // every COMPLETED booking, forever — are not paid on dashboard load.
    it("creates no channels — the add pass is retired", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: null,
        consulteeProfileId: "consultee-123",
      });

      mockPrisma.webinar.findMany.mockResolvedValue([]);
      mockPrisma.class.findMany.mockResolvedValue([]);
      // Two consultations with different consultants → two distinct DM pairs
      mockPrisma.consultation.findMany.mockResolvedValue([
        {
          id: "cons-1",
          consultationPlan: {
            consultantProfile: { user: { id: "consultant-a" } },
          },
        },
        {
          id: "cons-2",
          consultationPlan: {
            consultantProfile: { user: { id: "consultant-b" } },
          },
        },
      ]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);
      mockCache.getMembershipCached.mockReturnValue(false);

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await syncUserEventChannels("user-with-failures");

      expect(result.success).toBe(true);
      // Both pairs are still EXPECTED — that set drives the stale-removal pass
      // and must stay complete, or the reconciler evicts live conversations.
      expect(result.channelsSynced).toBe(2);
      // The point of the change: no Stream writes for those two pairs.
      expect(mockChannel.create).not.toHaveBeenCalled();
      expect(mockChannel.addMembers).not.toHaveBeenCalled();
    });

    it("should throw on invalid user ID", async () => {
      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      await expect(syncUserEventChannels("")).rejects.toThrow();
    });
  });

  describe("getWebinarIdsForUser", () => {
    it("should return hosted webinars for consultant", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: "consultant-123",
        consulteeProfileId: null,
      });
      mockPrisma.webinar.findMany.mockResolvedValue([
        { id: "webinar-1" },
        { id: "webinar-2" },
      ]);
      mockPrisma.class.findMany.mockResolvedValue([]);
      mockPrisma.consultation.findMany.mockResolvedValue([]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      mockCache.getMembershipCached.mockReturnValue(true); // Skip actual sync

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      await syncUserEventChannels("consultant-user");

      expect(mockPrisma.webinar.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            webinarPlan: { consultantProfileId: "consultant-123" },
          },
        }),
      );
    });

    it("should return attended webinars for consultee", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: null,
        consulteeProfileId: "consultee-123",
      });
      mockPrisma.webinar.findMany.mockResolvedValueOnce([
        { id: "appointment-webinar" },
      ]);
      mockPrisma.class.findMany.mockResolvedValue([]);
      mockPrisma.consultation.findMany.mockResolvedValue([]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      mockCache.getMembershipCached.mockReturnValue(true);

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      await syncUserEventChannels("consultee-user");

      // One query: webinars the consultee holds a slot on.
      expect(mockPrisma.webinar.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe("getClassIdsForUser", () => {
    it("should return hosted classes for consultant", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: "consultant-123",
        consulteeProfileId: null,
      });
      mockPrisma.webinar.findMany.mockResolvedValue([]);
      mockPrisma.class.findMany.mockResolvedValue([
        { id: "class-1" },
        { id: "class-2" },
      ]);
      mockPrisma.consultation.findMany.mockResolvedValue([]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      mockCache.getMembershipCached.mockReturnValue(true);

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      await syncUserEventChannels("consultant-user");

      expect(mockPrisma.class.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            classPlan: { consultantProfileId: "consultant-123" },
          },
        }),
      );
    });
  });

  describe("getConsultationIdsForUser", () => {
    it("should return consultations for user with both profiles", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: "consultant-123",
        consulteeProfileId: "consultee-123",
      });
      mockPrisma.webinar.findMany.mockResolvedValue([]);
      mockPrisma.class.findMany.mockResolvedValue([]);
      mockPrisma.consultation.findMany.mockResolvedValue([
        { id: "cons-1" },
        { id: "cons-2" },
      ]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      mockCache.getMembershipCached.mockReturnValue(true);

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      await syncUserEventChannels("dual-profile-user");

      expect(mockPrisma.consultation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            // Asserted against the shared constant, not a literal. These two
            // assertions are exactly what would have caught the divergence
            // that caused the bug — the reconciler pinned to a narrower set
            // than the search routes used — except that they pinned the
            // narrow side, so widening search sailed past them. Referencing
            // DM_ELIGIBLE_STATUSES means the two can no longer drift apart
            // without this failing.
            status: { in: [...DM_ELIGIBLE_STATUSES] },
          }),
        }),
      );
    });

    it("should return empty array when user has no profiles", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: null,
        consulteeProfileId: null,
      });
      mockPrisma.webinar.findMany.mockResolvedValue([]);
      mockPrisma.class.findMany.mockResolvedValue([]);
      mockPrisma.consultation.findMany.mockResolvedValue([]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      mockCache.getMembershipCached.mockReturnValue(true);

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await syncUserEventChannels("no-profile-user");

      expect(result.channelsSynced).toBe(0);
    });
  });

  describe("getSubscriptionIdsForUser", () => {
    it("should return subscriptions filtered by status", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: null,
        consulteeProfileId: "consultee-123",
      });
      mockPrisma.webinar.findMany.mockResolvedValue([]);
      mockPrisma.class.findMany.mockResolvedValue([]);
      mockPrisma.consultation.findMany.mockResolvedValue([]);
      mockPrisma.subscription.findMany.mockResolvedValue([
        { id: "sub-1" },
        { id: "sub-2" },
      ]);

      mockCache.getMembershipCached.mockReturnValue(true);

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      await syncUserEventChannels("subscribed-user");

      expect(mockPrisma.subscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            // Asserted against the shared constant, not a literal. These two
            // assertions are exactly what would have caught the divergence
            // that caused the bug — the reconciler pinned to a narrower set
            // than the search routes used — except that they pinned the
            // narrow side, so widening search sailed past them. Referencing
            // DM_ELIGIBLE_STATUSES means the two can no longer drift apart
            // without this failing.
            status: { in: [...DM_ELIGIBLE_STATUSES] },
          }),
        }),
      );
    });
  });

  // #1270 — Stream answers `queryChannels` with at most 30 rows regardless of
  // the `limit` passed. Both call sites paged with `while (page.length === 100)`
  // and therefore stopped after one page, so a user's 31st channel onwards was
  // invisible to reconciliation: a DM that should have been revoked was never
  // even looked at.
  describe("queryChannels pagination (#1270)", () => {
    /** Serve `total` channel ids, 30 at a time, exactly as Stream does. */
    const serveCappedPages = (total: number, idAt = (i: number) => `dm-${i}`) =>
      mockStreamClient.queryChannels.mockImplementation(
        async (
          _filter: unknown,
          _sort: unknown,
          opts: { limit: number; offset: number },
        ) => {
          const served = Math.min(opts.limit, 30);
          return Array.from({ length: total }, (_, i) => ({
            id: idAt(i),
            type: "messaging",
            data: {},
            state: { members: {} },
            removeMembers: jest.fn().mockResolvedValue({}),
          })).slice(opts.offset, opts.offset + served);
        },
      );

    it("revokes a stale DM sitting past the first page", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: null,
        consulteeProfileId: "consultee-123",
      });
      mockPrisma.webinar.findMany.mockResolvedValue([]);
      mockPrisma.class.findMany.mockResolvedValue([]);
      mockPrisma.consultation.findMany.mockResolvedValue([]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      // 41 memberships, none of them expected. The old walk saw the first 30.
      const removeMembers = jest.fn().mockResolvedValue({});
      mockStreamClient.queryChannels.mockImplementation(
        async (
          _filter: unknown,
          _sort: unknown,
          opts: { limit: number; offset: number },
        ) =>
          Array.from({ length: 41 }, (_, i) => ({
            id: `dm-stale-${i}`,
            removeMembers,
          })).slice(opts.offset, opts.offset + Math.min(opts.limit, 30)),
      );

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await syncUserEventChannels("leaky-user");

      // All 41, not 30. The eleven past the page boundary are the leak.
      expect(result.staleChannelsRemoved).toBe(41);
      expect(removeMembers).toHaveBeenCalledTimes(41);
    });

    it("sorts by created_at so offset paging is not walking a moving list", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: null,
        consulteeProfileId: "consultee-123",
      });
      mockPrisma.webinar.findMany.mockResolvedValue([]);
      mockPrisma.class.findMany.mockResolvedValue([]);
      mockPrisma.consultation.findMany.mockResolvedValue([]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);
      mockStreamClient.queryChannels.mockResolvedValue([]);

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      await syncUserEventChannels("sorted-user");

      // Stream's default sort is `last_message_at`, which changes underneath a
      // multi-page walk and can hide a channel entirely.
      expect(mockStreamClient.queryChannels).toHaveBeenCalledWith(
        { members: { $in: ["sorted-user"] } },
        { created_at: 1 },
        { limit: 30, offset: 0 },
      );
    });

    it("reports a partial reconcile instead of claiming a clean sweep", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: null,
        consulteeProfileId: "consultee-123",
      });
      mockPrisma.webinar.findMany.mockResolvedValue([]);
      mockPrisma.class.findMany.mockResolvedValue([]);
      mockPrisma.consultation.findMany.mockResolvedValue([]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);
      // More memberships than Stream's offset ceiling will ever serve.
      serveCappedPages(3000, (i) => `webinar-kept-${i}`);

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      await syncUserEventChannels("whale-user");

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("truncated"),
        expect.objectContaining({ userId: "whale-user" }),
      );
    });
  });

  // #1270 — `channel.create()` carries its roster in the request body and
  // Stream caps that at 100 members. `Webinar.maxParticipants` is unbounded, so
  // a 150-seat webinar's first attendee to open chat hit a rejected create and
  // got no chat at all.
  describe("oversized event rosters (#1270)", () => {
    const seatWebinar = (seats: number) => {
      mockPrisma.webinar.findUnique.mockResolvedValue({
        id: "web-big",
        webinarPlan: {
          title: "Sold Out Webinar",
          consultantProfile: { user: { id: "consultant-1" } },
        },
        appointment: {
          slotsOfAppointment: [
            {
              user: Array.from({ length: seats }, (_, i) => ({
                id: `attendee-${i}`,
              })),
            },
          ],
        },
      });
    };

    it("creates with 100 members and adds the rest in chunks", async () => {
      mockCache.getMembershipCached.mockReturnValue(false);
      // Miss on the existing-channel add, so we fall through to creation.
      mockChannel.addMembers.mockRejectedValueOnce(
        new Error("Channel not found"),
      );
      mockChannel.addMembers.mockResolvedValue({});
      seatWebinar(150);

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await addUserToEventChannel(
        "webinar",
        "web-big",
        "late-joiner",
      );

      expect(result.success).toBe(true);

      // The create() body must be within Stream's ceiling.
      const createData = mockStreamClient.channel.mock.calls.at(-1)?.[2] as {
        members: string[];
      };
      expect(createData.members).toHaveLength(100);

      // 152 unique members (host + joiner + 150 attendees) → 52 in follow-ups.
      const followUps = mockChannel.addMembers.mock.calls
        .slice(1)
        .map(([batch]: [string[]]) => batch);
      expect(followUps.map((b: string[]) => b.length)).toEqual([52]);
      expect([...createData.members, ...followUps.flat()]).toHaveLength(152);
    });

    it("puts the host and the joining attendee in the atomic create", async () => {
      mockCache.getMembershipCached.mockReturnValue(false);
      mockChannel.addMembers.mockRejectedValueOnce(
        new Error("Channel not found"),
      );
      mockChannel.addMembers.mockResolvedValue({});
      seatWebinar(400);

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      await addUserToEventChannel("webinar", "web-big", "late-joiner");

      const createData = mockStreamClient.channel.mock.calls.at(-1)?.[2] as {
        members: string[];
      };
      // Whoever triggered the create must not be the one stranded in a
      // follow-up request that can fail on its own.
      expect(createData.members.slice(0, 2)).toEqual([
        "consultant-1",
        "late-joiner",
      ]);
    });

    it("leaves an ordinary two-person roster on the single create call", async () => {
      mockCache.getMembershipCached.mockReturnValue(false);
      mockChannel.addMembers.mockRejectedValueOnce(
        new Error("Channel not found"),
      );
      mockChannel.addMembers.mockResolvedValue({});
      seatWebinar(1);

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      await addUserToEventChannel("webinar", "web-big", "attendee-0");

      // One failed probe, and no follow-up: chunking must not cost an extra
      // request on the shape every channel actually has.
      expect(mockChannel.addMembers).toHaveBeenCalledTimes(1);
    });
  });
});
