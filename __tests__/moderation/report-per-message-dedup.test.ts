/**
 * @jest-environment node
 */

/**
 * #1270 — message reports used to collapse per user instead of per message.
 *
 * The aggregation key was `(targetUserId, type, reviewId, status)`, and a
 * MESSAGE report always has a null `reviewId`. So the first message anyone
 * reported against a given author opened a row, and every later report about a
 * different message from the same author only incremented that row's counter
 * and threw its own excerpt away — a moderator reviewing report number twelve
 * was reading message number one.
 *
 * The store below evaluates the route's real WHERE clause against in-memory
 * rows, so the scoping decision itself is what is under test rather than a
 * restatement of it.
 */

interface Row {
  id: string;
  reportedById: string;
  targetUserId: string;
  type: string;
  reviewId: string | null;
  streamMessageId: string | null;
  contentText: string | null;
  reportCount: number;
  status: string;
}

const rows: Row[] = [];

const matches = (row: Row, where: Record<string, unknown>): boolean => {
  if (where.reportedById && row.reportedById !== where.reportedById) {
    return false;
  }
  if (row.targetUserId !== where.targetUserId) return false;
  if (row.type !== where.type) return false;
  if ("reviewId" in where && row.reviewId !== where.reviewId) return false;
  if (
    "streamMessageId" in where &&
    row.streamMessageId !== where.streamMessageId
  ) {
    return false;
  }
  const status = where.status as { in: string[] } | undefined;
  return status ? status.in.includes(row.status) : true;
};

type FindFirstArgs = { where: Record<string, unknown> };
type UpdateArgs = {
  where: { id: string };
  data: { reportCount?: { increment: number }; contentText?: string };
};
type CreateArgs = { data: Partial<Row> & { reportedById: string } };

const findFirst = jest.fn(
  async ({ where }: FindFirstArgs) =>
    rows.find((row) => matches(row, where)) ?? null,
);
const update = jest.fn(async ({ where, data }: UpdateArgs) => {
  const row = rows.find((r) => r.id === where.id)!;
  if (data.reportCount?.increment) {
    row.reportCount += data.reportCount.increment;
  }
  if (typeof data.contentText === "string") row.contentText = data.contentText;
  return row;
});
const create = jest.fn(async ({ data }: CreateArgs) => {
  const row: Row = {
    id: `r${rows.length + 1}`,
    reportedById: data.reportedById,
    targetUserId: data.targetUserId!,
    type: data.type!,
    reviewId: data.reviewId ?? null,
    streamMessageId: data.streamMessageId ?? null,
    contentText: data.contentText ?? null,
    reportCount: 1,
    status: "PENDING",
  };
  rows.push(row);
  return row;
});

const mockGetMessage = jest.fn();

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

// #1270 — the report route verifies a reported message against Stream now, so
// its module graph reaches the ESM-only node SDK. Mocked for the same reason
// every other suite in this repo mocks it.
jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: () => ({ getMessage: mockGetMessage }),
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    // Referenced lazily: jest.mock is hoisted above the const declarations
    // below, so naming them directly here is a temporal-dead-zone error.
    moderationReport: {
      findFirst: (args: FindFirstArgs) => findFirst(args),
      update: (args: UpdateArgs) => update(args),
      create: (args: CreateArgs) => create(args),
    },
    user: { findUnique: jest.fn(async () => ({ id: "target-1" })) },
  },
}));

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(async () => ({ user: { id: "reporter-1" } })),
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  spamLimiter: {},
  applyRateLimit: jest.fn(async () => null),
}));

import { POST } from "../../app/api/report/route";
import { getSession } from "../../lib/auth-server";

