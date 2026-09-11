/**
 * @jest-environment node
 */

/**
 * The org that SOLD the plan is the org that gets paid.
 *
 * Host-side earnings resolve the settling org from the expert's `Membership`,
 * and the rule was "oldest ACTIVE EXPERT membership at a canHost org wins".
 * That was fine while nothing could set `Plan.organizationId` — every plan was
 * personal, so the expert's own host org was the only sensible answer.
 *
 * The org catalog changes that. Once Org B can publish a plan delivered by an
 * expert who ALSO belongs to Org A, the oldest-membership rule pays Org A for
 * something Org B sold. ADR 18 already records oldest-membership-wins as
 * "known-crude"; this is where it becomes wrong rather than merely crude.
 *
 * These tests pin the resulting rule:
 *   - org-owned plan  -> the OWNING org settles, whatever the join order
 *   - personal plan   -> unchanged, oldest membership still wins
 *   - owning org where the expert is not an ACTIVE expert -> no self-dealing,
 *     fall back rather than pay an org someone does not work for
 */

const EXPERT = "consultant-expert";
const ORG_SELLER = "org-seller-b";
const ORG_OLDEST = "org-oldest-a";
const PAYMENT_ID = "pay-catalog-1";
const PLAN_ID = "webinar-plan-1";

interface CapturedCreate {
  paymentId: string;
  organizationId: string;
  [k: string]: unknown;
}

const capturedOrgEarnings: CapturedCreate[] = [];

jest.mock("../../lib/collaborators/service", () => ({
  calculateRevenueSplit: jest.fn().mockResolvedValue([]),
}));
jest.mock("../../lib/api/organizations/rate-card", () => ({
  resolveEffectiveRateCard: jest.fn(),
  // #1335 — settlement destructures this from the same module; a partial mock
  // leaves it undefined and every split throws before it resolves a card.
  isScopedRateCardResolutionEnabled: () => false,
}));
jest.mock("../../lib/feature-flags", () => ({
  ...jest.requireActual("../../lib/feature-flags"),
  ENABLE_HOST_ORGS: true,
}));

jest.mock("../../lib/payments/ledger/post", () => ({
  ...jest.requireActual("../../lib/payments/ledger/post"),
  postLedgerTxn: jest
    .fn()
    .mockResolvedValue({ transactionId: "ltxn-stub", created: true }),
}));

jest.mock("../../lib/prisma", () => {
  const mockTx = {
    ledgerAccount: {
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockImplementation(async () => ({ id: "ledger-1" })),
    },
    ledgerAccountBalance: { upsert: jest.fn().mockResolvedValue({}) },
    paymentLeg: { findMany: jest.fn().mockResolvedValue([]) },
    consultantEarnings: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation(async ({ data }: { data: object }) => ({
          id: "earn-1",
          ...data,
        })),
    },
    consultantProfile: { update: jest.fn().mockResolvedValue({}) },
    organization: {
      findUnique: jest.fn().mockResolvedValue({ status: "ACTIVE" }),
    },
    organizationInvoice: { count: jest.fn().mockResolvedValue(1) },
    organizationEarnings: {
      create: jest
        .fn()
        .mockImplementation(async ({ data }: { data: CapturedCreate }) => {
          capturedOrgEarnings.push(data);
          return { id: "org-earn-1", ...data };
        }),
    },
    membership: { findFirst: jest.fn() },
    webinarPlan: { findUnique: jest.fn() },
    classPlan: {
      findUnique: jest.fn().mockResolvedValue({ organizationId: null }),
    },
  };
  return {
    __esModule: true,
    default: {
      $transaction: jest
        .fn()
        .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
          fn(mockTx),
        ),
      __mockTx: mockTx,
    },
  };
});

import prisma from "@/lib/prisma";
import { resolveEffectiveRateCard } from "@/lib/api/organizations/rate-card";
import { createEarningsFromPayment } from "@/lib/payments/payouts/earnings-service";

const tx = (
  prisma as unknown as {
    __mockTx: {
      membership: { findFirst: jest.Mock };
      webinarPlan: { findUnique: jest.Mock };
    };
  }
).__mockTx;

