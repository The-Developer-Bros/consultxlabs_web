/**
 * Tests for Stream Chat user actions
 * Tests user upsert and search functionality for v9 SDK compatibility
 */

import {
  createMockPrisma,
  createMockUserClient,
  createMockLogger,
  createMockUserCache,
  createMockRoleMapper,
} from "./__mocks__/stream-mocks";

// Create mock instances
const mockPrisma = createMockPrisma();
const mockStreamClient = createMockUserClient();
const mockLogger = createMockLogger();
const mockUserCache = createMockUserCache();
const mockRoleMapper = createMockRoleMapper();

// Mock dependencies using relative paths
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: mockPrisma,
}));

jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: jest.fn(() => mockStreamClient),
  // #473 — pass-through breaker (closed-state behaviour) so the upsert
  // assertions exercise the real Stream client mock unchanged.
  withStreamCircuitBreaker: jest.fn((op: () => unknown) => op()),
  StreamUnavailableError: class StreamUnavailableError extends Error {},
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: mockLogger,
}));

jest.mock("../../lib/stream-cache", () => mockUserCache);

// searchUsersWithRelationships is session-scoped; identity comes from the
// mocked session ("current-user"), not from a client-supplied parameter.
const mockGetSession = jest.fn();
jest.mock("../../lib/auth-server", () => ({
  getSession: (disableCookieCache?: boolean) =>
    mockGetSession(disableCookieCache),
}));

jest.mock("../../lib/user", () => mockRoleMapper);