const post = (body: Record<string, unknown>) =>
  POST(
    new Request("http://localhost/api/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );

const messageReport = (overrides: Record<string, unknown> = {}) => ({
  type: "MESSAGE",
  reason: "Reported message",
  targetUserId: "target-1",
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  rows.length = 0;
  (getSession as jest.Mock).mockResolvedValue({ user: { id: "reporter-1" } });
  // #1270 — the route resolves the reported message against Stream and requires
  // its author to be the reported user. These fixtures report `target-1`, so
  // Stream answers with a message they wrote.
  mockGetMessage.mockImplementation(async (id: string) => ({
    message: { id, cid: "messaging:chan-1", user: { id: "target-1" } },
  }));
});

describe("POST /api/report — message reports aggregate per message", () => {
  it("opens a separate report for a different message from the same author", async () => {
    await post(
      messageReport({ streamMessageId: "msg-1", contentText: "first abuse" }),
    );
    (getSession as jest.Mock).mockResolvedValue({ user: { id: "reporter-2" } });
    await post(
      messageReport({ streamMessageId: "msg-2", contentText: "second abuse" }),
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect(rows.map((r) => r.contentText)).toEqual([
      "first abuse",
      "second abuse",
    ]);
  });

  it("aggregates a second reporter onto the same message", async () => {
    await post(
      messageReport({ streamMessageId: "msg-1", contentText: "abuse" }),
    );
    (getSession as jest.Mock).mockResolvedValue({ user: { id: "reporter-2" } });
    const res = await post(messageReport({ streamMessageId: "msg-1" }));

    expect(await res.json()).toMatchObject({ aggregated: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(rows[0].reportCount).toBe(2);
  });

  it("still refuses a second report of the same message by the same reporter", async () => {
    await post(messageReport({ streamMessageId: "msg-1" }));
    const res = await post(messageReport({ streamMessageId: "msg-1" }));

    expect(res.status).toBe(400);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("persists the message identity so CONTENT_REMOVED has something to delete", async () => {
    await post(
      messageReport({
        streamMessageId: "msg-1",
        // #1270 review — deliberately WRONG, and deliberately ignored. The cid
        // stored is Stream's, not the caller's.
        streamChannelCid: "messaging:dm-1",
      }),
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          streamMessageId: "msg-1",
          streamChannelCid: "messaging:chan-1",
        }),
      }),
    );
  });

  it("refuses to store a message the reported user did not write", async () => {
    // The vulnerability, pinned. `CONTENT_REMOVED` forwards the stored id to
    // Stream's server-side delete, so accepting a caller's word for whose
    // message it is let a reporter have an arbitrary message deleted, using a
    // staff moderator as the instrument.
    mockGetMessage.mockResolvedValue({
      message: {
        id: "msg-1",
        cid: "messaging:chan-1",
        user: { id: "somebody-else" },
      },
    });

    const res = await post(messageReport({ streamMessageId: "msg-1" }));

    // The report is still accepted — a human should read it — but it carries no
    // message identity, so no enforcement can act on the wrong message.
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          streamMessageId: null,
          streamChannelCid: null,
        }),
      }),
    );
  });

  it("stores no message identity when Stream cannot be reached", async () => {
    // Degrades to the pre-#1270 behaviour rather than refusing the report: a
    // reporter should not be blocked because Stream is briefly unavailable.
    mockGetMessage.mockRejectedValue(new Error("stream is down"));

    const res = await post(messageReport({ streamMessageId: "msg-1" }));

    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ streamMessageId: null }),
      }),
    );
  });

  it("backfills a missing excerpt when a later reporter supplies one", async () => {
    await post(messageReport({ streamMessageId: "msg-1" }));
    (getSession as jest.Mock).mockResolvedValue({ user: { id: "reporter-2" } });
    await post(
      messageReport({ streamMessageId: "msg-1", contentText: "the text" }),
    );

    expect(rows[0].contentText).toBe("the text");
  });

  it("keeps the per-user collapse for a message report that carries no id", async () => {
    await post(messageReport({ contentText: "legacy client" }));
    (getSession as jest.Mock).mockResolvedValue({ user: { id: "reporter-2" } });
    await post(messageReport({ contentText: "another one" }));

    expect(create).toHaveBeenCalledTimes(1);
    expect(rows[0].reportCount).toBe(2);
  });

  it("scopes a review report on the review, not on a message id", async () => {
    await post({
      type: "REVIEW",
      reason: "Fake review",
      targetUserId: "target-1",
      reviewId: "review-1",
    });

    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      reviewId: "review-1",
    });
    expect(findFirst.mock.calls[0][0].where).not.toHaveProperty(
      "streamMessageId",
    );
  });
});
