/**
 * @jest-environment node
 */

/**
 * Wave-9 (#1230) auto-enrollment endpoint — route-level tests on the
 * mocked-Prisma pattern from anti-lockout-gaps.test.ts.
 *
 * Deliberately runs the REAL claimProgramAssignment / adjustActiveSeatCount
 * primitives against the mock tx bag (same style as
 * claim-program-assignment.test.ts) so the composition contract is pinned,
 * not just the guards:
 *
 *   - MAINTAINER + canSponsor gate, SUSPENDED/DEACTIVATED org → 409
 *   - body validation: ≤200 ids, dedupe, period sanity, periodEnd future
 *   - program tenancy + ACTIVE status
 *   - per-row: membership-in-org + ACTIVE-only
 *   - created===true ⇒ seat bump + configLockedAt stamp + audit
 *   - created===false (idempotent re-run) ⇒ NO seat bump, still audited
 *   - ProgramAssignmentOverlapError ⇒ honest per-row failure, batch continues
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    program: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    membership: { findFirst: jest.fn() },
    programAssignment: {
      findFirst: jest.fn().mockResolvedValue(null),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn(),
    },
    billingSubscription: {
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ activeSeatCount: 6 }),
    },
    orgAuditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
    $disconnect: jest.fn(),
  },
}));

jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(),
  requireOrgOwner: jest.fn(),
}));

jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: jest.fn().mockResolvedValue(null),
  orgAutoEnrollLimiter: { limit: jest.fn() },
}));

import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { applyRateLimit } from "@/lib/rate-limit";
import type { NextRequest } from "next/server";
import { POST as autoEnrollPOST } from "@/app/api/organizations/[orgId]/programs/[programId]/auto-enroll/route";
import { AUTO_ENROLL_BATCH_DEADLINE_MS } from "@/lib/api/organizations/auto-enroll-config";

const mockedPrisma = prisma as unknown as {
  program: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    updateMany: jest.Mock;
  };
  membership: { findFirst: jest.Mock };
  programAssignment: {
    findFirst: jest.Mock;
    createMany: jest.Mock;
    findUniqueOrThrow: jest.Mock;
  };
  billingSubscription: {
    update: jest.Mock;
    updateMany: jest.Mock;
    findUniqueOrThrow: jest.Mock;
  };
  orgAuditLog: { create: jest.Mock };
  $transaction: jest.Mock;
};
const mockedRequireOrgAccess = requireOrgAccess as jest.Mock;
const mockedApplyRateLimit = applyRateLimit as jest.Mock;

function accessFixture(orgStatus = "ACTIVE") {
  return {
    error: null,
    session: { user: { id: "u-owner", email: "owner@test.com" } },
    member: { id: "m-owner-actor", role: "OWNER" },
    org: { id: "org-1", name: "Acme", status: orgStatus, canSponsor: true },
  };
}

const PERIOD = {
  periodStart: new Date("2026-09-01T00:00:00.000Z"),
  periodEnd: new Date("2027-03-31T00:00:00.000Z"),
};

function makeRequest(body: unknown): NextRequest {
  return new Request(
    "http://localhost/api/organizations/org-1/programs/p-1/auto-enroll",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    },
  ) as unknown as NextRequest;
}

const routeArgs = () =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ({ params: Promise.resolve({ orgId: "org-1", programId: "p-1" }) } as any);

function wireTxShim() {
  mockedPrisma.$transaction.mockImplementation(async (fn: unknown) => {
    const tx = {
      program: mockedPrisma.program,
      membership: mockedPrisma.membership,
      programAssignment: mockedPrisma.programAssignment,
      billingSubscription: mockedPrisma.billingSubscription,
      orgAuditLog: mockedPrisma.orgAuditLog,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (fn as any)(tx);
  });
}

/** Default happy-path stubs: CREDIT_POOL program (seat bump is a no-op). */
function seedHappyPath(opts?: { licenseSeat?: boolean }) {
  mockedPrisma.program.findFirst.mockResolvedValue({
    id: "p-1",
    status: "ACTIVE",
  });
  mockedPrisma.membership.findFirst.mockImplementation(
    async ({ where }: { where: { id: string } }) =>
      where.id === "m-ghost" ? null : { id: where.id, status: "ACTIVE" },
  );
  mockedPrisma.programAssignment.findUniqueOrThrow.mockImplementation(
    async () => ({ id: "pa-x", consumedPaise: BigInt(0) }),
  );
  if (opts?.licenseSeat) {
    mockedPrisma.program.findUnique.mockResolvedValue({
      type: "LICENSED_SEAT",
      contract: { subscription: { id: "sub-1", activeSeatCount: 5 } },
    });
  } else {
    mockedPrisma.program.findUnique.mockResolvedValue({
      type: "CREDIT_POOL",
      contract: { subscription: null },
    });
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedRequireOrgAccess.mockResolvedValue(accessFixture());
  mockedApplyRateLimit.mockResolvedValue(null);
  mockedPrisma.programAssignment.findFirst.mockResolvedValue(null);
  mockedPrisma.programAssignment.createMany.mockResolvedValue({ count: 1 });
  mockedPrisma.program.updateMany.mockResolvedValue({ count: 1 });
  mockedPrisma.orgAuditLog.create.mockResolvedValue({});
  wireTxShim();
});

