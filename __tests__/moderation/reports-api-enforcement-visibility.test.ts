/**
 * @jest-environment node
 */

/**
 * #1270 — what the moderation queue has to hand the UI for it to tell the
 * truth.
 *
 * `ModerationAction.sideEffects` has been written since #693 and read by
 * nothing, so a ban whose Stream revocation failed was indistinguishable on
 * screen from one that landed. The queue now ships the latest action alongside
 * each report, the target's ban state (there is no unban button without it),
 * and whether this viewer may take an account-destructive action at all —
 * previously every moderator saw a Ban button that answered 403 on click.
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

const reportRow = (latestAction: unknown) => ({
  id: "r1",
  type: "MESSAGE",
  status: "ACTION_TAKEN",
  reason: "Harassment",
  description: null,
  contentText: "the abusive message",
  contentUrl: null,
  streamMessageId: "msg-1",
  streamChannelCid: "messaging:dm-1",
  reportCount: 3,
  reviewId: null,
  assignedToId: null,
  createdAt: new Date(),
  resolvedAt: new Date(),
  reportedBy: { id: "p1", name: "Reporter", email: "r@x.com", image: null },
  targetUser: {
    id: "u1",
    name: "Target",
    email: "t@x.com",
    image: null,
    role: "CONSULTEE",
    banned: true,
    banExpires: null,
  },
  actions: latestAction ? [latestAction] : [],
  _count: { actions: 1 },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedAuth.mockResolvedValue({
    session: { user: { id: "admin-1", role: "ADMIN" } },
  });
  findMany.mockResolvedValue([]);
});

describe("GET /api/staff/moderation/reports — enforcement visibility", () => {
  it("asks for the target's ban state and the latest action's side-effects", async () => {
    await GET(req());

    const include = findMany.mock.calls[0][0].include;
    expect(include.targetUser.select).toMatchObject({
      banned: true,
      banExpires: true,
    });
    expect(include.actions).toMatchObject({
      take: 1,
      orderBy: { createdAt: "desc" },
      select: expect.objectContaining({ sideEffects: true }),
    });
  });

  it("returns the failed enforcement so the report can show it after the toast is gone", async () => {
    findMany.mockResolvedValue([
      reportRow({
        id: "action-1",
        actionType: "USER_BANNED",
        createdAt: new Date(),
        sideEffects: { stream: "failed", errors: ["stream: Stream is down"] },
      }),
    ]);

    const body = await (await GET(req())).json();

    expect(body.reports[0].latestAction.sideEffects).toMatchObject({
      stream: "failed",
    });
    expect(body.reports[0].contentText).toBe("the abusive message");
    expect(body.reports[0].streamMessageId).toBe("msg-1");
    expect(body.reports[0].targetUser.banned).toBe(true);
  });

  it("reports no latest action for a report nobody has acted on", async () => {
    findMany.mockResolvedValue([reportRow(null)]);

    const body = await (await GET(req())).json();

    expect(body.reports[0].latestAction).toBeNull();
  });

  it("tells an admin they may ban and a staff moderator they may not", async () => {
    const admin = await (await GET(req())).json();
    expect(admin.capabilities.canModerateUsers).toBe(true);

    mockedAuth.mockResolvedValue({
      session: { user: { id: "staff-1", role: "STAFF" } },
    });
    const staff = await (await GET(req())).json();
    expect(staff.capabilities.canModerateUsers).toBe(false);
  });
});