const mockedRateCard = resolveEffectiveRateCard as jest.MockedFunction<
  typeof resolveEffectiveRateCard
>;

function payment() {
  return {
    id: PAYMENT_ID,
    amount: 100_000,
    originalAmount: 100_000,
    createdAt: new Date("2026-07-30T00:00:00Z"),
    appointment: {
      consultantProfile: { id: EXPERT },
      webinar: { webinarPlanId: PLAN_ID },
      class: null,
    },
  } as unknown as Parameters<typeof createEarningsFromPayment>[0]["payment"];
}

beforeEach(() => {
  capturedOrgEarnings.length = 0;
  mockedRateCard.mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (_t: unknown, params: { orgId: string | null }) => ({
      rateCardId: `rc-${params.orgId}`,
      platformBps: 1000,
      orgBps: 500,
      consultantBps: 8500,
      ownerOrgId: params.orgId,
      ownerContractId: null,
    })) as any,
  );
});

describe("org-owned plans settle to the selling org", () => {
  it("pays the OWNING org, not the expert's oldest membership", async () => {
    tx.webinarPlan.findUnique.mockResolvedValue({
      organizationId: ORG_SELLER,
    });
    // The scoped lookup finds the expert at the seller org.
    tx.membership.findFirst.mockImplementation(
      async (args: { where: { organizationId?: string } }) =>
        args.where.organizationId === ORG_SELLER
          ? {
              id: "mem-seller",
              rateCardOverrideId: null,
              payoutRecipient: "SELF",
              organization: { id: ORG_SELLER },
            }
          : {
              id: "mem-oldest",
              rateCardOverrideId: null,
              payoutRecipient: "SELF",
              organization: { id: ORG_OLDEST },
            },
    );

    await createEarningsFromPayment({
      payment: payment(),
      appointmentType: "WEBINAR",
    } as unknown as Parameters<typeof createEarningsFromPayment>[0]);

    expect(capturedOrgEarnings).toHaveLength(1);
    expect(capturedOrgEarnings[0].organizationId).toBe(ORG_SELLER);
    // The regression this guards: Org A being paid for Org B's sale.
    expect(capturedOrgEarnings[0].organizationId).not.toBe(ORG_OLDEST);
  });

  it("falls back to the oldest membership for a personal plan", async () => {
    tx.webinarPlan.findUnique.mockResolvedValue({ organizationId: null });
    tx.membership.findFirst.mockResolvedValue({
      id: "mem-oldest",
      rateCardOverrideId: null,
      payoutRecipient: "SELF",
      organization: { id: ORG_OLDEST },
    });

    await createEarningsFromPayment({
      payment: payment(),
      appointmentType: "WEBINAR",
    } as unknown as Parameters<typeof createEarningsFromPayment>[0]);

    expect(capturedOrgEarnings).toHaveLength(1);
    expect(capturedOrgEarnings[0].organizationId).toBe(ORG_OLDEST);
  });

  it("does not pay an owning org the expert does not work for", async () => {
    // Plan claims ORG_SELLER, but the expert holds no ACTIVE EXPERT membership
    // there — the scoped query returns null and we fall back rather than
    // letting a plan row direct money to an org on its own say-so.
    tx.webinarPlan.findUnique.mockResolvedValue({
      organizationId: ORG_SELLER,
    });
    tx.membership.findFirst.mockImplementation(
      async (args: { where: { organizationId?: string } }) =>
        args.where.organizationId === ORG_SELLER
          ? null
          : {
              id: "mem-oldest",
              rateCardOverrideId: null,
              payoutRecipient: "SELF",
              organization: { id: ORG_OLDEST },
            },
    );

    await createEarningsFromPayment({
      payment: payment(),
      appointmentType: "WEBINAR",
    } as unknown as Parameters<typeof createEarningsFromPayment>[0]);

    expect(capturedOrgEarnings).toHaveLength(1);
    expect(capturedOrgEarnings[0].organizationId).toBe(ORG_OLDEST);
  });
});
