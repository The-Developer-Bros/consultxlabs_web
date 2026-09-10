/**
 * @jest-environment node
 */

/**
 * A3 (Q3): per-collaborator HOST-org settlement.
 *
 * After the primary expert's OrganizationEarnings row is created,
 * `createEarningsFromPayment` loops every ACCEPTED collaborator and
 * creates a SEPARATE OrganizationEarnings row for each one whose
 * consultant profile has an active EXPERT membership at a HOST org.
 *
 * Independent collaborators (no HOST membership) get NO row — their
 * share is only on `ConsultantEarnings`.
 *
 * Same-org collisions (collab at the SAME org as the primary expert,
 * or two collabs at the same org) hit the
 * @@unique([paymentId, organizationId]) DB constraint. v1 strategy:
 * skip the duplicate insert, log a warning, leave the collaborator's
 * personal share intact via ConsultantEarnings.
 *
 * Pure-mock unit test — we mock the Prisma client and the
 * `calculateRevenueSplit` helper, then assert the captured
 * `tx.organizationEarnings.create` payloads.
 */

const ORG_LEARNPRO = "org-learnpro";
const ORG_ANOTHER = "org-another-agency";
const PRIMARY_PROFILE = "consultant-primary";
const COLLAB_HOST_PROFILE = "consultant-collab-hosted";
const COLLAB_INDEP_PROFILE = "consultant-collab-independent";
const COLLAB_SAME_ORG_PROFILE = "consultant-collab-same-org";
const PLAN_ID = "plan-webinar-1";
const PAYMENT_ID = "payment-1";

// We must mock these BEFORE importing earnings-service (which imports them).
jest.mock("../../lib/feature-flags", () => ({
  ENABLE_HOST_ORGS: true,
}));

jest.mock("../../lib/collaborators/service", () => ({
  calculateRevenueSplit: jest.fn(),
}));

jest.mock("../../lib/api/organizations/rate-card", () => ({
  resolveEffectiveRateCard: jest.fn(),
  // #1335 — settlement destructures this from the same module; a partial mock
  // leaves it undefined and every split throws before it resolves a card.
  isScopedRateCardResolutionEnabled: () => false,
}));

// #812 — this suite verifies the per-collaborator EARNINGS-split logic, not the
// double-entry journal. The booking posting is incidental and its mock payment
// amounts aren't designed to balance, so stub postLedgerTxn (the real balance
// invariant is covered by ledger-invariants.test.ts). Real exports (types,
// LedgerImbalanceError) are preserved.
jest.mock("../../lib/payments/ledger/post", () => ({
  ...jest.requireActual("../../lib/payments/ledger/post"),
  postLedgerTxn: jest
    .fn()
    .mockResolvedValue({ transactionId: "ltxn-stub", created: true }),
}));

// Capture every organizationEarnings.create payload across the suite.
type CapturedCreate = {
  organizationId: string;
  paymentId: string;
  grossAmountPaise: number;
  platformFeePaise: number;
  orgSharePaise: number;
  consultantSharePaise: number;
  rateCardIdApplied: string | null;
  platformBpsApplied: number | null;
  orgBpsApplied: number | null;
  consultantBpsApplied: number | null;
};

let capturedOrgEarnings: CapturedCreate[] = [];
let p2002Targets: Set<string> = new Set();

