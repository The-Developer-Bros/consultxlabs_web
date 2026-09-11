/**
 * @jest-environment node
 */

/**
 * #997 secondary findings — org Payouts used to fetch every payout for the
 * org (bounded only by a `limit=25` default with no `offset`) and reduce
 * `totalPaid`/`pendingAmount` client-side every render. Pins that the route
 * now (a) accepts `offset` so the list is truly paginated and (b) returns a
 * server-aggregated `stats` block (`totalPaidPaise`/`pendingPaise`/`counts`)
 * computed org-wide, independent of the current page/status filter.
 */

import { GET } from "../../app/api/organizations/[orgId]/payouts/route";
import { requireOrgAccess } from "@/lib/auth-helpers";
import prisma from "@/lib/prisma";

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireOrgAccess: jest.fn(),
  requireOrgOwner: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    organizationPayout: {
      findMany: jest.fn(),
      count: jest.fn(),
      aggregate: jest.fn(),
      groupBy: jest.fn(),
    },
  },
}));

const mockedAccess = requireOrgAccess as jest.Mock;
const mockedFindMany = prisma.organizationPayout.findMany as jest.Mock;
const mockedCount = prisma.organizationPayout.count as jest.Mock;
const mockedAggregate = prisma.organizationPayout.aggregate as jest.Mock;
const mockedGroupBy = prisma.organizationPayout.groupBy as jest.Mock;

function req(url: string) {
  return new Request(url) as never;
}

function params(orgId: string) {
  return { params: Promise.resolve({ orgId }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedAccess.mockResolvedValue({ org: { canHost: true } });
  mockedFindMany.mockResolvedValue([]);
  mockedCount.mockResolvedValue(0);
  mockedAggregate.mockResolvedValue({ _sum: { amountPaise: null } });
  mockedGroupBy.mockResolvedValue([]);
});

describe("GET /api/organizations/[orgId]/payouts — pagination + stats", () => {
  it("passes offset/limit through to the paginated findMany", async () => {
    const res = await GET(
      req("http://localhost/api/organizations/org1/payouts?limit=10&offset=20"),
      params("org1"),
    );
    expect(res.status).toBe(200);
    const call = mockedFindMany.mock.calls[0][0];
    expect(call.take).toBe(10);
    expect(call.skip).toBe(20);

    const body = await res.json();
    expect(body.pagination).toEqual({
      total: 0,
      limit: 10,
      offset: 20,
      hasMore: false,
    });
  });

  it("returns org-wide totalPaidPaise/pendingPaise/counts unaffected by the status filter", async () => {
    mockedAggregate
      .mockResolvedValueOnce({ _sum: { amountPaise: BigInt(50_000) } }) // COMPLETED
      .mockResolvedValueOnce({ _sum: { amountPaise: BigInt(12_000) } }); // in-flight
    mockedGroupBy.mockResolvedValue([
      { status: "COMPLETED", _count: { id: 4 } },
      { status: "PENDING", _count: { id: 2 } },
    ]);
    mockedCount.mockResolvedValue(1); // filtered total for the page being viewed

    const res = await GET(
      req("http://localhost/api/organizations/org1/payouts?status=PENDING"),
      params("org1"),
    );
    const body = await res.json();

    expect(body.stats.totalPaidPaise).toBe(50000);
    expect(body.stats.pendingPaise).toBe(12000);
    expect(body.stats.counts).toEqual({ COMPLETED: 4, PENDING: 2, total: 6 });

    // The status filter narrows the *list* query, not the org-wide aggregates.
    const aggregateCall = mockedAggregate.mock.calls[0][0];
    expect(aggregateCall.where).toEqual({
      organizationId: "org1",
      status: "COMPLETED",
    });
  });

  it("404s when the org doesn't host (no payouts to list)", async () => {
    mockedAccess.mockResolvedValue({ org: { canHost: false } });
    const res = await GET(
      req("http://localhost/api/organizations/org1/payouts"),
      params("org1"),
    );
    expect(res.status).toBe(404);
    expect(mockedFindMany).not.toHaveBeenCalled();
  });

  it("400s on an out-of-range limit", async () => {
    const res = await GET(
      req("http://localhost/api/organizations/org1/payouts?limit=1000"),
      params("org1"),
    );
    expect(res.status).toBe(400);
    expect(mockedFindMany).not.toHaveBeenCalled();
  });
});
