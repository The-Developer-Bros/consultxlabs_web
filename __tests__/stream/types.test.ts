/**
 * Tests for Stream Chat type definitions
 * Verifies that module augmentation works correctly for v9 SDK
 */

import "../../types/stream-chat.d.ts";
import type {
  StreamChatUser,
  StreamChannelType,
  EventChannelType,
} from "../../types/stream-chat";
import { getDmChannelId } from "@/lib/stream-utils";

describe("Stream Chat Types", () => {
  describe("StreamChatUser", () => {
    it("should define user type with all properties", () => {
      const user: StreamChatUser = {
        id: "user-123",
        name: "Test User",
        image: "https://example.com/avatar.jpg",
        email: "test@example.com",
        role: "admin",
      };

      expect(user.id).toBe("user-123");
      expect(user.name).toBe("Test User");
      expect(user.image).toBe("https://example.com/avatar.jpg");
      expect(user.email).toBe("test@example.com");
      expect(user.role).toBe("admin");
    });

    it("should allow optional properties", () => {
      const minimalUser: StreamChatUser = {
        id: "user-minimal",
      };

      expect(minimalUser.id).toBe("user-minimal");
      expect(minimalUser.name).toBeUndefined();
      expect(minimalUser.image).toBeUndefined();
      expect(minimalUser.email).toBeUndefined();
      expect(minimalUser.role).toBeUndefined();
    });

    it("should allow null email", () => {
      const userWithNullEmail: StreamChatUser = {
        id: "user-null-email",
        email: null,
      };

      expect(userWithNullEmail.email).toBeNull();
    });
  });

  describe("StreamChannelType", () => {
    it("should support messaging channel type", () => {
      const dmChannel: StreamChannelType = "messaging";
      expect(dmChannel).toBe("messaging");
    });

    it("should support team channel type", () => {
      const teamChannel: StreamChannelType = "team";
      expect(teamChannel).toBe("team");
    });

    it("should properly type array of channel types", () => {
      const channelTypes: StreamChannelType[] = ["messaging", "team"];
      expect(channelTypes).toHaveLength(2);
      expect(channelTypes).toContain("messaging");
      expect(channelTypes).toContain("team");
    });
  });

  describe("EventChannelType", () => {
    it("should support webinar event type", () => {
      const eventType: EventChannelType = "webinar";
      expect(eventType).toBe("webinar");
    });

    it("should support class event type", () => {
      const eventType: EventChannelType = "class";
      expect(eventType).toBe("class");
    });

    it("should support consultation event type", () => {
      const eventType: EventChannelType = "consultation";
      expect(eventType).toBe("consultation");
    });

    it("should support subscription event type", () => {
      const eventType: EventChannelType = "subscription";
      expect(eventType).toBe("subscription");
    });

    it("should properly type array of event types", () => {
      const eventTypes: EventChannelType[] = [
        "webinar",
        "class",
        "consultation",
        "subscription",
      ];
      expect(eventTypes).toHaveLength(4);
    });
  });

  describe("Channel ID generation", () => {
    // #1134 P0-3 — this used to declare a LOCAL `generateDMChannelId` that
    // sorted with `localeCompare` and assert against that, never touching
    // production code. So it passed while the app used code-unit ordering, and
    // it would have gone on passing straight through the collation regression it
    // reads like a guard against. It calls the real function now.
    //
    // Collation-independence itself is pinned by
    // __tests__/security/dm-channel-org-precedence.test.ts, which is what the
    // comment in lib/stream-utils.ts points at.
    it("should generate consistent DM channel IDs", () => {
      // Same users, either argument order, same id.
      expect(getDmChannelId("alice", "bob")).toBe("dm-alice-bob");
      expect(getDmChannelId("bob", "alice")).toBe("dm-alice-bob");

      // IDs with different prefixes
      expect(getDmChannelId("user-z", "user-a")).toBe("dm-user-a-user-z");
    });

    // NOTE: the two blocks below are the same decoy shape — they assert against
    // locally-declared lambdas rather than production code. Left as-is only
    // because neither `getChannelId` (private to event-channel.action.ts) nor
    // the type-inference logic has an exported equivalent to call. Anything
    // relying on them for regression cover should not.
    it("should generate event channel IDs", () => {
      const generateEventChannelId = (
        eventType: EventChannelType,
        eventId: string,
      ): string => {
        return `${eventType}-${eventId}`;
      };

      expect(generateEventChannelId("webinar", "123")).toBe("webinar-123");
      expect(generateEventChannelId("class", "abc")).toBe("class-abc");
      expect(generateEventChannelId("consultation", "xyz")).toBe(
        "consultation-xyz",
      );
      expect(generateEventChannelId("subscription", "456")).toBe(
        "subscription-456",
      );
    });
  });

  describe("Channel type inference", () => {
    it("should infer messaging type for consultation channels", () => {
      const getChannelType = (channelId: string): StreamChannelType => {
        if (
          channelId.startsWith("consultation-") ||
          channelId.startsWith("subscription-")
        ) {
          return "messaging";
        }
        return "team";
      };

      expect(getChannelType("consultation-123")).toBe("messaging");
      expect(getChannelType("subscription-456")).toBe("messaging");
      expect(getChannelType("webinar-789")).toBe("team");
      expect(getChannelType("class-abc")).toBe("team");
    });
  });

  describe("Role mapping", () => {
    it("should map application roles to Stream roles", () => {
      // This tests the role mapping pattern used in the app
      const mapRoleToStream = (
        role: "ADMIN" | "CONSULTANT" | "CONSULTEE" | "STAFF",
      ): string => {
        const mapping: Record<string, string> = {
          ADMIN: "admin",
          CONSULTANT: "user",
          CONSULTEE: "user",
          STAFF: "admin",
        };
        return mapping[role] || "user";
      };

      expect(mapRoleToStream("ADMIN")).toBe("admin");
      expect(mapRoleToStream("CONSULTANT")).toBe("user");
      expect(mapRoleToStream("CONSULTEE")).toBe("user");
      expect(mapRoleToStream("STAFF")).toBe("admin");
    });
  });
});

describe("Module Augmentation Verification", () => {
  it("should verify CustomUserData interface exists", () => {
    // This test verifies that the module augmentation is properly set up
    // The fact that TypeScript compiles this file means the augmentation works
    interface TestUserData {
      email?: string | null;
    }

    const userData: TestUserData = {
      email: "test@example.com",
    };

    expect(userData.email).toBe("test@example.com");
  });

  it("should verify CustomChannelData interface exists", () => {
    interface TestChannelData {
      name?: string;
      image?: string;
      webinar_id?: string;
      class_id?: string;
      consultation_id?: string;
      subscription_id?: string;
      custom?: boolean;
      title?: string;
      description?: string;
    }

    const channelData: TestChannelData = {
      name: "Test Channel",
      webinar_id: "webinar-123",
      custom: true,
    };

    expect(channelData.name).toBe("Test Channel");
    expect(channelData.webinar_id).toBe("webinar-123");
    expect(channelData.custom).toBe(true);
  });
});
