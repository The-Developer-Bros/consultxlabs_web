/**
 * @jest-environment node
 */

/**
 * #1270 — a moderation action whose Stream write failed was never retried.
 *
 * The failure was recorded in `ModerationAction.sideEffects` and left there:
 * the action route's 409 idempotency guard, which is what stops a double
 * refund, also blocks the only path that could have re-run the Stream step. So
 * a ban taken while Stream was down stayed unenforced on Stream until somebody
 * happened to read the JSON.
 *
 * The sweep drains exactly the rows whose recorded outcome says "failed". What
 * it must never do is re-enforce a ban that has since been lifted.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    moderationAction: {
      findMany: jest.fn(async () => []),
      update: jest.fn(async () => ({})),
    },
    user: {
      findUnique: jest.fn(async () => ({ banned: true, banExpires: null })),
    },
    $disconnect: jest.fn(async () => undefined),
  },
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  withCronLock: jest.fn(
    (_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
  ),
  CronLockHeldError: class extends Error {},
}));

jest.mock("../../lib/moderation/side-effects", () => ({
  __esModule: true,
  applyStreamEnforcement: jest.fn(async () => undefined),
  restoreStreamAccess: jest.fn(async () => undefined),
  streamErrorPrefix: (actionType: string) =>
    actionType === "CONTENT_REMOVED" ? "message-delete" : "stream",
}));

import { retryModerationEnforcement } from "../../scripts/cleanup/retry-moderation-enforcement";
import prisma from "../../lib/prisma";
import { applyStreamEnforcement } from "../../lib/moderation/side-effects";

const findMany = prisma.moderationAction.findMany as jest.Mock;
const update = prisma.moderationAction.update as jest.Mock;
const findUser = prisma.user.findUnique as jest.Mock;
const enforce = applyStreamEnforcement as jest.Mock;

const failedBan = (overrides: Record<string, unknown> = {}) => ({
  id: "action-1",
  actionType: "USER_BANNED",
  createdAt: new Date(),
  sideEffects: {
    stream: "failed",
    streamAttempts: 1,
    errors: ["stream: down"],
  },
  report: {
    id: "r1",
    targetUserId: "u1",
    reviewId: null,
    streamMessageId: null,
  },
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  findUser.mockResolvedValue({ banned: true, banExpires: null });
  enforce.mockResolvedValue(undefined);
});

describe("retryModerationEnforcement", () => {
  it("selects only the actions whose recorded Stream outcome failed", async () => {
    await retryModerationEnforcement();

    expect(findMany.mock.calls[0][0].where).toMatchObject({
      sideEffects: { path: ["stream"], equals: "failed" },
    });
  });

  it("re-drives the ban and records that it landed", async () => {
    findMany.mockResolvedValueOnce([failedBan()]);

    const result = await retryModerationEnforcement();

    expect(enforce).toHaveBeenCalledWith(
      "USER_BANNED",
      expect.objectContaining({ targetUserId: "u1" }),
    );
    expect(update.mock.calls[0][0].data.sideEffects).toMatchObject({
      stream: "ok",
      streamAttempts: 2,
    });
    expect(result.recovered).toBe(1);
  });

  it("never re-enforces a ban that was lifted while the retry was owed", async () => {
    findMany.mockResolvedValueOnce([failedBan()]);
    findUser.mockResolvedValue({ banned: false, banExpires: null });

    const result = await retryModerationEnforcement();

    expect(enforce).not.toHaveBeenCalled();
    expect(update.mock.calls[0][0].data.sideEffects.stream).toBe("skipped");
    expect(result.skipped).toBe(1);
  });

  it("treats an expired suspension as no longer enforceable", async () => {
    findMany.mockResolvedValueOnce([
      failedBan({ actionType: "USER_SUSPENDED" }),
    ]);
    findUser.mockResolvedValue({
      banned: true,
      banExpires: new Date(Date.now() - 60_000),
    });

    const result = await retryModerationEnforcement();

    expect(enforce).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("keeps the row queued and counts the attempt when the retry fails too", async () => {
    findMany.mockResolvedValueOnce([failedBan()]);
    enforce.mockRejectedValueOnce(new Error("still down"));

    const result = await retryModerationEnforcement();

    const written = update.mock.calls[0][0].data.sideEffects;
    expect(written.stream).toBe("failed");
    expect(written.streamAttempts).toBe(2);
    expect(written.errors).toHaveLength(2);
    expect(result.stillFailing).toBe(1);
  });

  it("gives up terminally once the attempt budget is spent", async () => {
    findMany.mockResolvedValueOnce([
      failedBan({
        sideEffects: { stream: "failed", streamAttempts: 6 },
      }),
    ]);

    const result = await retryModerationEnforcement({ maxAttempts: 6 });

    expect(enforce).not.toHaveBeenCalled();
    // A different value, so a capped row drops out of the selector by
    // construction rather than by a negated JSON filter.
    expect(update.mock.calls[0][0].data.sideEffects.stream).toBe("gave_up");
    expect(result.gaveUp).toBe(1);
  });

  it("gives up on a row too old for a retry to mean anything", async () => {
    findMany.mockResolvedValueOnce([
      failedBan({ createdAt: new Date(Date.now() - 100 * 3_600_000) }),
    ]);

    const result = await retryModerationEnforcement({ giveUpAfterHours: 72 });

    expect(result.gaveUp).toBe(1);
    expect(enforce).not.toHaveBeenCalled();
  });

  it("re-drives the message delete for a CONTENT_REMOVED action", async () => {
    findMany.mockResolvedValueOnce([
      failedBan({
        actionType: "CONTENT_REMOVED",
        report: {
          id: "r2",
          targetUserId: "u1",
          reviewId: null,
          streamMessageId: "msg-1",
          streamChannelCid: "messaging:chan-1",
        },
      }),
    ]);

    const result = await retryModerationEnforcement();

    expect(enforce).toHaveBeenCalledWith(
      "CONTENT_REMOVED",
      expect.objectContaining({
          streamMessageId: "msg-1",
          // The cid travels with the id — the delete needs both, and asserting
          // only the id passed while the sweep forwarded neither.
          streamChannelCid: "messaging:chan-1",
        }),
    );
    // The ban state is irrelevant to a message delete, so it is not consulted.
    expect(findUser).not.toHaveBeenCalled();
    expect(result.recovered).toBe(1);
  });
});
