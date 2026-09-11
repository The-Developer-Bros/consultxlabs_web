/**
 * @jest-environment node
 */

/**
 * Server-side guard: POST /api/organizations/[orgId]/programs must
 * reject `type=CREDIT_POOL` when the parent contract's BillingAccount
 * is `fundingSource=LICENSE`. The wizard already hides the option in
 * the UI; this test covers the API loophole — a curious client can't
 * construct it directly.
 *
 * Why the combo is bogus: a LICENSE is a flat-fee paid offline for
 * unmetered usage. A per-cycle credit cap on top of it doesn't
 * express a real customer arrangement (the relevant ProgramType is
 * LICENSED_SEAT with `coveredEngagementsPerCycle=null`).
 *
 * See `prompts/a.txt` rows 68 + 73 + 120 for the original analysis.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    contract: { findUnique: jest.fn() },
    // #751 — the overlap guard probes ACTIVE siblings before creating; none
    // exist in these fixtures.
    program: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
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
    orgRoleSatisfies: (caller: string, minimum: string) =>
      (RANK[caller] ?? 0) >= (RANK[minimum] ?? 0),
  };
});

import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { POST as programsPOST } from "@/app/api/organizations/[orgId]/programs/route";

const mockedPrisma = prisma as unknown as {
  contract: { findUnique: jest.Mock };
  program: { create: jest.Mock };
  orgAuditLog: { create: jest.Mock };
  $transaction: jest.Mock;
};
const mockedRequireOrgAccess = requireOrgAccess as jest.Mock;

function maintainerAccess() {
  return {
    error: null,
    session: { user: { id: "u-m", email: "m@test.com" } },
    member: { id: "m-actor", role: "MAINTAINER" },
    org: { id: "org-1", name: "Acme", status: "ACTIVE", canSponsor: true },
  };
}

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/organizations/org-1/programs", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }) as unknown as Request;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedRequireOrgAccess.mockResolvedValue(maintainerAccess());
  mockedPrisma.$transaction.mockImplementation(async (fn: unknown) => {
    const tx = {
      program: mockedPrisma.program,
      orgAuditLog: mockedPrisma.orgAuditLog,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (fn as any)(tx);
  });
});

describe("POST /api/organizations/[orgId]/programs — LICENSE × CREDIT_POOL guard", () => {
  it("rejects a CREDIT_POOL program under a LICENSE-funded contract (400 UNREACHABLE_FUNDING_PATH)", async () => {
    mockedPrisma.contract.findUnique.mockResolvedValueOnce({
      organizationId: "org-1",
      status: "ACTIVE",
      billingAccount: { fundingSource: "LICENSE" },
    });

    const res = (await programsPOST(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeRequest({
        type: "CREDIT_POOL",
        contractId: "c-1",
        name: "Pool program under license — bogus",
        coveredPlanTypes: [],
        allowedCategories: [],
        creditPoolConfig: {
          cycle: "MONTHLY",
          creditBudgetPerCycle: 1000,
        },
      }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { params: Promise.resolve({ orgId: "org-1" }) } as any,
    )) as Response;

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("UNREACHABLE_FUNDING_PATH");
    expect(body.error).toMatch(/LICENSE/);
    expect(body.error).toMatch(/CREDIT_POOL/);
    // Critical: program.create must NOT have fired
    expect(mockedPrisma.program.create).not.toHaveBeenCalled();
  });

  it("allows a CREDIT_POOL program under a WALLET-funded contract", async () => {
    mockedPrisma.contract.findUnique.mockResolvedValueOnce({
      organizationId: "org-1",
      status: "ACTIVE",
      billingAccount: { fundingSource: "WALLET" },
    });
    mockedPrisma.program.create.mockResolvedValueOnce({
      id: "p-1",
      type: "CREDIT_POOL",
      name: "Pool program under wallet — valid",
    });

    const res = (await programsPOST(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeRequest({
        type: "CREDIT_POOL",
        contractId: "c-1",
        name: "Pool program under wallet — valid",
        coveredPlanTypes: [],
        allowedCategories: [],
        creditPoolConfig: {
          cycle: "MONTHLY",
          creditBudgetPerCycle: 1000,
        },
      }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { params: Promise.resolve({ orgId: "org-1" }) } as any,
    )) as Response;

    expect(res.status).toBe(201);
    expect(mockedPrisma.program.create).toHaveBeenCalled();
  });

  it("allows a LICENSED_SEAT program under a LICENSE-funded contract (the one valid LICENSE shape)", async () => {
    mockedPrisma.contract.findUnique.mockResolvedValueOnce({
      organizationId: "org-1",
      status: "ACTIVE",
      billingAccount: { fundingSource: "LICENSE" },
    });
    mockedPrisma.program.create.mockResolvedValueOnce({
      id: "p-2",
      type: "LICENSED_SEAT",
      name: "Goldman analysts — unmetered",
    });

    const res = (await programsPOST(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeRequest({
        type: "LICENSED_SEAT",
        contractId: "c-1",
        name: "Goldman analysts — unmetered",
        coveredPlanTypes: [],
        allowedCategories: [],
        licensedSeatConfig: {
          ratePerSeatPaise: 0,
          cycle: "ANNUAL",
          coveredEngagementsPerCycle: null,
          overageBehavior: "BLOCK",
        },
      }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { params: Promise.resolve({ orgId: "org-1" }) } as any,
    )) as Response;

    expect(res.status).toBe(201);
    expect(mockedPrisma.program.create).toHaveBeenCalled();
  });
});
