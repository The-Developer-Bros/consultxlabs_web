/**
 * @jest-environment node
 */

/**
 * Anti-lockout gap closure for v1: covers three vectors NOT exercised by
 * member-anti-lockout.test.ts:
 *
 *   1. Bulk member endpoint must always return 405 — no future
 *      bypass-by-loop accidentally side-stepping the per-member
 *      Serializable guard.
 *   2. Contract termination must refuse when there are still active
 *      ProgramAssignments inside their current cycle (otherwise
 *      checkout 500s on assignment-resolve for orphaned members).
 *   3. Program delete must refuse when any historical
 *      BookingUtilization row points at the program — the audit trail
 *      and refund path both rely on the FK target staying alive.
 *
 * All three follow the same mocked-prisma pattern as
 * member-anti-lockout.test.ts. We don't exercise the Serializable
 * isolation level itself (Prisma's TS layer hides it from the mock);
 * we only assert the explicit guards.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    contract: {
      findFirst: jest.fn(),
      update: jest.fn(),
      // Status moves go through the CAS helper: guarded updateMany +
      // in-tx findUniqueOrThrow re-read.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: "c-1" }),
    },
    program: {
      findFirst: jest.fn(),
      delete: jest.fn(),
      // #779 — TERMINATED cascade (programs → EXPIRED).
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    programAssignment: {
      count: jest.fn(),
      // #779 — TERMINATED cascade (assignments → CLOSED).
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    bookingUtilization: { findFirst: jest.fn() },
    purchaseOrder: { findUnique: jest.fn() },
    // #779 — outstanding-invoice terminate guard; default = no invoices owed.
    organizationInvoice: { count: jest.fn().mockResolvedValue(0) },
    orgAuditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
    $disconnect: jest.fn(),
  },
}));

jest.mock("../../lib/auth-helpers", () => {
  const RANK: Record<string, number> = {
    OWNER: 5,
    MAINTAINER: 4,
    MANAGER: 3,
    SUPPORT: 2,
    EXPERT: 1,
    LEARNER: 1,
  };
  return {
    requireOrgAccess: jest.fn(),
    requireOrgOwner: jest.fn(),
    orgRoleSatisfies: (caller: string, minimum: string) =>
      (RANK[caller] ?? 0) >= (RANK[minimum] ?? 0),
  };
});

import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import {
  GET as bulkGET,
  POST as bulkPOST,
  PATCH as bulkPATCH,
  DELETE as bulkDELETE,
} from "@/app/api/organizations/[orgId]/members/bulk/route";
import { PATCH as contractPATCH } from "@/app/api/organizations/[orgId]/contracts/[contractId]/route";
import { DELETE as programDELETE } from "@/app/api/organizations/[orgId]/programs/[programId]/route";

const mockedPrisma = prisma as unknown as {
  contract: {
    findFirst: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    findUniqueOrThrow: jest.Mock;
  };
  program: { findFirst: jest.Mock; delete: jest.Mock; updateMany: jest.Mock };
  programAssignment: { count: jest.Mock; updateMany: jest.Mock };
  bookingUtilization: { findFirst: jest.Mock };
  purchaseOrder: { findUnique: jest.Mock };
  organizationInvoice: { count: jest.Mock };
  orgAuditLog: { create: jest.Mock };
  $transaction: jest.Mock;
};
const mockedRequireOrgAccess = requireOrgAccess as jest.Mock;

function ownerAccess() {
  return {
    error: null,
    session: { user: { id: "u-owner", email: "owner@test.com" } },
    member: { id: "m-owner-actor", role: "OWNER" },
    org: { id: "org-1", name: "Acme", status: "ACTIVE", canSponsor: true },
  };
}

function makeRequest(url: string, body: unknown) {
  return new Request(url, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }) as unknown as Request;
}

function wireTxShim() {
  mockedPrisma.$transaction.mockImplementation(async (fn: unknown) => {
    const tx = {
      contract: mockedPrisma.contract,
      program: mockedPrisma.program,
      programAssignment: mockedPrisma.programAssignment,
      bookingUtilization: mockedPrisma.bookingUtilization,
      purchaseOrder: mockedPrisma.purchaseOrder,
      organizationInvoice: mockedPrisma.organizationInvoice,
      orgAuditLog: mockedPrisma.orgAuditLog,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (fn as any)(tx);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedRequireOrgAccess.mockResolvedValue(ownerAccess());
  wireTxShim();
});

// ---------------------------------------------------------------------------
// 1. Bulk endpoint always 405
// ---------------------------------------------------------------------------

describe("/api/organizations/[orgId]/members/bulk — explicit 405", () => {
  it.each([
    ["GET", bulkGET],
    ["POST", bulkPOST],
    ["PATCH", bulkPATCH],
    ["DELETE", bulkDELETE],
  ] as const)("%s returns 405 with BULK_REMOVAL_NOT_SUPPORTED", async (_, h) => {
    const res = (await h()) as Response;
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toBe("BULK_REMOVAL_NOT_SUPPORTED");
  });
});

// ---------------------------------------------------------------------------
// 2. Contract termination guard
// ---------------------------------------------------------------------------

describe("PATCH /api/organizations/[orgId]/contracts/[contractId] — termination guard", () => {
  it("refuses to terminate an ACTIVE contract with live assignments (409)", async () => {
    mockedPrisma.contract.findFirst.mockResolvedValueOnce({
      id: "c-1",
      organizationId: "org-1",
      status: "ACTIVE",
    });
    mockedPrisma.programAssignment.count.mockResolvedValueOnce(3);

    const res = (await contractPATCH(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeRequest(
        "http://localhost/api/organizations/org-1/contracts/c-1",
        { status: "TERMINATED" },
      ) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { params: Promise.resolve({ orgId: "org-1", contractId: "c-1" }) } as any,
    )) as Response;

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/3 active assignment/);
    expect(mockedPrisma.contract.update).not.toHaveBeenCalled();
  });

  it("allows terminating an ACTIVE contract with zero live assignments", async () => {
    mockedPrisma.contract.findFirst.mockResolvedValueOnce({
      id: "c-1",
      organizationId: "org-1",
      status: "ACTIVE",
    });
    mockedPrisma.programAssignment.count.mockResolvedValueOnce(0);
    mockedPrisma.contract.update.mockResolvedValueOnce({
      id: "c-1",
      status: "TERMINATED",
      invoiceNumber: "INV-1",
    });

    const res = (await contractPATCH(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeRequest(
        "http://localhost/api/organizations/org-1/contracts/c-1",
        { status: "TERMINATED" },
      ) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { params: Promise.resolve({ orgId: "org-1", contractId: "c-1" }) } as any,
    )) as Response;

    expect(res.status).toBe(200);
    // Status moves are CAS-guarded updateMany now, not a plain update.
    expect(mockedPrisma.contract.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["ACTIVE"] },
        }),
        data: expect.objectContaining({ status: "TERMINATED" }),
      }),
    );
  });

  it("does not run the assignment guard for non-TERMINATED transitions", async () => {
    mockedPrisma.contract.findFirst.mockResolvedValueOnce({
      id: "c-1",
      organizationId: "org-1",
      status: "DRAFT",
    });
    mockedPrisma.contract.update.mockResolvedValueOnce({
      id: "c-1",
      status: "ACTIVE",
      invoiceNumber: "INV-1",
    });

    const res = (await contractPATCH(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeRequest(
        "http://localhost/api/organizations/org-1/contracts/c-1",
        { status: "ACTIVE" },
      ) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { params: Promise.resolve({ orgId: "org-1", contractId: "c-1" }) } as any,
    )) as Response;

    expect(res.status).toBe(200);
    expect(mockedPrisma.programAssignment.count).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Program delete guard — utilization history blocks hard delete
// ---------------------------------------------------------------------------

describe("DELETE /api/organizations/[orgId]/programs/[programId] — utilization guard", () => {
  it("returns 409 when assignment count > 0", async () => {
    mockedPrisma.program.findFirst.mockResolvedValueOnce({
      id: "p-1",
      contract: { organizationId: "org-1" },
      _count: { assignments: 2 },
    });

    const res = (await programDELETE(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Request("http://localhost/api/organizations/org-1/programs/p-1", {
        method: "DELETE",
      }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { params: Promise.resolve({ orgId: "org-1", programId: "p-1" }) } as any,
    )) as Response;

    expect(res.status).toBe(409);
    expect(mockedPrisma.program.delete).not.toHaveBeenCalled();
  });

  it("returns 409 when historical BookingUtilization rows still reference the program", async () => {
    mockedPrisma.program.findFirst.mockResolvedValueOnce({
      id: "p-1",
      contract: { organizationId: "org-1" },
      _count: { assignments: 0 },
    });
    mockedPrisma.bookingUtilization.findFirst.mockResolvedValueOnce({
      id: "u-1",
    });

    const res = (await programDELETE(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Request("http://localhost/api/organizations/org-1/programs/p-1", {
        method: "DELETE",
      }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { params: Promise.resolve({ orgId: "org-1", programId: "p-1" }) } as any,
    )) as Response;

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/historical utilization/i);
    expect(mockedPrisma.program.delete).not.toHaveBeenCalled();
  });

  it("allows delete when assignments=0 and no utilization history", async () => {
    mockedPrisma.program.findFirst.mockResolvedValueOnce({
      id: "p-1",
      contract: { organizationId: "org-1" },
      _count: { assignments: 0 },
    });
    mockedPrisma.bookingUtilization.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.program.delete.mockResolvedValueOnce({ id: "p-1" });

    const res = (await programDELETE(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Request("http://localhost/api/organizations/org-1/programs/p-1", {
        method: "DELETE",
      }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { params: Promise.resolve({ orgId: "org-1", programId: "p-1" }) } as any,
    )) as Response;

    expect(res.status).toBe(204);
    expect(mockedPrisma.program.delete).toHaveBeenCalled();
  });
});
