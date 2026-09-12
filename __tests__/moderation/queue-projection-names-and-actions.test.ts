/**
 * @jest-environment node
 */

/**
 * #1300 — the staff moderation queue titled every report card with a
 * truncated report id and showed no audit trail, even though
 * `ModerationAction` has been the single audit row for every staff act since
 * #1590. This pins the two projections that fix it: the list route asks for
 * the review's subject (so a REVIEW report can be titled by what was
 * reviewed, not by the report's own id) and for who took the last action.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requirePrivilegedAuth: jest.fn(),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    moderationReport: {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      groupBy: jest.fn(async () => []),
    },
  },
}));

import { GET } from "../../app/api/staff/moderation/reports/route";
import { requirePrivilegedAuth } from "../../lib/auth-helpers";
import prisma from "../../lib/prisma";

const mockedAuth = requirePrivilegedAuth as jest.Mock;
const findMany = prisma.moderationReport.findMany as jest.Mock;

const req = () =>
  new Request(
    "http://localhost/api/staff/moderation/reports?status=PENDING",
  ) as never;

const reviewReportRow = () => ({
  id: "r1",
  type: "REVIEW",
  status: "PENDING",
  reason: "Abusive text",
  description: null,
  contentText: null,
  contentUrl: null,
  streamMessageId: null,
  streamChannelCid: null,
  reportCount: 1,
  reviewId: "rev-1",
  assignedToId: null,
  createdAt: new Date(),
  resolvedAt: null,
  reportedBy: { id: "p1", name: "Reporter", email: "r@x.com", image: null },
  targetUser: {
    id: "u1",
    name: "The author",
    email: "t@x.com",
    image: null,
    role: "CONSULTEE",
    banned: false,
    banExpires: null,
  },
  review: {
    id: "rev-1",
    rating: 1,
    reviewDescription: "Terrible, would not recommend at all.",
    consultantProfile: { user: { name: "Consultant Kay" } },
  },
  actions: [
    {
      id: "action-1",
      actionType: "REVIEW_REMOVED",
      createdAt: new Date(),
      sideEffects: { reviewRemoved: true },
      notes: "clear breach",
      takenBy: { name: "Staffer One" },
    },
  ],
  _count: { actions: 1 },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedAuth.mockResolvedValue({
    session: { user: { id: "admin-1", role: "ADMIN" } },
  });
  findMany.mockResolvedValue([]);
});

describe("GET /api/staff/moderation/reports — naming the subject and the actor", () => {
  it("projects the review's subject and the last action's staff name and notes", async () => {
    await GET(req());

    const include = findMany.mock.calls[0][0].include;
    expect(include.review.select).toMatchObject({
      id: true,
      rating: true,
      reviewDescription: true,
      consultantProfile: {
        select: { user: { select: { name: true } } },
      },
    });
    expect(include.actions.select).toMatchObject({
      notes: true,
      takenBy: { select: { name: true } },
    });
  });

  it("returns the review's consultant name and the action's staff name in the response", async () => {
    findMany.mockResolvedValue([reviewReportRow()]);

    const body = await (await GET(req())).json();
    const report = body.reports[0];

    expect(report.review).toMatchObject({
      rating: 1,
      consultantProfile: { user: { name: "Consultant Kay" } },
    });
    expect(report.latestAction).toMatchObject({
      actionType: "REVIEW_REMOVED",
      notes: "clear breach",
      takenBy: { name: "Staffer One" },
    });
  });

  it("reports no review subject for a non-REVIEW report", async () => {
    findMany.mockResolvedValue([
      { ...reviewReportRow(), type: "USER", review: null },
    ]);

    const body = await (await GET(req())).json();

    expect(body.reports[0].review).toBeNull();
  });
});
