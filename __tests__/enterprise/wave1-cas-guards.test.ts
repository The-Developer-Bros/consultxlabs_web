/**
 * @jest-environment node
 */

/**
 * #1230 wave-1 regression coverage for the three route-level CAS fixes:
 *
 *  1. Assignment period PATCH claims only live rows — a ROLLED/CLOSED/
 *     CANCELLED assignment must answer 409 ASSIGNMENT_NOT_LIVE instead of
 *     being silently resurrected (checkout resolves sponsors by window).
 *  2. Contract supersede claims the old contract via updateMany BEFORE
 *     re-pointing programs — a lost claim must abort with
 *     CONTRACT_ALREADY_SUPERSEDED and leave programs untouched.
 *  3. Member direct-add reactivation goes through transitionMembership's
 *     CAS so a row that became ERASED between the pre-read and the write
 *     is refused (409 ILLEGAL_TRANSITION) instead of resurrecting a DPDP
 *     tombstone.
 *
 * Harness mirrors po-balance-enforcement.test.ts: module-level Prisma
 * mocks forwarded into $transaction's tx shim, requireOrgAccess stubbed,
 * handlers driven with real NextRequest objects.
 */

import { NextRequest } from "next/server";

// ---- Shared mocks -----------------------------------------------------

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    programAssignment: {
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
    },
    contract: {
      findFirst: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    program: { updateMany: jest.fn() },
    // E2E-audit P0 — supersession carries the licence onto the successor
    // contract (BillingSubscription is contractId @unique, so the row used to
    // strand on the retired term: successor unlicensed, seat count frozen).
    billingSubscription: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    membership: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    user: { findUnique: jest.fn() },
    // #729/#819 who-is-acting rule: direct-add requires a pre-existing
    // profile for LEARNER/EXPERT, probed before the transaction opens.
    consulteeProfile: { findUnique: jest.fn() },
    consultantProfile: { findUnique: jest.fn() },
    orgAuditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  },
}));

jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(),
}));

jest.mock("../../lib/api/organizations/membership-transitions", () => ({
  applyMembershipRoleEffects: jest.fn(async () => ({
    consulteeProfileId: "cp-1",
    consultantProfileId: null,
    payoutRecipient: null,
  })),
  bumpUserSessionGeneration: jest.fn(async () => {}),
}));

jest.mock("../../lib/enterprise/outbound-webhooks/dispatch", () => ({
  dispatchWebhookEvent: jest.fn(async () => {}),
}));

import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { PATCH as patchAssignment } from "@/app/api/organizations/[orgId]/programs/[programId]/assignments/[assignmentId]/route";
import { POST as supersedeContract } from "@/app/api/organizations/[orgId]/contracts/[contractId]/supersede/route";
import { POST as addMember } from "@/app/api/organizations/[orgId]/members/route";

const m = prisma as unknown as Record<string, Record<string, jest.Mock>> & {
  $transaction: jest.Mock;
};
const mockedRequireOrgAccess = requireOrgAccess as jest.Mock;

function ownerAccess() {
  return {
    error: null,
    session: { user: { id: "u-owner" } },
    member: { id: "m-owner", role: "OWNER" },
    org: { id: "org-1", name: "Acme", status: "ACTIVE", canSponsor: true, canHost: false },
  };
}

function wireTxShim(extraTxModels: string[] = []) {
  m.$transaction.mockImplementation(async (fn: unknown) => {
    const tx: Record<string, unknown> = {};
    for (const model of [
      ...extraTxModels,
      "programAssignment",
      "contract",
      "program",
      "billingSubscription",
      "membership",
      "user",
      "orgAuditLog",
    ]) {
      tx[model] = m[model];
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (fn as any)(tx);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedRequireOrgAccess.mockResolvedValue(ownerAccess());
});

// ---- 1. Assignment period PATCH --------------------------------------

describe("PATCH assignments/[assignmentId] — terminal resurrection guard", () => {
  function makeReq(body: unknown) {
    return new NextRequest(
      "http://localhost/api/organizations/org-1/programs/p-1/assignments/a-1",
      { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
    );
  }
  const routeParams = {
    params: Promise.resolve({ orgId: "org-1", programId: "p-1", assignmentId: "a-1" }),
  };

  it("409 ASSIGNMENT_NOT_LIVE when the row is terminal (claim count 0)", async () => {
    wireTxShim();
    m.programAssignment.findFirst.mockResolvedValue({
      id: "a-1",
      programId: "p-1",
      membershipId: "mem-9",
      status: "CANCELLED",
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-02-01"),
    });
    m.programAssignment.updateMany.mockResolvedValue({ count: 0 });

    const res = await patchAssignment(
      makeReq({ periodStart: "2026-01-01", periodEnd: "2026-03-01" }),
      routeParams,
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("ASSIGNMENT_NOT_LIVE");
  });

  it("200 and re-reads the row when the live-row claim wins", async () => {
    wireTxShim();
    m.programAssignment.findFirst.mockResolvedValue({
      id: "a-1",
      programId: "p-1",
      membershipId: "mem-9",
      status: "ACTIVE",
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-02-01"),
    });
    m.programAssignment.updateMany.mockResolvedValue({ count: 1 });
    m.programAssignment.findUniqueOrThrow.mockResolvedValue({
      id: "a-1",
      status: "ACTIVE",
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-03-01"),
    });

    const res = await patchAssignment(
      makeReq({ periodEnd: "2026-03-01" }),
      routeParams,
    );
    expect(res.status).toBe(200);
    // The claim predicate must scope to live statuses only.
    expect(m.programAssignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "a-1",
          status: { in: ["ACTIVE", "PAUSED"] },
        }),
      }),
    );
  });
});