describe("User Actions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStreamClient.upsertUser.mockReset();
    mockStreamClient.upsertUsers.mockReset();
    mockUserCache.isUserSynced.mockReturnValue(false);
    mockGetSession.mockResolvedValue({
      user: { id: "current-user", role: "CONSULTANT" },
    });
  });

  describe("upsertUserToStream", () => {
    it("should upsert a user to Stream Chat", async () => {
      const mockUser = {
        id: "user-123",
        name: "Test User",
        email: "test@example.com",
        image: "https://example.com/avatar.jpg",
        role: "CONSULTANT",
      };

      mockUserCache.isUserSynced.mockReturnValue(false);
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockStreamClient.upsertUser.mockResolvedValue({
        users: { [mockUser.id]: mockUser },
      });

      const { upsertUserToStream } =
        await import("../../actions/stream/chat/user.action");

      await upsertUserToStream("user-123");

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: "user-123" },
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          role: true,
        },
      });

      expect(mockStreamClient.upsertUser).toHaveBeenCalledWith({
        id: "user-123",
        name: "Test User",
        email: "test@example.com",
        image: "https://example.com/avatar.jpg",
        role: "user",
      });

      expect(mockUserCache.markUserSynced).toHaveBeenCalledWith("user-123");
    });

    it("should skip upsert if user is recently synced", async () => {
      mockUserCache.isUserSynced.mockReturnValue(true);

      const { upsertUserToStream } =
        await import("../../actions/stream/chat/user.action");

      const result = await upsertUserToStream("user-123");

      expect(result).toBeNull();
      expect(mockStreamClient.upsertUser).not.toHaveBeenCalled();
    });

    it("should throw error for non-existent user", async () => {
      mockUserCache.isUserSynced.mockReturnValue(false);
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const { upsertUserToStream } =
        await import("../../actions/stream/chat/user.action");

      await expect(upsertUserToStream("nonexistent")).rejects.toThrow(
        "User not found: nonexistent",
      );
    });

    it("should use user ID as name fallback", async () => {
      const mockUser = {
        id: "user-456",
        name: null,
        email: "noname@example.com",
        image: null,
        role: "CONSULTEE",
      };

      mockUserCache.isUserSynced.mockReturnValue(false);
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockStreamClient.upsertUser.mockResolvedValue({ users: {} });

      const { upsertUserToStream } =
        await import("../../actions/stream/chat/user.action");

      await upsertUserToStream("user-456");

      expect(mockStreamClient.upsertUser).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "user-456",
          name: "user-456",
          image: undefined,
        }),
      );
    });

    it("should reject empty user ID", async () => {
      const { upsertUserToStream } =
        await import("../../actions/stream/chat/user.action");

      await expect(upsertUserToStream("")).rejects.toThrow();
    });
  });

  describe("upsertUsersToStream", () => {
    it("should batch upsert multiple users", async () => {
      const mockUsers = [
        {
          id: "user-1",
          name: "User 1",
          email: "u1@test.com",
          image: null,
          role: "CONSULTANT",
        },
        {
          id: "user-2",
          name: "User 2",
          email: "u2@test.com",
          image: null,
          role: "CONSULTEE",
        },
      ];

      mockUserCache.isUserSynced.mockReturnValue(false);
      mockPrisma.user.findMany.mockResolvedValue(mockUsers);
      mockStreamClient.upsertUsers.mockResolvedValue({ users: {} });

      const { upsertUsersToStream } =
        await import("../../actions/stream/chat/user.action");

      await upsertUsersToStream(["user-1", "user-2"]);

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
        where: { id: { in: ["user-1", "user-2"] } },
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          role: true,
        },
      });

      expect(mockStreamClient.upsertUsers).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: "user-1" }),
          expect.objectContaining({ id: "user-2" }),
        ]),
      );

      expect(mockUserCache.markUserSynced).toHaveBeenCalledTimes(2);
    });

    it("should skip already synced users", async () => {
      mockUserCache.isUserSynced.mockReturnValue(true);

      const { upsertUsersToStream } =
        await import("../../actions/stream/chat/user.action");

      const result = await upsertUsersToStream(["user-1", "user-2"]);

      expect(result).toEqual({ users: {} });
      expect(mockStreamClient.upsertUsers).not.toHaveBeenCalled();
    });

    it("should reject empty users array", async () => {
      const { upsertUsersToStream } =
        await import("../../actions/stream/chat/user.action");

      await expect(upsertUsersToStream([])).rejects.toThrow();
    });
  });

  describe("upsertUsersToStream error paths", () => {
    it("should return empty result when no users found for unsynced IDs", async () => {
      mockUserCache.isUserSynced.mockReturnValue(false);
      mockPrisma.user.findMany.mockResolvedValue([]);

      const { upsertUsersToStream } =
        await import("../../actions/stream/chat/user.action");

      const result = await upsertUsersToStream([
        "nonexistent-1",
        "nonexistent-2",
      ]);

      expect(result).toEqual({ users: {} });
      expect(mockStreamClient.upsertUsers).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "No users found for batch upsert",
        expect.objectContaining({
          requestedIds: ["nonexistent-1", "nonexistent-2"],
        }),
      );
    });

    it("should throw and log error when Stream API fails", async () => {
      mockUserCache.isUserSynced.mockReturnValue(false);
      mockPrisma.user.findMany.mockResolvedValue([
        {
          id: "user-1",
          name: "User 1",
          email: "u1@test.com",
          image: null,
          role: "CONSULTANT",
        },
      ]);
      mockStreamClient.upsertUsers.mockRejectedValue(
        new Error("Stream API error"),
      );

      const { upsertUsersToStream } =
        await import("../../actions/stream/chat/user.action");

      await expect(upsertUsersToStream(["user-1"])).rejects.toThrow(
        "Stream API error",
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Failed to batch upsert users to Stream",
        expect.any(Error),
        expect.objectContaining({ userCount: 1 }),
      );
    });
  });

  describe("searchUsersWithRelationships", () => {
    it("should search users and include relationship status", async () => {
      const mockUsers = [
        {
          id: "user-1",
          name: "Alice",
          email: "alice@test.com",
          image: null,
          role: "CONSULTANT",
          consultantProfileId: "cp-1",
          consulteeProfileId: null,
        },
        {
          id: "user-2",
          name: "Bob",
          email: "bob@test.com",
          image: null,
          role: "CONSULTEE",
          consultantProfileId: null,
          consulteeProfileId: "ce-1",
        },
      ];

      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: "cp-current",
        consulteeProfileId: null,
      });
      mockPrisma.user.findMany.mockResolvedValueOnce(mockUsers);
      // Mock batched relationship queries (findMany + .then())
      mockPrisma.consultation.findMany.mockResolvedValue([]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);
      mockPrisma.slotOfAppointment.findMany.mockResolvedValue([]);

      const { searchUsersWithRelationships } =
        await import("../../actions/stream/chat/user.action");

      const results = await searchUsersWithRelationships("test");

      // Filtered, not ranked. Both matches are unrelated to the caller, so
      // neither is returned — previously both came back with
      // `hasRelationship: false`, which made this endpoint a directory of the
      // whole user base behind a two-character query.
      expect(results).toHaveLength(0);
    });

    it("should exclude current user from results", async () => {
      mockPrisma.user.findMany.mockResolvedValueOnce([]);

      const { searchUsersWithRelationships } =
        await import("../../actions/stream/chat/user.action");

      await searchUsersWithRelationships("test");

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([{ id: { not: "current-user" } }]),
          }),
        }),
      );
    });

    it("should sort by relationship status (connected first)", async () => {
      const mockUsers = [
        {
          id: "user-no-rel",
          name: "Zara",
          email: "zara@test.com",
          image: null,
          role: "CONSULTEE",
          consultantProfileId: null,
          consulteeProfileId: "ce-1",
        },
        {
          id: "user-with-rel",
          name: "Adam",
          email: "adam@test.com",
          image: null,
          role: "CONSULTANT",
          consultantProfileId: "cp-1",
          consulteeProfileId: null,
        },
      ];

      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: "cp-current",
        consulteeProfileId: "ce-current",
      });
      mockPrisma.user.findMany.mockResolvedValueOnce(mockUsers);
      // Batched consultation query returns a match for user-with-rel (consultant cp-1)
      mockPrisma.consultation.findMany.mockResolvedValue([
        {
          consultationPlan: {
            consultantProfile: { user: { id: "user-with-rel" } },
          },
        },
      ]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);
      mockPrisma.slotOfAppointment.findMany.mockResolvedValue([]);

      const { searchUsersWithRelationships } =
        await import("../../actions/stream/chat/user.action");

      const results = await searchUsersWithRelationships("test");

      // Only the connected user survives the filter.
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("user-with-rel");
      expect(results[0].hasRelationship).toBe(true);
    });

    it("should throw and log error on failure", async () => {
      mockPrisma.user.findMany.mockRejectedValue(new Error("DB failure"));

      const { searchUsersWithRelationships } =
        await import("../../actions/stream/chat/user.action");

      await expect(
        searchUsersWithRelationships("test"),
      ).rejects.toThrow("DB failure");

      expect(mockLogger.error).toHaveBeenCalledWith(
        "User search failed",
        expect.any(Error),
        expect.objectContaining({ searchTerm: "test" }),
      );
    });

    it("should reject empty search term", async () => {
      const { searchUsersWithRelationships } =
        await import("../../actions/stream/chat/user.action");

      await expect(searchUsersWithRelationships("")).rejects.toThrow();
    });
  });
});