// Mock prisma — must respond to $transaction with a tx object whose
// methods proxy to the mock store.
jest.mock("../../lib/prisma", () => {
  const mockTx = {
    // #812 — createEarningsFromPayment now posts a balanced booking journal and
    // the ledger BLOCKS on failure, so the stub must satisfy postLedgerTxn
    // (idempotency miss → upsert account → create txn → upsert balance). No-ops;
    // the journal is asserted by ledger-specific tests, not this earnings test.
    ledgerTransaction: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "ltxn-1" }),
    },
    ledgerAccount: {
      upsert: jest
        .fn()
        .mockImplementation(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
        })),
    },
    ledgerAccountBalance: { upsert: jest.fn().mockResolvedValue({}) },
    paymentLeg: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    consultantEarnings: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation(async ({ data }: { data: { id?: string } }) => ({
          id: "earnings-" + Math.random().toString(36).slice(2, 8),
          ...data,
        })),
    },
    consultantProfile: {
      update: jest.fn().mockResolvedValue({}),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({ status: "ACTIVE" }),
    },
    organizationInvoice: {
      count: jest.fn().mockResolvedValue(1),
    },
    organizationEarnings: {
      create: jest
        .fn()
        .mockImplementation(async ({ data }: { data: CapturedCreate }) => {
          const key = `${data.paymentId}::${data.organizationId}`;
          if (p2002Targets.has(key)) {
            // Simulate Prisma P2002 unique constraint violation.
            // We can't import Prisma's real error class without dragging
            // the runtime in; throw an object that quacks like one.
            const err = new Error("Unique constraint failed") as Error & {
              code: string;
              clientVersion: string;
              meta: Record<string, unknown>;
            };
            err.code = "P2002";
            err.clientVersion = "test";
            err.meta = { target: ["paymentId", "organizationId"] };
            // Re-tag prototype so `instanceof Prisma.PrismaClientKnownRequestError` matches
            const { Prisma } = jest.requireActual("@prisma/client");
            Object.setPrototypeOf(
              err,
              Prisma.PrismaClientKnownRequestError.prototype,
            );
            throw err;
          }
          capturedOrgEarnings.push(data);
          return { id: "org-earn-" + capturedOrgEarnings.length, ...data };
        }),
    },
    membership: {
      findFirst: jest.fn(),
    },
    // #catalog-archive — resolveOrgSplit reads plan ownership in-transaction so
    // an org-published plan settles to the org that SOLD it. These tests use a
    // personal plan, so both resolve to no owner and the oldest-membership
    // fallback applies, which is what the assertions below already expect.
    webinarPlan: {
      findUnique: jest.fn().mockResolvedValue({ organizationId: null }),
    },
    classPlan: {
      findUnique: jest.fn().mockResolvedValue({ organizationId: null }),
    },
  };
  return {
    __esModule: true,
    default: {
      $transaction: jest
        .fn()
        .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
          return await fn(mockTx);
        }),
      // Expose tx-bound mocks via the default export so tests can
      // configure findFirst per-case.
      __mockTx: mockTx,
    },
  };
});

import prisma from "@/lib/prisma";
import { calculateRevenueSplit } from "@/lib/collaborators/service";
import { resolveEffectiveRateCard } from "@/lib/api/organizations/rate-card";
import { createEarningsFromPayment } from "@/lib/payments/payouts/earnings-service";

// `findFirst` is the time-scoped membership lookup inside resolveOrgSplit.
// We set it per-test to map consultantProfileId -> { orgId, payoutRecipient }.
const mockedTx = (
  prisma as unknown as {
    __mockTx: {
      membership: { findFirst: jest.Mock };
      consultantEarnings: { findFirst: jest.Mock; create: jest.Mock };
      organization: { findUnique: jest.Mock };
      organizationEarnings: { create: jest.Mock };
    };
  }
).__mockTx;

const mockedCalculateSplit = calculateRevenueSplit as jest.MockedFunction<
  typeof calculateRevenueSplit
>;
const mockedResolveRateCard = resolveEffectiveRateCard as jest.MockedFunction<
  typeof resolveEffectiveRateCard
>;

function makePayment(overrides: Partial<{ id: string; amount: number }> = {}) {
  // Minimum shape the service reads.
  return {
    id: overrides.id ?? PAYMENT_ID,
    amount: overrides.amount ?? 100_000,
    originalAmount: overrides.amount ?? 100_000,
    createdAt: new Date("2026-04-01T00:00:00Z"),
    appointment: {
      consultantProfile: { id: PRIMARY_PROFILE },
      webinar: { webinarPlanId: PLAN_ID },
      class: null,
    },
  } as unknown as Parameters<typeof createEarningsFromPayment>[0]["payment"];
}

/**
 * Configure `membership.findFirst` to return the right org per
 * consultantProfileId. Returning `null` simulates an independent
 * consultant (no HOST-org membership).
 */
function setMembershipMap(
  map: Record<
    string,
    { orgId: string; payoutRecipient?: "SELF" | "ORGANIZATION" } | null
  >,
) {
  mockedTx.membership.findFirst.mockImplementation(
    async (args: { where: { consultantProfileId: string } }) => {
      const cfg = map[args.where.consultantProfileId];
      if (!cfg) return null;
      return {
        id: `mem-${args.where.consultantProfileId}`,
        rateCardOverrideId: null,
        payoutRecipient: cfg.payoutRecipient ?? "SELF",
        organization: { id: cfg.orgId },
      };
    },
  );
}