describe("auto-enroll gates", () => {
  it("passes the caller's error response through untouched", async () => {
    const errRes = Response.json({ error: "forbidden" }, { status: 403 });
    mockedRequireOrgAccess.mockResolvedValueOnce({ error: errRes });

    const res = await autoEnrollPOST(
      makeRequest({ membershipIds: ["m-1"], ...PERIOD }),
      routeArgs(),
    );
    expect(res.status).toBe(403);
    expect(mockedPrisma.program.findFirst).not.toHaveBeenCalled();
  });

  it("rejects a SUSPENDED org with ORG_NOT_ACTIVE", async () => {
    // DEACTIVATED is deliberately absent: requireOrgAccess answers it with a
    // 403 before this route body runs, so a DEACTIVATED arm here would be
    // dead code pinned by a mocked gate (PR #1234 invitations precedent).
    mockedRequireOrgAccess.mockResolvedValueOnce(accessFixture("SUSPENDED"));
    const res = await autoEnrollPOST(
      makeRequest({ membershipIds: ["m-1"], ...PERIOD }),
      routeArgs(),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "ORG_NOT_ACTIVE" });
  });

  it("passes through requireOrgAccess's 403 for a DEACTIVATED org", async () => {
    const errRes = Response.json(
      { error: "Organization has been deactivated" },
      { status: 403 },
    );
    mockedRequireOrgAccess.mockResolvedValueOnce({
      ...accessFixture("DEACTIVATED"),
      error: errRes,
    });
    const res = await autoEnrollPOST(
      makeRequest({ membershipIds: ["m-1"], ...PERIOD }),
      routeArgs(),
    );
    expect(res.status).toBe(403);
    expect(mockedPrisma.program.findFirst).not.toHaveBeenCalled();
  });

  it("rate-limits before touching the database", async () => {
    const tooMany = Response.json({ error: "Too many requests." }, {
      status: 429,
    });
    mockedApplyRateLimit.mockResolvedValueOnce(tooMany);

    const res = await autoEnrollPOST(
      makeRequest({ membershipIds: ["m-1"], ...PERIOD }),
      routeArgs(),
    );
    expect(res.status).toBe(429);
    expect(mockedApplyRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
    );
    expect(mockedPrisma.program.findFirst).not.toHaveBeenCalled();
  });
});

