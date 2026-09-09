/**
 * @jest-environment node
 */

/**
 * B2B gap 10 — a program seat may only be assigned to someone who is IN the org.
 *
 * The create path checked that the membership BELONGS to the org and stopped
 * there. Belonging is not the same as being active: a PENDING member has not
 * accepted their invite, and a SUSPENDED/REMOVED/ERASED one is gone. Assigning
 * either one incremented `activeSeatCount` — which is what
 * generate-subscription-invoices bills on — for a seat nobody could consume, so
 * the org paid for it and the "member" never saw the program.
 */

const mockRequireOrgAccess = jest.fn();
const mockProgramFindFirst = jest.fn();
const mockMembershipFindFirst = jest.fn();
const mockClaimProgramAssignment = jest.fn();
const mockAdjustActiveSeatCount = jest.fn();
const mockAuditCreate = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    program: { findFirst: (...a: unknown[]) => mockProgramFindFirst(...a) },
    // The membership read lives INSIDE the transaction now, so it is reached
    // through `tx`, not the top-level client.
    $transaction: (fn: unknown) =>
      (fn as (tx: unknown) => Promise<unknown>)({
        membership: {
          findFirst: (...a: unknown[]) => mockMembershipFindFirst(...a),
        },
        program: { updateMany: jest.fn() },
        orgAuditLog: { create: (...a: unknown[]) => mockAuditCreate(...a) },
      }),
  },
}));

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireOrgAccess: (...a: unknown[]) => mockRequireOrgAccess(...a),
}));

jest.mock("../../lib/api/organizations/program-helpers", () => ({
  __esModule: true,
  claimProgramAssignment: (...a: unknown[]) => mockClaimProgramAssignment(...a),
}));

jest.mock("../../lib/api/organizations/seat-count", () => ({
  __esModule: true,
  adjustActiveSeatCount: (...a: unknown[]) => mockAdjustActiveSeatCount(...a),
}));

import { POST } from "../../app/api/organizations/[orgId]/programs/[programId]/assignments/route";

const ORG = "org-acme";
const PROGRAM = "program-1";
const MEMBERSHIP = "membership-1";

function request() {
  return new Request("http://localhost/api", {
    method: "POST",
    body: JSON.stringify({
      membershipId: MEMBERSHIP,
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-12-01T00:00:00.000Z",
    }),
  }) as never;
}

function params() {
  return { params: Promise.resolve({ orgId: ORG, programId: PROGRAM }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireOrgAccess.mockResolvedValue({
    session: { user: { id: "user-1" } },
    member: { id: "actor-membership", role: "MAINTAINER" },
    org: { id: ORG, canSponsor: true },
  });
  mockProgramFindFirst.mockResolvedValue({ id: PROGRAM, status: "ACTIVE" });
  mockClaimProgramAssignment.mockResolvedValue({
    assignment: { id: "assignment-1" },
    created: true,
  });
  mockAuditCreate.mockResolvedValue({});
});

describe("program assignment requires an ACTIVE membership (B2B gap 10)", () => {
  it("creates and takes a seat for an ACTIVE member", async () => {
    mockMembershipFindFirst.mockResolvedValue({
      id: MEMBERSHIP,
      status: "ACTIVE",
    });

    const res = await POST(request(), params());

    expect(res.status).toBe(201);
    expect(mockClaimProgramAssignment).toHaveBeenCalledTimes(1);
    expect(mockAdjustActiveSeatCount).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ programId: PROGRAM, delta: 1 }),
    );
  });

  it.each(["PENDING", "SUSPENDED", "REMOVED", "ERASED"])(
    "409s for a %s membership and never touches the seat count",
    async (status) => {
      mockMembershipFindFirst.mockResolvedValue({ id: MEMBERSHIP, status });

      const res = await POST(request(), params());

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: `Cannot assign a ${status} membership to a program`,
        code: "MEMBERSHIP_NOT_ACTIVE",
      });
      // The billed number is the point: it must not move.
      expect(mockAdjustActiveSeatCount).not.toHaveBeenCalled();
      expect(mockClaimProgramAssignment).not.toHaveBeenCalled();
    },
  );

  it("still 400s when the membership belongs to a different org", async () => {
    mockMembershipFindFirst.mockResolvedValue(null);

    const res = await POST(request(), params());

    expect(res.status).toBe(400);
    expect(mockAdjustActiveSeatCount).not.toHaveBeenCalled();
  });

  it("reads the membership inside the serializable transaction", async () => {
    // Checking outside and claiming inside is a check-then-act: a suspension
    // landing in the gap still took a billed seat. The read has to share the
    // claim's conflict boundary, which means it has to run on `tx`.
    mockMembershipFindFirst.mockResolvedValue({
      id: MEMBERSHIP,
      status: "ACTIVE",
    });

    await POST(request(), params());

    // The route's only membership read is the one the tx mock serves; a
    // top-level `prisma.membership` would throw on an undefined delegate.
    expect(mockMembershipFindFirst).toHaveBeenCalledTimes(1);
    expect(mockMembershipFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MEMBERSHIP, organizationId: ORG },
      }),
    );
  });
});
