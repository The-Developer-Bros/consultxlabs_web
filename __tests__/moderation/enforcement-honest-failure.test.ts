/**
 * @jest-environment node
 */

/**
 * #1270 — the two lies the moderation side-effects used to tell.
 *
 * The first is a ban that never reaches Stream. The database says banned, the
 * sessions are gone, the appointments are cancelled and refunded, and the
 * target's existing chat token keeps working for up to an hour — while the
 * summary handed back to the moderator said nothing about it.
 *
 * The second is CONTENT_REMOVED on a chat message. It was routed to the review
 * soft-delete, which returns `{}` when `reviewId` is null, and `reviewId` is
 * always null for a MESSAGE report: the report flipped to ACTION_TAKEN and the
 * message stayed in the channel.
 */

const chat = {
  revokeUserToken: jest.fn(async () => undefined),
  deactivateUser: jest.fn(async () => undefined),
  deleteMessage: jest.fn(async () => undefined),
};

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    moderationAction: { update: jest.fn(async () => ({})) },
  },
}));

jest.mock("../../lib/stream-client", () => ({
  __esModule: true,
  getStreamChatClient: jest.fn(() => chat),
  withStreamCircuitBreaker: jest.fn(async (op: () => Promise<unknown>) => op()),
  // Mirrors the real predicate: a 404 means Stream answered, not that it is down.
  isExpectedStreamError: jest.fn(
    (e: unknown) => (e as { status?: number } | null)?.status === 404,
  ),
}));

jest.mock("../../lib/novu", () => ({
  notifyModerationWarning: jest.fn(async () => ({ success: true })),
  notifyAccountSuspended: jest.fn(async () => ({ success: true })),
  notifyAccountBanned: jest.fn(async () => ({ success: true })),
  notifyVerificationStatusChanged: jest.fn(async () => ({ success: true })),
}));

jest.mock("../../lib/moderation/cancel-user-engagements", () => ({
  __esModule: true,
  cancelFutureEngagementsForUser: jest.fn(async () => ({
    engagementsCancelled: 0,
    attendeeRemovals: 0,
    refundsIssued: 0,
    refundedPaise: 0,
    failures: [],
    remaining: [],
  })),
}));

import { applyBestEffortEffects } from "../../lib/moderation/side-effects";

const banInput = {
  actionType: "USER_BANNED" as const,
  report: { id: "r1", targetUserId: "u1", reviewId: null },
  staffUserId: "admin-1",
};

const removeMessageInput = {
  actionType: "CONTENT_REMOVED" as const,
  report: {
    id: "r2",
    targetUserId: "u1",
    reviewId: null,
    streamMessageId: "msg-1",
  },
  staffUserId: "admin-1",
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("Stream enforcement reports its own failure", () => {
  it("marks the ban's Stream step failed and names it in errors", async () => {
    chat.revokeUserToken.mockRejectedValueOnce(new Error("Stream is down"));

    const summary = await applyBestEffortEffects(banInput, {});

    expect(summary.stream).toBe("failed");
    expect(summary.streamAttempts).toBe(1);
    expect(summary.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("stream: Stream is down"),
      ]),
    );
  });

  it("marks it ok when revoke and deactivate both land", async () => {
    const summary = await applyBestEffortEffects(banInput, {});

    expect(chat.revokeUserToken).toHaveBeenCalledWith("u1", expect.any(Date));
    expect(chat.deactivateUser).toHaveBeenCalledWith("u1", {
      mark_messages_deleted: false,
    });
    expect(summary.stream).toBe("ok");
    expect(summary.errors).toBeUndefined();
  });
});

describe("CONTENT_REMOVED on a chat message", () => {
  it("deletes the reported message on Stream", async () => {
    const summary = await applyBestEffortEffects(removeMessageInput, {});

    expect(chat.deleteMessage).toHaveBeenCalledWith("msg-1");
    expect(summary.stream).toBe("ok");
  });

  it("reports the failure when the delete does not land", async () => {
    chat.deleteMessage.mockRejectedValueOnce(new Error("timeout"));

    const summary = await applyBestEffortEffects(removeMessageInput, {});

    expect(summary.stream).toBe("failed");
    expect(summary.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("message-delete: timeout"),
      ]),
    );
  });

  it("treats an already-gone message as success, not as a failure", async () => {
    chat.deleteMessage.mockRejectedValueOnce(
      Object.assign(new Error("message does not exist"), { status: 404 }),
    );

    const summary = await applyBestEffortEffects(removeMessageInput, {});

    expect(summary.stream).toBe("ok");
  });

  it("does not call Stream for a review report, which has no message", async () => {
    const summary = await applyBestEffortEffects(
      {
        actionType: "CONTENT_REMOVED" as const,
        report: { id: "r3", targetUserId: "u1", reviewId: "review-1" },
        staffUserId: "admin-1",
      },
      { reviewRemoved: true },
    );

    expect(chat.deleteMessage).not.toHaveBeenCalled();
    expect(summary.stream).toBeUndefined();
  });
});
