/**
 * @jest-environment node
 */

/**
 * A scoped rate card only settles money when the flag says so.
 *
 * `resolveEffectiveRateCard` has always ranked contract- and plan-scoped cards
 * above the org default, but settlement handed it the org alone, so those tiers
 * were unreachable: an org could create a plan-scoped card through the POST
 * route and watch every booking settle on the org default instead. #1335
 * forwards the booking's scope behind `RATE_CARD_SCOPED_RESOLUTION`, off by
 * default, because the flip changes which card pays live money.
 *
 * The resolver is deliberately NOT mocked here — the point of the pin is the
 * whole chain from `createEarningsFromPayment` down to the bps that land on the
 * earnings rows.
 */

const EXPERT = "consultant-expert";
const ORG = "org-host";
const OTHER_ORG = "org-someone-else";
const PAYMENT_ID = "pay-scoped-1";
const PLAN_ID = "webinar-plan-1";
const GROSS = 100_000;

const ORG_DEFAULT_CARD = {
  id: "rc-org-default",
  platformBps: 1000,
  orgBps: 1000,
  consultantBps: 8000,
};
const PLAN_SCOPED_CARD = {
  id: "rc-plan-scoped",
  platformBps: 2000,
  orgBps: 1000,
  consultantBps: 7000,
};
/** Owned by a contract belonging to OTHER_ORG — must never settle ORG's booking. */
const FOREIGN_CONTRACT_CARD = {
  id: "rc-foreign-contract",
  platformBps: 5000,
  orgBps: 1000,
  consultantBps: 4000,
};

interface Captured {
  [k: string]: unknown;
}
const capturedConsultantEarnings: Captured[] = [];
const capturedOrgEarnings: Captured[] = [];

