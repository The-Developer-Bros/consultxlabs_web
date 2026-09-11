/**
 * @jest-environment node
 */

/**
 * Anti-lockout regression for PATCH `/api/organizations/[orgId]/members/[memberId]`.
 *
 * The route refuses to demote or `REMOVED`-status the only active OWNER
 * so an org can never end up ownerless. This is a load-bearing
 * invariant — if it regresses, a single accidental PATCH can orphan an
 * entire tenant's billing surface. The check runs inside a
 * Serializable-equivalent $transaction so concurrent demotes can't both
 * believe there's a second owner.
 *
 * The test mocks `prisma.$transaction` to pass its callback a tiny tx
 * shim (matching the shape the route uses) + mocks `requireOrgAccess`
 * to simulate an OWNER-level caller. Follows the pattern from
 * __tests__/booking-algorithm/authorization.test.ts.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    membership: {
      findFirst: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    // Why: a role downgrade fires `bumpUserSessionGeneration` inside the
    // transaction (lib/api/organizations/membership-transitions.ts) which calls
    // `tx.user.update(...)`. The route would crash with `tx.user undefined`
    // without this delegate exposed on the prisma mock + the tx shim below.
    user: {
      update: jest
        .fn()
        .mockResolvedValue({ id: "u-victim", sessionGeneration: 2 }),
    },
    orgAuditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn(),
    $disconnect: jest.fn(),
  },
}));

jest.mock("../../lib/auth-helpers", () => {
  // Inline the role-rank comparator so the test doesn't need to import
  // the real module (which transitively pulls in better-auth ESM and
  // breaks jest's CJS loader). Keep the rank list in sync with
  // lib/auth-helpers.ts — the ordering OWNER > MAINTAINER > MANAGER >
  // SUPPORT > EXPERT = LEARNER is a documented invariant from
  // docs/enterprise/00-foundations/04-roles-and-permissions.md.
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
import { PATCH } from "@/app/api/organizations/[orgId]/members/[memberId]/route";

const mockedPrisma = prisma as unknown as {
  membership: {
    findFirst: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
  };
  user: { update: jest.Mock };
  orgAuditLog: { create: jest.Mock };
  $transaction: jest.Mock;
};
const mockedRequireOrgAccess = requireOrgAccess as jest.Mock;

function ownerAccess() {
  return {
    error: null,
    session: { user: { id: "u-owner", email: "owner@test.com" } },
    member: { id: "m-owner-actor", role: "OWNER" },
    org: { id: "org-1", name: "Acme", status: "ACTIVE" },
  };
}

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/organizations/org-1/members/m-1", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }) as unknown as Request;
}

function makeParams(orgId = "org-1", memberId = "m-target") {
  return {
    params: Promise.resolve({ orgId, memberId }),
  };
}

function wireTxShim() {
  // $transaction(fn) — invoke the callback with a tx that proxies
  // through to the module-level mocks. Matches the route's expected
  // shape; nothing about the isolation level matters for unit coverage.
  mockedPrisma.$transaction.mockImplementation(async (fn: unknown) => {
    const tx = {
      membership: mockedPrisma.membership,
      orgAuditLog: mockedPrisma.orgAuditLog,
      // Why: role downgrades bump the user's sessionGeneration counter
      // inside the same transaction (see bumpUserSessionGeneration in
      // lib/api/organizations/membership-transitions.ts). The shim has to
      // forward `tx.user.update` to the module-level mock so the helper
      // can complete the transaction without crashing.
      user: mockedPrisma.user,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (fn as any)(tx);
  });
}

describe("PATCH /api/organizations/[orgId]/members/[memberId] — anti-lockout", () => {
  beforeEach(() => {
    mockedRequireOrgAccess.mockResolvedValue(ownerAccess());
    wireTxShim();
  });

  it("refuses to demote the only active OWNER (409)", async () => {
    // Target member is OWNER; no other active OWNERs in the org.
    mockedPrisma.membership.findFirst.mockResolvedValueOnce({
      id: "m-target",
      organizationId: "org-1",
      role: "OWNER",
      status: "ACTIVE",
      userId: "u-victim",
    });
    mockedPrisma.membership.count.mockResolvedValueOnce(0);

    const res = (await PATCH(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeRequest({ role: "MAINTAINER" }) as any,
      makeParams(),
    )) as Response;

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/only active OWNER/i);
    // Critical: membership.update must NOT have fired
    expect(mockedPrisma.membership.update).not.toHaveBeenCalled();
  });

  it("refuses to REMOVED-status the only active OWNER (409)", async () => {
    mockedPrisma.membership.findFirst.mockResolvedValueOnce({
      id: "m-target",
      organizationId: "org-1",
      role: "OWNER",
      status: "ACTIVE",
      userId: "u-victim",
    });
    mockedPrisma.membership.count.mockResolvedValueOnce(0);

    const res = (await PATCH(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeRequest({ status: "REMOVED" }) as any,
      makeParams(),
    )) as Response;

    expect(res.status).toBe(409);
    expect(mockedPrisma.membership.update).not.toHaveBeenCalled();
  });

  it("allows demoting an OWNER when another active OWNER exists", async () => {
    mockedPrisma.membership.findFirst.mockResolvedValueOnce({
      id: "m-target",
      organizationId: "org-1",
      role: "OWNER",
      status: "ACTIVE",
      userId: "u-victim",
    });
    // One other active OWNER present → demotion is safe
    mockedPrisma.membership.count.mockResolvedValueOnce(1);
    mockedPrisma.membership.update.mockResolvedValueOnce({
      id: "m-target",
      role: "MAINTAINER",
      status: "ACTIVE",
    });

    const res = (await PATCH(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeRequest({ role: "MAINTAINER" }) as any,
      makeParams(),
    )) as Response;

    expect(res.status).toBe(200);
    // OWNER → MAINTAINER is an operator-role transition: the centralized
    // applyMembershipRoleEffects helper clears any consulteeProfileId /
    // consultantProfileId and resets payoutRecipient to SELF so a former
    // consumer/provider role doesn't leave a stale profile FK behind.
    expect(mockedPrisma.membership.update).toHaveBeenCalledWith({
      where: { id: "m-target" },
      data: {
        role: "MAINTAINER",
        consulteeProfileId: null,
        consultantProfileId: null,
        payoutRecipient: "SELF",
      },
    });
    // Why: every role mutation must bump the demoted user's
    // sessionGeneration so their next request triggers a customSession
    // refetch (lib/auth.ts), eliminating up to 24h of stale-permission
    // exposure. Audit phase B.5 — see bumpUserSessionGeneration docstring.
    expect(mockedPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "u-victim" },
      data: { sessionGeneration: { increment: 1 } },
    });
  });

  it("blocks LEARNER → EXPERT role transition with 409", async () => {
    // Separate invariant (docs/enterprise/00-foundations/04-roles-and-permissions.md):
    // disjoint LEARNER/EXPERT boundary forces remove + re-invite rather
    // than in-place mutation, because the two roles imply different
    // profile types.
    mockedPrisma.membership.findFirst.mockResolvedValueOnce({
      id: "m-target",
      organizationId: "org-1",
      role: "LEARNER",
      status: "ACTIVE",
      userId: "u-target",
    });

    const res = (await PATCH(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeRequest({ role: "EXPERT" }) as any,
      makeParams(),
    )) as Response;

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("ROLE_TRANSITION_BLOCKED");
    expect(mockedPrisma.membership.update).not.toHaveBeenCalled();
  });
});