/** Standard rate card: 10% platform / 5% org / 85% consultant. */
function setStandardRateCard() {
  mockedResolveRateCard.mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (_tx: unknown, params: { orgId: string | null }) => ({
      rateCardId: `rc-${params.orgId}`,
      platformBps: 1000,
      orgBps: 500,
      consultantBps: 8500,
      ownerOrgId: params.orgId,
      ownerContractId: null,
    })) as any,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  capturedOrgEarnings = [];
  p2002Targets = new Set();
  // Reset findFirst on consultantEarnings (idempotency check) to "no existing".
  mockedTx.consultantEarnings.findFirst.mockResolvedValue(null);
  mockedTx.organization.findUnique.mockResolvedValue({ status: "ACTIVE" });
  // Restore the default organizationEarnings.create impl — test #2
  // overrides this with a stateful counter via mockImplementation that
  // jest.clearAllMocks() does NOT reset. Without this restore, the
  // stale impl leaks into later tests in the file.
  mockedTx.organizationEarnings.create.mockImplementation(
    async ({ data }: { data: CapturedCreate }) => {
      const key = `${data.paymentId}::${data.organizationId}`;
      if (p2002Targets.has(key)) {
        const { Prisma } = jest.requireActual("@prisma/client");
        const err = new Error("Unique constraint failed") as Error & {
          code: string;
          clientVersion: string;
          meta: Record<string, unknown>;
        };
        err.code = "P2002";
        err.clientVersion = "test";
        err.meta = { target: ["paymentId", "organizationId"] };
        Object.setPrototypeOf(
          err,
          Prisma.PrismaClientKnownRequestError.prototype,
        );
        throw err;
      }
      capturedOrgEarnings.push(data);
      return { id: "org-earn-" + capturedOrgEarnings.length, ...data };
    },
  );
  setStandardRateCard();
});