jest.mock("../../lib/collaborators/service", () => ({
  calculateRevenueSplit: jest.fn().mockResolvedValue([]),
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
      upsert: jest.fn().mockResolvedValue({ id: "ledger-1" }),
    },
    ledgerAccountBalance: { upsert: jest.fn().mockResolvedValue({}) },
    paymentLeg: { findMany: jest.fn().mockResolvedValue([]) },
    consultantEarnings: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation(async ({ data }: { data: Captured }) => {
          capturedConsultantEarnings.push(data);
          return { id: "earn-1", ...data };
        }),
    },
    consultantProfile: { update: jest.fn().mockResolvedValue({}) },
    organization: {
      findUnique: jest.fn().mockResolvedValue({ status: "ACTIVE" }),
    },
    organizationInvoice: { count: jest.fn().mockResolvedValue(1) },
    organizationEarnings: {
      create: jest
        .fn()
        .mockImplementation(async ({ data }: { data: Captured }) => {
          capturedOrgEarnings.push(data);
          return { id: "org-earn-1", ...data };
        }),
    },
    membership: { findFirst: jest.fn() },
    webinarPlan: { findUnique: jest.fn() },
    classPlan: {
      findUnique: jest.fn().mockResolvedValue({ organizationId: null }),
    },
    bookingUtilization: { findUnique: jest.fn().mockResolvedValue(null) },
    rateCard: { findFirst: jest.fn() },
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
import { createEarningsFromPayment } from "@/lib/payments/payouts/earnings-service";

type CardWhere = {
  ownerOrgId?: string;
  ownerContractId?: string;
  planType?: string | null;
  planId?: string | null;
};

const tx = (
  prisma as unknown as {
    __mockTx: {
      rateCard: { findFirst: jest.Mock };
      bookingUtilization: { findUnique: jest.Mock };
      membership: { findFirst: jest.Mock };
      webinarPlan: { findUnique: jest.Mock };
    };
  }
).__mockTx;

function payment() {
  return {
    id: PAYMENT_ID,
    amount: GROSS,
    originalAmount: GROSS,
    organizationId: null,
    billingAccountId: null,
    createdAt: new Date("2026-09-03T00:00:00Z"),
    appointment: {
      consultantProfile: { id: EXPERT },
      webinar: { webinarPlanId: PLAN_ID },
      class: null,
    },
  } as unknown as Parameters<typeof createEarningsFromPayment>[0]["payment"];
}

async function settle() {
  await createEarningsFromPayment({
    payment: payment(),
    appointmentType: "WEBINAR",
  } as unknown as Parameters<typeof createEarningsFromPayment>[0]);
}

beforeEach(() => {
  capturedConsultantEarnings.length = 0;
  capturedOrgEarnings.length = 0;
  delete process.env.RATE_CARD_SCOPED_RESOLUTION;
  tx.bookingUtilization.findUnique.mockResolvedValue(null);
  tx.membership.findFirst.mockResolvedValue({
    id: "mem-1",
    rateCardOverrideId: null,
    payoutRecipient: "SELF",
    organization: { id: ORG },
  });
  tx.webinarPlan.findUnique.mockResolvedValue({ organizationId: ORG });
  tx.rateCard.findFirst.mockImplementation(
    async ({ where }: { where: CardWhere }) => {
      if (where.ownerContractId) return FOREIGN_CONTRACT_CARD;
      if (where.ownerOrgId !== ORG) return null;
      if (where.planId === PLAN_ID) return PLAN_SCOPED_CARD;
      if (where.planType === null && where.planId === null)
        return ORG_DEFAULT_CARD;
      return null;
    },
  );
});

afterEach(() => {
  delete process.env.RATE_CARD_SCOPED_RESOLUTION;
});

describe("#1335 — scoped rate cards reach settlement only behind the flag", () => {
  it("settles on the plan-scoped card when the flag is on", async () => {
    process.env.RATE_CARD_SCOPED_RESOLUTION = "on";

    await settle();

    expect(capturedOrgEarnings).toHaveLength(1);
    expect(capturedOrgEarnings[0]).toMatchObject({
      rateCardIdApplied: PLAN_SCOPED_CARD.id,
      platformBpsApplied: 2000,
      consultantBpsApplied: 7000,
      platformFeePaise: 20_000,
      consultantSharePaise: 70_000,
      orgSharePaise: 10_000,
    });
    expect(capturedConsultantEarnings[0]).toMatchObject({
      platformFeePaise: 20_000,
      consultantSharePaise: 70_000,
    });
  });

  it("settles on the org default card when the flag is off", async () => {
    await settle();

    expect(capturedOrgEarnings).toHaveLength(1);
    expect(capturedOrgEarnings[0]).toMatchObject({
      rateCardIdApplied: ORG_DEFAULT_CARD.id,
      platformBpsApplied: 1000,
      consultantBpsApplied: 8000,
      platformFeePaise: 10_000,
      consultantSharePaise: 80_000,
      orgSharePaise: 10_000,
    });
    expect(capturedConsultantEarnings[0]).toMatchObject({
      platformFeePaise: 10_000,
      consultantSharePaise: 80_000,
    });
    // The scoped tiers must not even be queried while the flag is off.
    const wheres = tx.rateCard.findFirst.mock.calls.map(
      ([args]: [{ where: CardWhere }]) => args.where,
    );
    expect(wheres.every((w: CardWhere) => w.planId === null)).toBe(true);
  });

  it("never forwards a contract owned by another org", async () => {
    process.env.RATE_CARD_SCOPED_RESOLUTION = "on";
    // The booking is program-funded, but the sponsoring contract belongs to a
    // different tenant. resolveEffectiveRateCard matches ownerContractId without
    // re-checking the org, so forwarding it would settle ORG's booking on
    // OTHER_ORG's negotiated 50/10/40 split.
    tx.bookingUtilization.findUnique.mockResolvedValue({
      programAssignment: {
        program: { contract: { id: "contract-1", organizationId: OTHER_ORG } },
      },
    });

    await settle();

    const wheres = tx.rateCard.findFirst.mock.calls.map(
      ([args]: [{ where: CardWhere }]) => args.where,
    );
    expect(wheres.some((w: CardWhere) => w.ownerContractId !== undefined)).toBe(
      false,
    );
    expect(capturedOrgEarnings[0]).toMatchObject({
      rateCardIdApplied: PLAN_SCOPED_CARD.id,
      platformBpsApplied: 2000,
    });
  });
});
