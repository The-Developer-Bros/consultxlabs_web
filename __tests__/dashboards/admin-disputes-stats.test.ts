/**
 * @jest-environment node
 */

/**
 * #997 secondary findings — the Disputes dashboard's "Under Review"/"Won"
 * stat cards used to `.filter()` the current *page* of disputes (≤20 rows)
 * instead of counting the whole table, so they silently undercounted at
 * scale. Pins that the route now returns a server-computed `stats` block
 * that ignores the current page/search/gateway filter, mirroring how
 * `urgentDisputes` was already computed.
 */

import { NextRequest } from "next/server";
import { GET } from "../../app/api/admin/disputes/route";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import prisma from "@/lib/prisma";

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requirePrivilegedAuth: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    dispute: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));

const mockedAuth = requirePrivilegedAuth as jest.Mock;
const mockedFindMany = prisma.dispute.findMany as jest.Mock;
const mockedCount = prisma.dispute.count as jest.Mock;

function req(url: string) {
  return new NextRequest(url);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedAuth.mockResolvedValue({ session: { user: { id: "staff-1", role: "STAFF" } } });
  mockedFindMany.mockResolvedValue([]);
});

describe("GET /api/admin/disputes — stats", () => {
  it("returns dashboard-wide underReviewCount/wonCount independent of the page size", async () => {
    // Page 1 of a filtered search only returns 2 rows, but the platform
    // has far more UNDER_REVIEW/WON disputes overall.
    mockedCount
      .mockResolvedValueOnce(2) // total (filtered)
      .mockResolvedValueOnce(1) // urgentDisputes
      .mockResolvedValueOnce(37) // underReviewCount (unfiltered)
      .mockResolvedValueOnce(112); // wonCount (unfiltered)

    const res = await GET(
      req("http://localhost/api/admin/disputes?search=acme&limit=20"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stats).toEqual({ underReviewCount: 37, wonCount: 112 });
  });

  it("computes underReviewCount/wonCount with a status-only where (no search/gateway leakage)", async () => {
    mockedCount.mockResolvedValue(0);

    await GET(req("http://localhost/api/admin/disputes?search=acme&gateway=STRIPE"));

    // Calls 3 and 4 (0-indexed 2, 3) are the underReviewCount/wonCount counts.
    const underReviewCall = mockedCount.mock.calls[2][0];
    const wonCall = mockedCount.mock.calls[3][0];
    expect(underReviewCall).toEqual({ where: { status: "UNDER_REVIEW" } });
    expect(wonCall).toEqual({ where: { status: "WON" } });
  });

  it("403s when the caller isn't privileged", async () => {
    mockedAuth.mockResolvedValue({
      error: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
    });
    const res = await GET(req("http://localhost/api/admin/disputes"));
    expect(res.status).toBe(403);
    expect(mockedFindMany).not.toHaveBeenCalled();
  });
});
