/**
 * @jest-environment node
 */

/**
 * #997 secondary findings — the staff moderation queue used to fetch every
 * PENDING report and substring-search on every keystroke client-side. Pins
 * that the route now accepts a `search` param and filters server-side over
 * the same fields (report id, reason, reporter name, target user name) the
 * old client-side filter checked.
 */

import { GET } from "../../app/api/staff/moderation/reports/route";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import prisma from "@/lib/prisma";

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requirePrivilegedAuth: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    moderationReport: {
      findMany: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
  },
}));

const mockedAuth = requirePrivilegedAuth as jest.Mock;
const mockedFindMany = prisma.moderationReport.findMany as jest.Mock;
const mockedCount = prisma.moderationReport.count as jest.Mock;
const mockedGroupBy = prisma.moderationReport.groupBy as jest.Mock;

function req(url: string) {
  return new Request(url) as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedAuth.mockResolvedValue({ session: { user: { id: "staff-1", role: "STAFF" } } });
  mockedFindMany.mockResolvedValue([]);
  mockedCount.mockResolvedValue(0);
  mockedGroupBy.mockResolvedValue([]);
});

describe("GET /api/staff/moderation/reports — search", () => {
  it("omits the OR clause when no search term is given", async () => {
    await GET(req("http://localhost/api/staff/moderation/reports?status=PENDING"));
    const where = mockedFindMany.mock.calls[0][0].where;
    expect(where.OR).toBeUndefined();
  });

  it("filters server-side over id/reason/reporter-name/target-name", async () => {
    await GET(
      req(
        "http://localhost/api/staff/moderation/reports?status=PENDING&search=spam",
      ),
    );
    const where = mockedFindMany.mock.calls[0][0].where;
    expect(where.status).toBe("PENDING");
    expect(where.OR).toEqual([
      { id: { contains: "spam", mode: "insensitive" } },
      { reason: { contains: "spam", mode: "insensitive" } },
      { reportedBy: { name: { contains: "spam", mode: "insensitive" } } },
      { targetUser: { name: { contains: "spam", mode: "insensitive" } } },
    ]);
  });

  it("403s when the caller isn't privileged", async () => {
    mockedAuth.mockResolvedValue({
      error: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
    });
    const res = await GET(req("http://localhost/api/staff/moderation/reports"));
    expect(res.status).toBe(403);
    expect(mockedFindMany).not.toHaveBeenCalled();
  });
});
