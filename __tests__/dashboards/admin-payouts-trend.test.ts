/**
 * @jest-environment node
 */

/**
 * #997 secondary findings — the admin Payouts "Last 7 Days" chart used to
 * fetch `/api/admin/payouts?limit=100` and bucket the raw rows into days in
 * the browser (not 7-day-safe at scale, per the client's own TODO). Pins
 * that the new trend endpoint bounds the query to the 7-day window and
 * buckets server-side.
 */

import { GET } from "../../app/api/admin/payouts/trend/route";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import prisma from "@/lib/prisma";

// The route moved from requirePrivilegedAuth (admits STAFF) to the
// surface-scoped guard, because BACKOFFICE_PERMISSIONS makes payouts.read
// ADMIN_ONLY — payouts are settlement data with no support use case.
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireBackofficeSurface: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantPayout: {
      findMany: jest.fn(),
    },
  },
}));

const mockedAuth = requireBackofficeSurface as jest.Mock;
const mockedFindMany = prisma.consultantPayout.findMany as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockedAuth.mockResolvedValue({ session: { user: { id: "admin-1", role: "ADMIN" } } });
});

describe("GET /api/admin/payouts/trend", () => {
  it("bounds the query to the 7-day window (not an arbitrary row limit)", async () => {
    mockedFindMany.mockResolvedValue([]);
    await GET();

    const call = mockedFindMany.mock.calls[0][0];
    expect(call.select).toEqual({ createdAt: true, amount: true });
    const since = call.where.createdAt.gte as Date;
    const daysAgo = (Date.now() - since.getTime()) / (1000 * 60 * 60 * 24);
    // 6 full days back from the start of today, so this should land between
    // 6 and 7 days depending on time-of-day.
    expect(daysAgo).toBeGreaterThanOrEqual(6);
    expect(daysAgo).toBeLessThan(8);
  });

  it("returns exactly 7 buckets summed by calendar day (UTC)", async () => {
    const today = new Date();
    const todayUtc = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    mockedFindMany.mockResolvedValue([
      { createdAt: todayUtc, amount: 10_000 },
      { createdAt: todayUtc, amount: 5_000 },
    ]);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.series).toHaveLength(7);

    const todayKey = todayUtc.toISOString().slice(0, 10);
    const todayBucket = body.series.find(
      (d: { day: string }) => d.day === todayKey,
    );
    expect(todayBucket.totalPaise).toBe(15_000);

    // Every other bucket is untouched (0).
    const otherTotal = body.series
      .filter((d: { day: string }) => d.day !== todayKey)
      .reduce((s: number, d: { totalPaise: number }) => s + d.totalPaise, 0);
    expect(otherTotal).toBe(0);
  });

  it("403s when the caller isn't privileged", async () => {
    mockedAuth.mockResolvedValue({
      error: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
    });
    const res = await GET();
    expect(res.status).toBe(403);
    expect(mockedFindMany).not.toHaveBeenCalled();
  });
});