describe("auto-enroll validation", () => {
  beforeEach(() => {
    mockedPrisma.program.findFirst.mockResolvedValue({
      id: "p-1",
      status: "ACTIVE",
    });
  });

  it("rejects an empty membership list", async () => {
    const res = await autoEnrollPOST(
      makeRequest({ membershipIds: [], ...PERIOD }),
      routeArgs(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects more than 200 entries", async () => {
    const res = await autoEnrollPOST(
      makeRequest({
        membershipIds: Array.from({ length: 201 }, (_, i) => `m-${i}`),
        ...PERIOD,
      }),
      routeArgs(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects periodEnd <= periodStart", async () => {
    const res = await autoEnrollPOST(
      makeRequest({
        membershipIds: ["m-1"],
        periodStart: PERIOD.periodEnd,
        periodEnd: PERIOD.periodStart,
      }),
      routeArgs(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a fully-past coverage window", async () => {
    const res = await autoEnrollPOST(
      makeRequest({
        membershipIds: ["m-1"],
        periodStart: new Date("2020-01-01T00:00:00.000Z"),
        periodEnd: new Date("2020-12-31T00:00:00.000Z"),
      }),
      routeArgs(),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for a program outside this org", async () => {
    mockedPrisma.program.findFirst.mockResolvedValueOnce(null);
    const res = await autoEnrollPOST(
      makeRequest({ membershipIds: ["m-1"], ...PERIOD }),
      routeArgs(),
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 for a non-ACTIVE program", async () => {
    mockedPrisma.program.findFirst.mockResolvedValueOnce({
      id: "p-1",
      status: "EXPIRED",
    });
    const res = await autoEnrollPOST(
      makeRequest({ membershipIds: ["m-1"], ...PERIOD }),
      routeArgs(),
    );
    expect(res.status).toBe(409);
  });
});

describe("auto-enroll enrollment loop", () => {
  it("creates assignments for all ACTIVE members (CREDIT_POOL: no seat bump)", async () => {
    seedHappyPath();
    const res = await autoEnrollPOST(
      makeRequest({ membershipIds: ["m-1", "m-2"], ...PERIOD }),
      routeArgs(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enrolled).toBe(2);
    expect(body.skipped).toBe(0);
    expect(body.failed).toBe(0);
    expect(body.results).toHaveLength(2);
    expect(body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);

    // Composition contract: seat bump attempted per create (no-op for
    // CREDIT_POOL), config-lock stamp gated on null, one audit row each.
    expect(mockedPrisma.billingSubscription.update).not.toHaveBeenCalled();
    expect(mockedPrisma.program.updateMany).toHaveBeenCalledTimes(2);
    expect(mockedPrisma.program.updateMany).toHaveBeenCalledWith({
      where: { id: "p-1", configLockedAt: null },
      data: { configLockedAt: expect.any(Date) },
    });
    expect(mockedPrisma.orgAuditLog.create).toHaveBeenCalledTimes(2);
    expect(mockedPrisma.orgAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          category: "PROGRAM",
          action: "PROGRAM_ASSIGNED",
          targetMembershipId: expect.any(String),
        }),
      }),
    );
  });

  it("bumps activeSeatCount for LICENSED_SEAT creates", async () => {
    seedHappyPath({ licenseSeat: true });
    const res = await autoEnrollPOST(
      makeRequest({ membershipIds: ["m-1"], ...PERIOD }),
      routeArgs(),
    );
    expect(res.status).toBe(200);
    expect(mockedPrisma.billingSubscription.update).toHaveBeenCalledWith({
      where: { id: "sub-1" },
      data: { activeSeatCount: { increment: 1 } },
    });
  });

  it("is idempotent: identical re-run reports skips and never re-bumps seats", async () => {
    seedHappyPath({ licenseSeat: true });
    // Re-claim: ON CONFLICT DO NOTHING ⇒ count 0, row read back unchanged.
    mockedPrisma.programAssignment.createMany.mockResolvedValue({ count: 0 });

    const res = await autoEnrollPOST(
      makeRequest({ membershipIds: ["m-1"], ...PERIOD }),
      routeArgs(),
    );
    const body = await res.json();
    expect(body.enrolled).toBe(0);
    expect(body.skipped).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.results[0]).toMatchObject({ ok: true, created: false });
    expect(mockedPrisma.billingSubscription.update).not.toHaveBeenCalled();
    expect(mockedPrisma.program.updateMany).not.toHaveBeenCalled();
    // Audit trail still records the touch (description marks the skip).
    expect(mockedPrisma.orgAuditLog.create).toHaveBeenCalledTimes(1);
  });

  it("fails rows for memberships outside the org without aborting the batch", async () => {
    seedHappyPath();
    const res = await autoEnrollPOST(
      makeRequest({ membershipIds: ["m-1", "m-ghost"], ...PERIOD }),
      routeArgs(),
    );
    const body = await res.json();
    expect(body.enrolled).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.results[1]).toMatchObject({
      membershipId: "m-ghost",
      ok: false,
    });
    expect(body.results[1].error).toMatch(/does not belong/i);
  });

  it("refuses entitlements for non-ACTIVE memberships", async () => {
    seedHappyPath();
    mockedPrisma.membership.findFirst.mockResolvedValueOnce({
      id: "m-pending",
      status: "PENDING",
    });
    const res = await autoEnrollPOST(
      makeRequest({ membershipIds: ["m-pending"], ...PERIOD }),
      routeArgs(),
    );
    const body = await res.json();
    expect(body.failed).toBe(1);
    expect(body.results[0].error).toMatch(/not ACTIVE/i);
    expect(mockedPrisma.programAssignment.createMany).not.toHaveBeenCalled();
  });

  it("maps overlapping-assignment claims to an honest per-row failure", async () => {
    seedHappyPath();
    // The overlap probe inside claimProgramAssignment hits for the SECOND
    // member only: first call (m-ok) passes, second (m-over) finds a live
    // ACTIVE assignment covering a different periodStart.
    let probes = 0;
    mockedPrisma.programAssignment.findFirst.mockImplementation(async () => {
      probes++;
      return probes >= 2 ? { id: "pa-existing" } : null;
    });

    const res = await autoEnrollPOST(
      makeRequest({ membershipIds: ["m-ok", "m-over"], ...PERIOD }),
      routeArgs(),
    );
    const body = await res.json();
    expect(body.enrolled).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.results[1]).toMatchObject({
      membershipId: "m-over",
      ok: false,
    });
    expect(body.results[1].error).toMatch(/overlap/i);
    expect(res.status).toBe(200); // partial success is a 200 with per-row truth
  });

  it("dedupes repeated membership ids within one batch", async () => {
    seedHappyPath();
    const res = await autoEnrollPOST(
      makeRequest({ membershipIds: ["m-1", "m-1", "m-1"], ...PERIOD }),
      routeArgs(),
    );
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(mockedPrisma.membership.findFirst).toHaveBeenCalledTimes(1);
  });

  it("continues the batch when one row hits an internal error", async () => {
    seedHappyPath();
    mockedPrisma.programAssignment.createMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error("db gone"));
    mockedPrisma.programAssignment.createMany.mockResolvedValueOnce({
      count: 1,
    });

    const res = await autoEnrollPOST(
      makeRequest({ membershipIds: ["m-1", "m-2", "m-3"], ...PERIOD }),
      routeArgs(),
    );
    const body = await res.json();
    expect(body.enrolled).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.results[1].error).toBe("Internal error");
  });

  it("stops before the platform function limit and answers truncated:true with committed rows only", async () => {
    seedHappyPath();
    // Date.now call order inside POST: (1) periodEnd-future check,
    // (2) startedAt capture, then (3+) one loop-check per entry. Let the
    // first three read real base time, then jump past the deadline so entry
    // #2's pre-flight check trips and the batch stops BEFORE enrolling m-2.
    const base = Date.now();
    let calls = 0;
    const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => {
      calls++;
      return calls <= 3
        ? base
        : base + AUTO_ENROLL_BATCH_DEADLINE_MS + 60_000;
    });
    try {
      const res = await autoEnrollPOST(
        makeRequest({ membershipIds: ["m-1", "m-2", "m-3"], ...PERIOD }),
        routeArgs(),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.truncated).toBe(true);
      expect(body.enrolled).toBe(1);
      expect(body.results.map((r: { membershipId: string }) => r.membershipId)).toEqual([
        "m-1",
      ]);
      expect(mockedPrisma.orgAuditLog.create).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
