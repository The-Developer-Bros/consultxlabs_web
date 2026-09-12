/**
 * @jest-environment node
 */

/**
 * #1300 — the moderation queue's query parameters are validated before they
 * reach Prisma. `parseInt("abc")` is NaN, which Prisma rejects as `skip`, so a
 * typo in the page number used to surface as a 500 rather than a 400; and
 * `limit` had no ceiling.
 */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
}));

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requirePrivilegedAuth: jest.fn(),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantReview: {
      findMany: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
  },
}));

import { NextRequest } from "next/server";
import { requirePrivilegedAuth } from "../../lib/auth-helpers";
import prisma from "../../lib/prisma";
import { GET } from "../../app/api/staff/moderation/reviews/route";

const mockedAuth = requirePrivilegedAuth as jest.Mock;
const mockedFindMany = prisma.consultantReview.findMany as jest.Mock;
const mockedCount = prisma.consultantReview.count as jest.Mock;
const mockedGroupBy = prisma.consultantReview.groupBy as jest.Mock;

function request(query: string) {
  return new NextRequest(
    `http://localhost/api/staff/moderation/reviews${query}`,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedAuth.mockResolvedValue({
    session: { user: { id: "s1", role: "STAFF" } },
  });
  mockedFindMany.mockResolvedValue([]);
  mockedCount.mockResolvedValue(0);
  mockedGroupBy.mockResolvedValue([]);
});

describe("GET /api/staff/moderation/reviews query validation", () => {
  it("rejects a non-numeric page with 400, before Prisma sees NaN", async () => {
    const res = await GET(request("?page=abc"));
    expect(res.status).toBe(400);
    expect(mockedFindMany).not.toHaveBeenCalled();
  });

  it("caps the page size", async () => {
    const res = await GET(request("?limit=5000"));
    expect(res.status).toBe(400);
    expect(mockedFindMany).not.toHaveBeenCalled();
  });

  it("rejects a rating bound outside 1..5", async () => {
    const res = await GET(request("?minRating=0"));
    expect(res.status).toBe(400);
  });

  it("defaults page and limit, and passes only validated numbers to Prisma", async () => {
    const res = await GET(request("?minRating=2&maxRating=4"));
    expect(res.status).toBe(200);
    expect(mockedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { rating: { gte: 2, lte: 4 } },
        skip: 0,
        take: 20,
      }),
    );
  });
});
