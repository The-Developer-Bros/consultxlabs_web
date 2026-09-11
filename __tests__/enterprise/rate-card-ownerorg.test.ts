/**
 * @jest-environment node
 */

/**
 * Issue #728 regression guard: bumpRateCard must persist `ownerOrgId`
 * verbatim from the caller's `scope.ownerOrgId`. The wizard's
 * ReviewStep POSTs to `/api/organizations/[orgId]/rate-cards`, the
 * route handler reads the orgId from the URL, and forwards it as
 * `scope: { ownerOrgId: orgId }`. The originally-reported bug (CUID-
 * formatted user.id sneaking into ownerOrgId) is fixed; this test pins
 * the contract so a future refactor of the callers cannot regress it.
 *
 * Pure-mock unit test in line with the rest of __tests__/enterprise.
 * The DB-level FK added in 20260427000000_ratecard_ownerorg_fk catches
 * a mis-bind at write time; this test catches it at the call-site
 * level.
 */

import { bumpRateCard } from "@/lib/api/organizations/rate-card";

type CapturedCreate = { data: Record<string, unknown> };

function makeTx() {
  const captured: CapturedCreate[] = [];
  const tx = {
    rateCard: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      create: jest.fn(async ({ data }: CapturedCreate) => {
        captured.push({ data });
        return { id: "rc-new", ...data };
      }),
    },
  };
  return { tx, captured };
}

describe("bumpRateCard — ownerOrgId binding (issue #728)", () => {
  it("persists ownerOrgId verbatim from scope", async () => {
    const { tx, captured } = makeTx();
    const ORG_ID = "org-cuid-abc-123";

    await bumpRateCard(tx as never, {
      scope: { ownerOrgId: ORG_ID },
      next: { platformBps: 1000, orgBps: 1000, consultantBps: 8000 },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].data.ownerOrgId).toBe(ORG_ID);
    expect(captured[0].data.ownerContractId).toBeNull();
    expect(captured[0].data.platformBps).toBe(1000);
    expect(captured[0].data.orgBps).toBe(1000);
    expect(captured[0].data.consultantBps).toBe(8000);
  });

  it("persists ownerContractId without leaking ownerOrgId", async () => {
    const { tx, captured } = makeTx();
    const CONTRACT_ID = "contract-uuid-xyz";

    await bumpRateCard(tx as never, {
      scope: { ownerContractId: CONTRACT_ID },
      next: { platformBps: 1500, orgBps: 500, consultantBps: 8000 },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].data.ownerOrgId).toBeNull();
    expect(captured[0].data.ownerContractId).toBe(CONTRACT_ID);
  });

  it("falls back to null when neither owner is provided", async () => {
    // Defensive case — the route handler always supplies one or the
    // other, but the helper should not invent a value.
    const { tx, captured } = makeTx();

    await bumpRateCard(tx as never, {
      scope: {},
      next: { platformBps: 1000, orgBps: 1000, consultantBps: 8000 },
    });

    expect(captured[0].data.ownerOrgId).toBeNull();
    expect(captured[0].data.ownerContractId).toBeNull();
  });
});
