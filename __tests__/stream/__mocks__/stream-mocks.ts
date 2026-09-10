/**
 * Shared mock objects for Stream SDK tests
 * This centralizes mock definitions to avoid duplication and TypeScript conflicts
 */

// Prisma mock
export const createMockPrisma = () => ({
  user: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  webinar: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  class: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  consultation: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  subscription: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  slotOfAppointment: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  // Why: the Stream upsert pipeline calls `checkConsent` (lib/compliance/dpdp.ts)
  // before mirroring identity into Stream.io. Without a `consentArtifact` delegate
  // on the mock, the helper crashes with `TypeError: Cannot read properties of
  // undefined (reading 'findFirst')`. Default to a truthy artifact so existing
  // happy-path tests treat the user as consenting; tests that exercise the
  // "no consent" branch override `findFirst` to resolve `null`.
  consentArtifact: {
    findFirst: jest.fn().mockResolvedValue({ id: "consent-1" }),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    count: jest.fn().mockResolvedValue(0),
  },
});

// Stream Chat client mock for channel operations
export const createMockChannelClient = () => ({
  channel: jest.fn(),
  queryChannels: jest.fn(),
});

// Stream Chat client mock for user operations
export const createMockUserClient = () => ({
  upsertUser: jest.fn(),
  upsertUsers: jest.fn(),
});

// Channel mock object
export const createMockChannel = () => ({
  create: jest.fn().mockResolvedValue({}),
  query: jest.fn().mockResolvedValue({ members: {} }),
  addMembers: jest.fn().mockResolvedValue({}),
  // #899/F-HIGH-3 — creators attempt a channel-scoped moderator grant on the
  // post-create path; present so adoption/grant assertions can inspect calls.
  assignRoles: jest.fn().mockResolvedValue({}),
  id: "test-channel",
  type: "team",
  data: { name: "Test Channel" },
  state: { members: {} },
});

// Stream logger mock
export const createMockLogger = () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

// Stream cache mock for channels
export const createMockChannelCache = () => ({
  markChannelExists: jest.fn(),
  isChannelCached: jest.fn(),
  getMembershipCached: jest.fn(),
  markMembership: jest.fn(),
  initialSyncCompletedUsers: new Set<string>(),
});

// Stream cache mock for users
export const createMockUserCache = () => ({
  markUserSynced: jest.fn(),
  isUserSynced: jest.fn().mockReturnValue(false),
});

// Role mapper mock
export const createMockRoleMapper = () => ({
  mapRoleToStream: jest.fn().mockImplementation((role: string) => {
    const mapping: Record<string, string> = {
      ADMIN: "admin",
      CONSULTANT: "user",
      CONSULTEE: "user",
      STAFF: "admin",
    };
    return mapping[role] || "user";
  }),
});