describe("A3 (Q3): per-collaborator HOST-org earnings", () => {
  it("creates one OrgEarnings row per HOST-org collaborator (skips independents)", async () => {
    setMembershipMap({
      [PRIMARY_PROFILE]: { orgId: ORG_LEARNPRO },
      [COLLAB_HOST_PROFILE]: { orgId: ORG_ANOTHER },
      [COLLAB_INDEP_PROFILE]: null, // independent, no HOST membership
    });

    // 100k gross. Primary org takes 10% platform, 5% org → 85k goes
    // to the consultant pool. Splits: 30% to the hosted collab, 20% to
    // the independent collab → owner keeps the rest.
    mockedCalculateSplit.mockResolvedValue([
      { consultantProfileId: PRIMARY_PROFILE, share: 42_500, role: "OWNER" },
      {
        consultantProfileId: COLLAB_HOST_PROFILE,
        share: 25_500,
        role: "CO_HOST",
      },
      {
        consultantProfileId: COLLAB_INDEP_PROFILE,
        share: 17_000,
        role: "CO_HOST",
      },
    ]);

    await createEarningsFromPayment({
      payment: makePayment(),
      appointmentType: "WEBINAR",
    });

    // Expect 2 OrgEarnings rows: LearnPro (primary) + AnotherAgency (hosted collab).
    // Independent collab gets no row.
    expect(capturedOrgEarnings).toHaveLength(2);

    const learnpro = capturedOrgEarnings.find(
      (r) => r.organizationId === ORG_LEARNPRO,
    );
    const anotherAgency = capturedOrgEarnings.find(
      (r) => r.organizationId === ORG_ANOTHER,
    );

    expect(learnpro).toBeDefined();
    expect(anotherAgency).toBeDefined();

    // Primary org: gross is the full payment.
    expect(learnpro!.grossAmountPaise).toBe(100_000);
    expect(learnpro!.platformFeePaise).toBe(10_000); // 10%
    expect(learnpro!.orgSharePaise).toBe(5_000); // 5%
    expect(learnpro!.consultantSharePaise).toBe(85_000); // 85%

    // Collab org: "gross" is the collaborator's share (25_500), then
    // routed through that org's rate card.
    expect(anotherAgency!.grossAmountPaise).toBe(25_500);
    expect(anotherAgency!.platformFeePaise).toBe(2_550); // 10% of 25_500
    expect(anotherAgency!.orgSharePaise).toBe(1_275); // 5% of 25_500
    expect(anotherAgency!.consultantSharePaise).toBe(21_675); // 85% of 25_500
    expect(anotherAgency!.rateCardIdApplied).toBe(`rc-${ORG_ANOTHER}`);

    // No row for the independent collaborator's profile id was ever passed.
    const independentRows = capturedOrgEarnings.filter((r) =>
      r.organizationId.includes("indep"),
    );
    expect(independentRows).toHaveLength(0);
  });

  it("does NOT create a second row when collaborator shares the primary expert's org (P2002 collision → skip + log)", async () => {
    setMembershipMap({
      [PRIMARY_PROFILE]: { orgId: ORG_LEARNPRO },
      [COLLAB_SAME_ORG_PROFILE]: { orgId: ORG_LEARNPRO }, // same org as primary
    });

    mockedCalculateSplit.mockResolvedValue([
      { consultantProfileId: PRIMARY_PROFILE, share: 60_000, role: "OWNER" },
      {
        consultantProfileId: COLLAB_SAME_ORG_PROFILE,
        share: 25_000,
        role: "CO_HOST",
      },
    ]);

    // Pre-arm the P2002 trap on (PAYMENT_ID, ORG_LEARNPRO) to fire on
    // the SECOND insert — first call (primary) succeeds, second call
    // (same-org collab) collides.
    let learnproInsertCount = 0;
    mockedTx.organizationEarnings.create.mockImplementation(
      async ({ data }: { data: CapturedCreate }) => {
        if (data.organizationId === ORG_LEARNPRO) {
          learnproInsertCount += 1;
          if (learnproInsertCount > 1) {
            const { Prisma } = jest.requireActual("@prisma/client");
            const err = new Error("Unique constraint failed") as Error & {
              code: string;
              clientVersion: string;
              meta: Record<string, unknown>;
            };
            err.code = "P2002";
            err.clientVersion = "test";
            err.meta = { target: ["paymentId", "organizationId"] };
            Object.setPrototypeOf(
              err,
              Prisma.PrismaClientKnownRequestError.prototype,
            );
            throw err;
          }
        }
        capturedOrgEarnings.push(data);
        return { id: "org-earn", ...data };
      },
    );

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await createEarningsFromPayment({
      payment: makePayment(),
      appointmentType: "WEBINAR",
    });

    // Only the primary expert's row survives the same-org collision.
    expect(capturedOrgEarnings).toHaveLength(1);
    expect(capturedOrgEarnings[0].organizationId).toBe(ORG_LEARNPRO);

    // The skip path log-warns rather than throwing.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipping collaborator org earnings"),
    );

    warnSpy.mockRestore();
  });

  it("creates an OrgEarnings row when the primary expert is independent but a collaborator IS at a HOST org", async () => {
    // Primary independent → no OWNER OrganizationEarnings, but the
    // collaborator's HOST membership still drives a per-collab row.
    setMembershipMap({
      [PRIMARY_PROFILE]: null, // independent owner
      [COLLAB_HOST_PROFILE]: { orgId: ORG_ANOTHER },
    });

    mockedCalculateSplit.mockResolvedValue([
      { consultantProfileId: PRIMARY_PROFILE, share: 70_000, role: "OWNER" },
      {
        consultantProfileId: COLLAB_HOST_PROFILE,
        share: 30_000,
        role: "CO_HOST",
      },
    ]);

    await createEarningsFromPayment({
      payment: makePayment(),
      appointmentType: "WEBINAR",
    });

    expect(capturedOrgEarnings).toHaveLength(1);
    expect(capturedOrgEarnings[0].organizationId).toBe(ORG_ANOTHER);
    expect(capturedOrgEarnings[0].grossAmountPaise).toBe(30_000);
    expect(capturedOrgEarnings[0].platformFeePaise).toBe(3_000);
    expect(capturedOrgEarnings[0].orgSharePaise).toBe(1_500);
    expect(capturedOrgEarnings[0].consultantSharePaise).toBe(25_500);
  });

  it("skips zero-share collaborators (defensive — no 0-paise org rows)", async () => {
    setMembershipMap({
      [PRIMARY_PROFILE]: { orgId: ORG_LEARNPRO },
      [COLLAB_HOST_PROFILE]: { orgId: ORG_ANOTHER },
    });

    mockedCalculateSplit.mockResolvedValue([
      { consultantProfileId: PRIMARY_PROFILE, share: 100_000, role: "OWNER" },
      { consultantProfileId: COLLAB_HOST_PROFILE, share: 0, role: "CO_HOST" }, // zeroed out
    ]);

    await createEarningsFromPayment({
      payment: makePayment(),
      appointmentType: "WEBINAR",
    });

    // Only the primary org row — collab share=0 short-circuits before
    // resolveOrgSplit is even called.
    expect(capturedOrgEarnings).toHaveLength(1);
    expect(capturedOrgEarnings[0].organizationId).toBe(ORG_LEARNPRO);
  });
});
