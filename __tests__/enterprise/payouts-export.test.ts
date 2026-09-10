/**
 * @jest-environment node
 */

/**
 * #1230 wave-4 — payouts CSV export: streams every payout org-wide with
 * post-TDS truth columns and self-audits via PAYOUT_EXPORTED before
 * streaming.
 */

import { NextRequest } from "next/server";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    organizationPayout: { findMany: jest.fn() },
    orgAuditLog: { create: jest.fn().mockResolvedValue({}) },
  },
}));

jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(),
}));

import prisma from "../../lib/prisma";
import { requireOrgAccess } from "../../lib/auth-helpers";
import { GET } from "../../app/api/organizations/[orgId]/payouts/export/route";

const m = jest.mocked(prisma) as unknown as {
  organizationPayout: { findMany: jest.Mock };
  orgAuditLog: { create: jest.Mock };
};
const mockedAccess = requireOrgAccess as jest.Mock;

const ROW = {
  id: "po_1",
  status: "COMPLETED",
  periodStart: new Date("2026-08-01T00:00:00Z"),
  periodEnd: new Date("2026-08-07T00:00:00Z"),
  currency: "INR",
  grossRevenuePaise: BigInt(100_000),
  platformFeePaise: BigInt(20_000),
  refundsPaise: BigInt(0),
  tdsAmountPaise: BigInt(100),
  netPayoutPaise: BigInt(80_000),
  amountPaise: BigInt(79_900),
  processedAt: new Date("2026-08-08T00:00:00Z"),
  createdAt: new Date("2026-08-07T12:00:00Z"),
};

beforeEach(() => {
  // resetAllMocks (not clearAllMocks): the keyset contract can stop
  // consuming a test's queued pages mid-queue, and clearAllMocks leaves
  // stale ResolvedValueOnce entries that poison the NEXT test's first pull.
  jest.resetAllMocks();
  m.orgAuditLog.create.mockResolvedValue({});
  mockedAccess.mockResolvedValue({
    error: null,
    member: { id: "m-owner", role: "OWNER" },
    org: { id: "org-1" },
  });
});

function drive() {
  const req = new NextRequest("http://localhost/api/organizations/org-1/payouts/export");
  return GET(req, { params: Promise.resolve({ orgId: "org-1" }) });
}

describe("GET /payouts/export", () => {
  it("streams header + rows and self-audits PAYOUT_EXPORTED first", async () => {
    m.orgAuditLog.create.mockResolvedValue({});
    m.organizationPayout.findMany
      .mockResolvedValueOnce([ROW])
      .mockResolvedValueOnce([]);

    const res = await drive();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");

    // Self-audit precedes streaming reads.
    const auditOrder = m.orgAuditLog.create.mock.invocationCallOrder[0];
    const readOrder = m.organizationPayout.findMany.mock.invocationCallOrder[0];
    expect(auditOrder).toBeLessThan(readOrder);
    expect(m.orgAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "PAYOUT_EXPORTED" }),
      }),
    );

    const body = await res.text();
    const lines = body.trim().split("\n");
    expect(lines[0]).toContain("disbursed_paise");
    // Post-TDS disbursed figure is its own column (wave-1 display truth).
    expect(lines[1]).toContain("79900");
    expect(lines[1]).toContain(",100,");
    // Cursor pagination scoped to this org only.
    expect(m.organizationPayout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-1" },
      }),
    );
  });

  it("escapes commas/quotes in identifiers", async () => {
    m.organizationPayout.findMany
      .mockResolvedValueOnce([{ ...ROW, id: 'po,"x"' }])
      .mockResolvedValueOnce([]);

    const res = await drive();
    const body = await res.text();
    expect(body).toContain('"po,""x"""');
  });
});