// ---- 2. Contract supersede CAS ---------------------------------------

describe("POST contracts/[contractId]/supersede — claim-before-repoint", () => {
  function makeReq(body: unknown) {
    return new NextRequest(
      "http://localhost/api/organizations/org-1/contracts/c-1/supersede",
      { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
    );
  }
  const routeParams = {
    params: Promise.resolve({ orgId: "org-1", contractId: "c-1" }),
  };

  function setupOldContract() {
    m.contract.findFirst.mockResolvedValue({
      id: "c-1",
      organizationId: "org-1",
      billingAccountId: "ba-1",
      purchaseOrderId: null,
      status: "ACTIVE",
      supersededByContractId: null,
      effectiveFrom: new Date("2026-01-01"),
      effectiveTo: new Date("2026-12-31"),
      paymentTermsDays: 60,
      autoRenew: false,
      rateCardId: null,
    });
    m.contract.create.mockResolvedValue({ id: "c-2" });
  }

  it("409 CONTRACT_ALREADY_SUPERSEDED without touching programs on a lost claim", async () => {
    wireTxShim(["program"]);
    setupOldContract();
    m.contract.updateMany.mockResolvedValue({ count: 0 });

    const res = await supersedeContract(makeReq({ reason: "RENEWAL" }), routeParams);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("CONTRACT_ALREADY_SUPERSEDED");
    // Ordering pin: the loser must abort BEFORE re-pointing entitlements.
    expect(m.program.updateMany).not.toHaveBeenCalled();
  });

  it("carries the BillingSubscription onto the successor contract", async () => {
    // Without this the successor is unlicensed while the dead contract keeps
    // a frozen seat count — and, before the invoice-cron guard, kept billing.
    wireTxShim();
    setupOldContract();
    m.contract.updateMany.mockResolvedValue({ count: 1 });
    m.billingSubscription.findUnique.mockResolvedValue({
      id: "bsub-1",
      cycle: "MONTHLY",
      flatFeePaise: BigInt(500000),
    });

    const res = await supersedeContract(
      makeReq({ reason: "RENEWAL" }),
      routeParams,
    );

    expect(res.status).toBe(201);
    expect(m.billingSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "bsub-1" },
        data: expect.objectContaining({
          contractId: "c-2",
          // The billing clock restarts at the successor's effectiveFrom.
          renewalReminderSentAt: null,
        }),
      }),
    );
  });

  it("supersedes cleanly when the contract carries no licence at all", async () => {
    wireTxShim();
    setupOldContract();
    m.contract.updateMany.mockResolvedValue({ count: 1 });
    m.billingSubscription.findUnique.mockResolvedValue(null);

    const res = await supersedeContract(
      makeReq({ reason: "AMENDMENT" }),
      routeParams,
    );

    expect(res.status).toBe(201);
    expect(m.billingSubscription.update).not.toHaveBeenCalled();
  });

  it("claims the old contract first, then re-points programs, then 201s", async () => {
    wireTxShim();
    setupOldContract();
    m.contract.updateMany.mockResolvedValue({ count: 1 });
    m.billingSubscription.findUnique.mockResolvedValue(null);

    const res = await supersedeContract(makeReq({ reason: "AMENDMENT" }), routeParams);
    expect(res.status).toBe(201);
    const claimOrder = m.contract.updateMany.mock.invocationCallOrder[0];
    const repointOrder = m.program.updateMany.mock.invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(repointOrder);
    expect(m.contract.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "c-1",
          status: "ACTIVE",
          supersededByContractId: null,
        }),
      }),
    );
  });
});

// ---- 3. Member direct-add reactivation -------------------------------

describe("POST members — REMOVED→ACTIVE via guarded FSM", () => {
  function makeReq(body: unknown) {
    return new NextRequest("http://localhost/api/organizations/org-1/members", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }
  const routeParams = { params: Promise.resolve({ orgId: "org-1" }) };

  function setupRemovedMember(role = "LEARNER") {
    m.membership.findUnique.mockResolvedValue({
      id: "mem-7",
      userId: "u-7",
      role,
      status: "REMOVED",
    });
    m.user.findUnique.mockResolvedValue({ id: "u-7" });
    // #729/#819 — LEARNER direct-add requires an existing ConsulteeProfile.
    m.consulteeProfile.findUnique.mockResolvedValue({ id: "cp-1" });
  }

  it("reactivates through the CAS (updateMany) and re-reads the row", async () => {
    wireTxShim();
    setupRemovedMember();
    m.membership.updateMany.mockResolvedValue({ count: 1 });
    m.membership.findUniqueOrThrow.mockResolvedValue({
      id: "mem-7",
      userId: "u-7",
      role: "LEARNER",
      status: "ACTIVE",
    });

    const res = await addMember(makeReq({ userId: "u-7", role: "LEARNER" }), routeParams);
    expect(res.status).toBeLessThan(300);
    expect(m.membership.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "mem-7",
          status: { in: expect.arrayContaining(["PENDING", "SUSPENDED", "REMOVED"]) },
        }),
        data: expect.objectContaining({ status: "ACTIVE" }),
      }),
    );
  });

  it("409 ILLEGAL_TRANSITION when the row turned ERASED mid-flight (claim count 0)", async () => {
    wireTxShim();
    setupRemovedMember();
    // The pre-read said REMOVED, but an erasure run landed between the read
    // and the write — the CAS predicate excludes ERASED rows, so count is 0
    // and the tombstone survives.
    m.membership.updateMany.mockResolvedValue({ count: 0 });

    const res = await addMember(makeReq({ userId: "u-7", role: "LEARNER" }), routeParams);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/ERASED|ILLEGAL_TRANSITION|cannot transition/i);
  });
});
