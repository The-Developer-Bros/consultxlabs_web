/**
 * @jest-environment node
 */

/**
 * #1230 wave-4b — invoices CSV export parity with payouts: header/rows,
 * INVOICE_EXPORTED self-audit before streaming, org scoping.
 */

import { NextRequest } from "next/server";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    organizationInvoice: { findMany: jest.fn() },
    orgAuditLog: { create: jest.fn().mockResolvedValue({}) },
  },
}));

jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(),
}));

import prisma from "../../lib/prisma";
import { requireOrgAccess } from "../../lib/auth-helpers";
import { GET } from "../../app/api/organizations/[orgId]/billing-account/invoices/export/route";

const m = jest.mocked(prisma) as unknown as {
  organizationInvoice: { findMany: jest.Mock };
  orgAuditLog: { create: jest.Mock };
};
const mockedAccess = requireOrgAccess as jest.Mock;

const ROW = {
  id: "inv_1",
  invoiceNumber: "ACME-2026-0007",
  status: "ISSUED",
  displayCurrency: "INR",
  subtotalPaise: BigInt(100_000),
  igstPaise: BigInt(18_000),
  cgstPaise: BigInt(0),
  sgstPaise: BigInt(0),
  totalPaise: BigInt(118_000),
  issuedAt: new Date("2026-08-01T00:00:00Z"),
  dueDate: new Date("2026-08-31T00:00:00Z"),
  paidAt: null,
  purchaseOrderId: null,
  contractId: null,
  createdAt: new Date("2026-08-01T00:00:00Z"),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedAccess.mockResolvedValue({
    error: null,
    member: { id: "m-owner", role: "OWNER" },
    org: { id: "org-1" },
  });
  m.organizationInvoice.findMany
    .mockResolvedValueOnce([ROW])
    .mockResolvedValueOnce([]);
});

describe("GET /billing-account/invoices/export", () => {
  it("streams GST-itemized rows and self-audits INVOICE_EXPORTED first", async () => {
    const res = await GET(new NextRequest("http://localhost/x"), {
      params: Promise.resolve({ orgId: "org-1" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");

    const auditOrder = m.orgAuditLog.create.mock.invocationCallOrder[0];
    const readOrder = m.organizationInvoice.findMany.mock.invocationCallOrder[0];
    expect(auditOrder).toBeLessThan(readOrder);

    const body = await res.text();
    const lines = body.trim().split("\n");
    expect(lines[0]).toContain("invoice_number");
    expect(lines[1]).toContain("ACME-2026-0007");
    expect(lines[1]).toContain(",18000,"); // IGST itemized
    expect(m.organizationInvoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-1" },
      }),
    );
  });
});
