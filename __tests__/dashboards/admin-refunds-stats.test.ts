/**
 * @jest-environment node
 */

/**
 * #997 secondary findings — the Refunds dashboard's Pending/Succeeded/Failed
 * stat cards used to `.filter()` the current *page* of refunds (≤20 rows)
 * instead of the whole table. Pins that the route now returns a
 * server-computed `stats` block independent of the current page.
 */

import { NextRequest } from "next/server";
import { GET } from "../../app/api/admin/refunds/route";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import prisma from "@/lib/prisma";

// Same-process limiter-store isolation (see admin-refund-error-mapping).
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn().mockResolvedValue(null),
  moneyOpsLimiter: { limit: jest.fn() },
}));

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requirePrivilegedAuth: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    refund: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));

const mockedAuth = requirePrivilegedAuth as jest.Mock;
const mockedFindMany = prisma.refund.findMany as jest.Mock;
const mockedCount = prisma.refund.count as jest.Mock;

function req(url: string) {
  return new NextRequest(url);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedAuth.mockResolvedValue({ session: { user: { id: "staff-1", role: "STAFF" } } });
  mockedFindMany.mockResolvedValue([]);
});

describe("GET /api/admin/refunds — stats", () => {
  it("returns dashboard-wide pending/succeeded/failed counts independent of the page size", async () => {
    mockedCount
      .mockResolvedValueOnce(3) // total (filtered)
      .mockResolvedValueOnce(9) // pendingCount (unfiltered)
      .mockResolvedValueOnce(240) // succeededCount (unfiltered)
      .mockResolvedValueOnce(5); // failedCount (unfiltered)

    const res = await GET(req("http://localhost/api/admin/refunds?search=re_123"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stats).toEqual({
      pendingCount: 9,
      succeededCount: 240,
      failedCount: 5,
    });
  });

  it("scopes the status-breakdown counts by status only (not the request's search/gateway)", async () => {
    mockedCount.mockResolvedValue(0);
    await GET(req("http://localhost/api/admin/refunds?gateway=RAZORPAY&search=x"));

    expect(mockedCount.mock.calls[1][0]).toEqual({ where: { status: "PENDING" } });
    expect(mockedCount.mock.calls[2][0]).toEqual({ where: { status: "SUCCEEDED" } });
    expect(mockedCount.mock.calls[3][0]).toEqual({ where: { status: "FAILED" } });
  });

  it("403s when the caller isn't privileged", async () => {
    mockedAuth.mockResolvedValue({
      error: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
    });
    const res = await GET(req("http://localhost/api/admin/refunds"));
    expect(res.status).toBe(403);
    expect(mockedFindMany).not.toHaveBeenCalled();
  });
});
