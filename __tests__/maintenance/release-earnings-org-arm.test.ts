/**
 * @jest-environment node
 */

/**
 * #1471 — `scripts/earnings/release-earnings.ts` is the module every scheduled
 * entry point imports (the GitHub Actions job, the `/api/cleanup` twin, the
 * admin system-jobs runner), and until this change its queries touched only
 * `consultantEarnings`. `OrganizationEarnings` rows therefore never left
 * PENDING, and `createOrgPayoutBatch` — which selects READY rows only — could
 * never pick up a host organisation's retained share through any scheduled
 * path.
 *
 * This pin drives the real query shape through an in-memory table so the CAS
 * predicate itself is exercised: a PENDING row past its hold is released, a
 * PENDING row still inside its hold is not.
 */

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  withCronLock: jest.fn(
    async (_key: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));

interface OrgEarningRow {
  id: string;
  status: string;
  holdUntil: Date;
  orgSharePaise: number;
  organization: { name: string };
}

const ORG_ROWS: OrgEarningRow[] = [
  {
    id: "oe_past_hold",
    status: "PENDING",
    holdUntil: new Date("2026-06-01T00:00:00.000Z"),
    orgSharePaise: 80_000,
    organization: { name: "Host Org" },
  },
  {
    id: "oe_inside_hold",
    status: "PENDING",
    // Far enough out that the job's `new Date()` can never pass it.
    holdUntil: new Date("2099-01-01T00:00:00.000Z"),
    orgSharePaise: 90_000,
    organization: { name: "Host Org" },
  },
  {
    id: "oe_already_ready",
    status: "READY",
    holdUntil: new Date("2026-06-01T00:00:00.000Z"),
    orgSharePaise: 70_000,
    organization: { name: "Host Org" },
  },
];

const releasedIds: string[] = [];

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantEarnings: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      aggregate: jest.fn().mockResolvedValue({ _count: 0, _sum: {} }),
    },
    organizationEarnings: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

import prisma from "@/lib/prisma";
import { releaseEarningsFromHold } from "@/scripts/earnings/release-earnings";

const mockedPrisma = prisma as unknown as {
  organizationEarnings: { findMany: jest.Mock; updateMany: jest.Mock };
  $transaction: jest.Mock;
};

describe("#1471 — release-earnings releases host-organization earnings", () => {
  beforeEach(() => {
    releasedIds.length = 0;
    mockedPrisma.$transaction.mockImplementation(async (fn: unknown) =>
      typeof fn === "function"
        ? (fn as (tx: typeof prisma) => Promise<unknown>)(prisma)
        : undefined,
    );

    // Apply the real predicate against the fixture table rather than trusting
    // a hand-written expectation of the `where` object.
    mockedPrisma.organizationEarnings.findMany.mockImplementation(
      async (args: { where: { status: string; holdUntil: { lte: Date } } }) =>
        ORG_ROWS.filter(
          (r) =>
            r.status === args.where.status &&
            r.holdUntil.getTime() <= args.where.holdUntil.lte.getTime(),
        ),
    );
    mockedPrisma.organizationEarnings.updateMany.mockImplementation(
      async (args: {
        where: { id: { in: string[] }; status: string };
        data: { status: string };
      }) => {
        const hit = ORG_ROWS.filter(
          (r) =>
            args.where.id.in.includes(r.id) && r.status === args.where.status,
        );
        releasedIds.push(...hit.map((r) => r.id));
        return { count: hit.length };
      },
    );
  });

  it("releases a PENDING row past its hold and leaves one inside its hold alone", async () => {
    const result = await releaseEarningsFromHold();

    expect(result.success).toBe(true);
    expect(result.organizationEarningsReleased).toBe(1);
    expect(releasedIds).toEqual(["oe_past_hold"]);
    // The consultant count keeps its original meaning (#1471).
    expect(result.releasedCount).toBe(0);
  });

  it("re-states status: PENDING on the claim so a concurrent writer wins", async () => {
    await releaseEarningsFromHold();

    expect(mockedPrisma.organizationEarnings.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "PENDING" }),
        data: { status: "READY" },
      }),
    );
  });

  it("applies the ticker limit to the organization arm as its own budget", async () => {
    await releaseEarningsFromHold({ limit: 25 });

    expect(mockedPrisma.organizationEarnings.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 25, orderBy: { holdUntil: "asc" } }),
    );
  });
});
