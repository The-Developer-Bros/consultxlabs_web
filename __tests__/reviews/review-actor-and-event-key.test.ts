/**
 * @jest-environment node
 */

/**
 * #1549 / #1562 — two rules the review write paths share.
 *
 *   1. `pickExistingReview` is the ONE rule for "which of my reviews of this
 *      expert is the one this session edits": the row keyed on (track, event),
 *      else a NULL-track legacy row to adopt, never the other track's row. The
 *      composer and the POST route both call it, so the form never shows a review
 *      the write would not update.
 *   2. A staff takedown of a reply stamps `replyRemovedBy = MODERATION` and
 *      writes exactly one `ModerationAction`; the consultant's own withdrawal
 *      stamps AUTHOR and writes none (it is not a staff act).
 */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
}));

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: jest.fn(),
  isPrivileged: (role?: string | null) => role === "ADMIN" || role === "STAFF",
}));

jest.mock("../../lib/data/public-cache", () => ({
  __esModule: true,
  purgeReviewSurfaces: jest.fn(),
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  reviewWriteLimiter: {},
}));

jest.mock("../../lib/prisma", () => {
  const consultantReview = { findUnique: jest.fn(), updateMany: jest.fn() };
  const moderationAction = { create: jest.fn() };
  return {
    __esModule: true,
    default: {
      consultantReview,
      moderationAction,
      // The route runs the CAS and the audit insert in one transaction.
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
        fn({ consultantReview, moderationAction }),
      ),
    },
  };
});

import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import { requireApiAuth } from "../../lib/auth-helpers";
import { pickExistingReview } from "../../lib/reviews";
import { DELETE } from "../../app/api/user/reviews/[id]/reply/route";

const mockedAuth = requireApiAuth as jest.MockedFunction<typeof requireApiAuth>;
const mockedFindUnique = prisma.consultantReview
  .findUnique as jest.MockedFunction<typeof prisma.consultantReview.findUnique>;
const updateMany = prisma.consultantReview.updateMany as jest.Mock;
const actionCreate = prisma.moderationAction.create as jest.Mock;

describe("pickExistingReview (#1549)", () => {
  const oneToOne = {
    id: "r1",
    track: "ONE_TO_ONE" as const,
    ratingUnitId: null,
  };
  const webinarA = {
    id: "r2",
    track: "GROUP" as const,
    ratingUnitId: "webinar:a",
  };
  const legacy = { id: "r3", track: null, ratingUnitId: null };

  it("keys 1:1 by track and GROUP by event, never crossing tracks", () => {
    const rows = [oneToOne, webinarA];
    expect(pickExistingReview(rows, "ONE_TO_ONE", null)?.id).toBe("r1");
    expect(pickExistingReview(rows, "GROUP", "webinar:a")?.id).toBe("r2");
    // A second webinar is a new row, not an edit of the first one's review.
    expect(pickExistingReview(rows, "GROUP", "webinar:b")).toBeNull();
  });

  it("adopts a NULL-track legacy row only when no keyed row exists", () => {
    expect(pickExistingReview([legacy], "ONE_TO_ONE", null)?.id).toBe("r3");
    expect(pickExistingReview([legacy], "GROUP", "webinar:a")?.id).toBe("r3");
    expect(pickExistingReview([legacy, oneToOne], "ONE_TO_ONE", null)?.id).toBe(
      "r1",
    );
  });
});

describe("reply takedown attribution (#1562)", () => {
  const review = {
    id: "rev-1",
    deletedAt: null,
    replyDeletedAt: null,
    replyRemovedBy: null,
    consultantProfileId: "cp-1",
    consultantProfile: { userId: "consultant-user" },
  };
  const call = () =>
    DELETE(new NextRequest("http://x/api/user/reviews/rev-1/reply"), {
      params: Promise.resolve({ id: "rev-1" }),
    });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedFindUnique.mockResolvedValue(review as never);
    updateMany.mockResolvedValue({ count: 1 });
  });

  it("staff: MODERATION plus exactly one audit row naming the review", async () => {
    mockedAuth.mockResolvedValue({
      session: { user: { id: "staff-1", role: "STAFF" } },
    } as never);
    const res = await call();
    expect(res.status).toBe(200);
    expect(updateMany.mock.calls[0][0].data.replyRemovedBy).toBe("MODERATION");
    expect(actionCreate).toHaveBeenCalledTimes(1);
    expect(actionCreate.mock.calls[0][0].data).toMatchObject({
      actionType: "REVIEW_REPLY_REMOVED",
      reviewId: "rev-1",
      takenById: "staff-1",
    });
  });

  it("the consultant: AUTHOR and no audit row", async () => {
    mockedAuth.mockResolvedValue({
      session: { user: { id: "consultant-user", role: "CONSULTANT" } },
    } as never);
    const res = await call();
    expect(res.status).toBe(200);
    expect(updateMany.mock.calls[0][0].data.replyRemovedBy).toBe("AUTHOR");
    expect(actionCreate).not.toHaveBeenCalled();
  });
});
