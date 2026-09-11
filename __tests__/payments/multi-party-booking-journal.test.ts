/**
 * @jest-environment node
 */

/**
 * #773 — multi-collaborator BOOKING journal coverage.
 *
 * `createEarningsFromPayment` must post ONE balanced `booking:<paymentId>`
 * transaction covering owner + every collaborator + their host orgs:
 *
 *   Dr funding legs (CASH/…/DISCOUNT plug)
 *     == Cr PLATFORM_FEE (primary fee + settled collabs' org-card fee slices)
 *      + Cr CONSULTANT_PAYABLE per party (settled collabs NET of org cut)
 *      + Cr ORG_PAYABLE per host org (primary + per-collab)
 *      + Cr GST_PAYABLE.
 *
 * Unlike collaborator-org-earnings.test.ts (which stubs postLedgerTxn), this
 * suite runs the REAL postLedgerTxn against the mock tx, so the Σdebit ==
 * Σcredit invariant is genuinely enforced — an unbalanced posting fails the
 * test the same way it would roll back a production booking (#812).
 */

const ORG_LEARNPRO = "org-learnpro";
const ORG_ANOTHER = "org-another-agency";
const PRIMARY_PROFILE = "consultant-primary";
const COLLAB_HOST_PROFILE = "consultant-collab-hosted";
const COLLAB_INDEP_PROFILE = "consultant-collab-independent";
const PLAN_ID = "plan-webinar-1";
const PAYMENT_ID = "payment-1";

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

type CapturedLedgerCreate = {
  idempotencyKey: string;
  kind: string;
  paymentId: string | null;
  entries: {
    create: Array<{
      accountId: string;
      direction: "DEBIT" | "CREDIT";
      amountPaise: bigint;
    }>;
  };
};

type CapturedEarningsCreate = {
  consultantProfileId: string;
  platformFeePaise: number;
  consultantSharePaise: number;
  role?: string;
};

type CapturedOrgEarningsCreate = {
  organizationId: string;
  grossAmountPaise: number;
  platformFeePaise: number;
  orgSharePaise: number;
  consultantSharePaise: number;
};

let capturedLedgerTxns: CapturedLedgerCreate[] = [];
let capturedEarnings: CapturedEarningsCreate[] = [];
let capturedOrgEarnings: CapturedOrgEarningsCreate[] = [];

jest.mock("../../lib/prisma", () => {
  const mockTx = {
    ledgerTransaction: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation(
          async ({ data }: { data: CapturedLedgerCreate }) => {
            capturedLedgerTxns.push(data);
            return { id: "ltxn-" + capturedLedgerTxns.length };
          },
        ),
    },
    ledgerAccount: {
      upsert: jest
        .fn()
        .mockImplementation(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
        })),
    },
    ledgerAccountBalance: { upsert: jest.fn().mockResolvedValue({}) },
    paymentLeg: { findMany: jest.fn().mockResolvedValue([]) },
    // #1458 — only read when an OVERAGE_INVOICE_ACCRUAL leg funded the payment.
    overageEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    consultantEarnings: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation(
          async ({ data }: { data: CapturedEarningsCreate }) => {
            capturedEarnings.push(data);
            return { id: "earn-" + capturedEarnings.length, ...data };
          },
        ),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({ status: "ACTIVE" }),
    },
    organizationInvoice: { count: jest.fn().mockResolvedValue(1) },
    organizationEarnings: {
      create: jest
        .fn()
        .mockImplementation(
          async ({ data }: { data: CapturedOrgEarningsCreate }) => {
            capturedOrgEarnings.push(data);
            return { id: "org-earn-" + capturedOrgEarnings.length, ...data };
          },
        ),
    },
    membership: { findFirst: jest.fn() },
    // #catalog-archive — resolveOrgSplit now reads plan ownership in-transaction
    // so an org-published plan settles to the org that SOLD it. These fixtures
    // use personal plans, so no owner is found and the previous
    // oldest-membership behaviour (which these assertions encode) still applies.
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
      __mockTx: mockTx,
    },
  };
});

import prisma from "@/lib/prisma";
import { calculateRevenueSplit } from "@/lib/collaborators/service";
import { resolveEffectiveRateCard } from "@/lib/api/organizations/rate-card";
import { createEarningsFromPayment } from "@/lib/payments/payouts/earnings-service";

const mockedTx = (
  prisma as unknown as {
    __mockTx: {
      membership: { findFirst: jest.Mock };
      consultantEarnings: { findFirst: jest.Mock; create: jest.Mock };
      ledgerTransaction: { findUnique: jest.Mock; create: jest.Mock };
      paymentLeg: { findMany: jest.Mock };
      overageEvent: { findFirst: jest.Mock };
    };
  }
).__mockTx;

const mockedCalculateSplit = calculateRevenueSplit as jest.MockedFunction<
  typeof calculateRevenueSplit
>;
const mockedResolveRateCard = resolveEffectiveRateCard as jest.MockedFunction<
  typeof resolveEffectiveRateCard
>;

function makePayment(
  overrides: Partial<{
    id: string;
    amount: number;
    originalAmount: number;
    taxAmount: number;
  }> = {},
) {
  return {
    id: overrides.id ?? PAYMENT_ID,
    amount: overrides.amount ?? 118_000,
    originalAmount: overrides.originalAmount ?? 100_000,
    taxAmount: overrides.taxAmount ?? 18_000,
    createdAt: new Date("2026-04-01T00:00:00Z"),
    appointment: {
      consultantProfile: { id: PRIMARY_PROFILE },
      webinar: { webinarPlanId: PLAN_ID },
      class: null,
    },
  } as unknown as Parameters<typeof createEarningsFromPayment>[0]["payment"];
}

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
  mockedResolveRateCard.mockImplementation(async (_tx, params) => ({
    rateCardId: `rc-${params.orgId}`,
    platformBps: 1000,
    orgBps: 500,
    consultantBps: 8500,
  }));
}

/** Decode the captured postings into { accountId, direction, paise } rows. */
function legsOf(txn: CapturedLedgerCreate) {
  return txn.entries.create.map((e) => ({
    accountId: e.accountId,
    direction: e.direction,
    paise: Number(e.amountPaise),
  }));
}

function legAmount(
  txn: CapturedLedgerCreate,
  direction: "DEBIT" | "CREDIT",
  accountId: string,
): number {
  return legsOf(txn)
    .filter((l) => l.direction === direction && l.accountId === accountId)
    .reduce((s, l) => s + l.paise, 0);
}

beforeEach(() => {
  jest.clearAllMocks();
  capturedLedgerTxns = [];
  capturedEarnings = [];
  capturedOrgEarnings = [];
  mockedTx.consultantEarnings.findFirst.mockResolvedValue(null);
  mockedTx.ledgerTransaction.findUnique.mockResolvedValue(null);
  mockedTx.paymentLeg.findMany.mockResolvedValue([]);
  mockedTx.overageEvent.findFirst.mockResolvedValue(null);
  setStandardRateCard();
});

describe("#773 multi-party booking journal", () => {
  it("posts ONE balanced booking txn with per-party credit legs (hosted collab NET, org + fee slices split out)", async () => {
    setMembershipMap({
      [PRIMARY_PROFILE]: { orgId: ORG_LEARNPRO },
      [COLLAB_HOST_PROFILE]: { orgId: ORG_ANOTHER },
      [COLLAB_INDEP_PROFILE]: null, // independent — full share, no org legs
    });

    // 100_000 gross + 18_000 GST, charged 118_000. Primary 10/5/85 card:
    // fee 10_000, LearnPro 5_000, pool 85_000. Odd-paise shares exercise the
    // #778 §C floors: the owner's 42_501 is the pool remainder after the
    // collaborator floors (residual-to-OWNER, calculateRevenueSplit), and the
    // hosted collab's 25_499 re-splits on ORG_ANOTHER's card with floors —
    // fee 2_549, net 21_674, org absorbs the remainder 1_276.
    mockedCalculateSplit.mockResolvedValue([
      { consultantProfileId: PRIMARY_PROFILE, share: 42_501, role: "OWNER" },
      {
        consultantProfileId: COLLAB_HOST_PROFILE,
        share: 25_499,
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

    // Exactly ONE booking txn, keyed booking:<paymentId>.
    expect(capturedLedgerTxns).toHaveLength(1);
    const txn = capturedLedgerTxns[0];
    expect(txn.idempotencyKey).toBe(`booking:${PAYMENT_ID}`);
    expect(txn.kind).toBe("BOOKING");
    expect(txn.paymentId).toBe(PAYMENT_ID);

    // Balanced to the paise (postLedgerTxn would have thrown otherwise, but
    // assert explicitly so a stub regression can't mask it).
    const legs = legsOf(txn);
    const debit = legs
      .filter((l) => l.direction === "DEBIT")
      .reduce((s, l) => s + l.paise, 0);
    const credit = legs
      .filter((l) => l.direction === "CREDIT")
      .reduce((s, l) => s + l.paise, 0);
    expect(debit).toBe(118_000);
    expect(credit).toBe(118_000);

    // Funding side: legacy CASH (no PaymentLegs), no discount gap.
    expect(legAmount(txn, "DEBIT", "CASH|_|_|INR")).toBe(118_000);

    // Per-party credits. PLATFORM_FEE = primary 10_000 + hosted collab's
    // org-card slice 2_549 (one summed leg).
    expect(legAmount(txn, "CREDIT", "PLATFORM_FEE|_|_|INR")).toBe(12_549);
    expect(
      legAmount(txn, "CREDIT", `CONSULTANT_PAYABLE|_|${PRIMARY_PROFILE}|INR`),
    ).toBe(42_501);
    // Hosted collaborator: NET of ORG_ANOTHER's cut.
    expect(
      legAmount(
        txn,
        "CREDIT",
        `CONSULTANT_PAYABLE|_|${COLLAB_HOST_PROFILE}|INR`,
      ),
    ).toBe(21_674);
    // Independent collaborator: full share.
    expect(
      legAmount(
        txn,
        "CREDIT",
        `CONSULTANT_PAYABLE|_|${COLLAB_INDEP_PROFILE}|INR`,
      ),
    ).toBe(17_000);
    expect(legAmount(txn, "CREDIT", `ORG_PAYABLE|${ORG_LEARNPRO}|_|INR`)).toBe(
      5_000,
    );
    expect(legAmount(txn, "CREDIT", `ORG_PAYABLE|${ORG_ANOTHER}|_|INR`)).toBe(
      1_276,
    );
    expect(legAmount(txn, "CREDIT", "GST_PAYABLE|_|_|INR")).toBe(18_000);

    // The cached rows mirror the journal (EARNINGS_LEDGER_DRIFT contract):
    // hosted collab's ConsultantEarnings carries the NET + the fee slice.
    const hostedRow = capturedEarnings.find(
      (e) => e.consultantProfileId === COLLAB_HOST_PROFILE,
    );
    expect(hostedRow).toMatchObject({
      consultantSharePaise: 21_674,
      platformFeePaise: 2_549,
    });
    const indepRow = capturedEarnings.find(
      (e) => e.consultantProfileId === COLLAB_INDEP_PROFILE,
    );
    expect(indepRow).toMatchObject({
      consultantSharePaise: 17_000,
      platformFeePaise: 0,
    });
    const anotherOrgRow = capturedOrgEarnings.find(
      (r) => r.organizationId === ORG_ANOTHER,
    );
    expect(anotherOrgRow).toMatchObject({
      grossAmountPaise: 25_499,
      platformFeePaise: 2_549,
      orgSharePaise: 1_276,
      consultantSharePaise: 21_674,
    });
  });

  it("floors the marketplace platform fee (#778 §C-2) — the consultant pool absorbs the remainder", async () => {
    // No HOST orgs anywhere → flat PLATFORM_FEE_PERCENTAGE (20%) path.
    setMembershipMap({
      [PRIMARY_PROFILE]: null,
      [COLLAB_INDEP_PROFILE]: null,
    });

    // 99_999 × 20% = 19_999.8 → floor 19_999 (round would mint 20_000 and
    // shave the pool); pool = 80_000, split 60_000 owner + 20_000 collab.
    mockedCalculateSplit.mockResolvedValue([
      { consultantProfileId: PRIMARY_PROFILE, share: 60_000, role: "OWNER" },
      {
        consultantProfileId: COLLAB_INDEP_PROFILE,
        share: 20_000,
        role: "CO_HOST",
      },
    ]);

    await createEarningsFromPayment({
      payment: makePayment({
        amount: 99_999,
        originalAmount: 99_999,
        taxAmount: 0,
      }),
      appointmentType: "WEBINAR",
    });

    expect(capturedLedgerTxns).toHaveLength(1);
    const txn = capturedLedgerTxns[0];
    expect(legAmount(txn, "CREDIT", "PLATFORM_FEE|_|_|INR")).toBe(19_999);
    expect(
      legAmount(txn, "CREDIT", `CONSULTANT_PAYABLE|_|${PRIMARY_PROFILE}|INR`),
    ).toBe(60_000);
    expect(
      legAmount(
        txn,
        "CREDIT",
        `CONSULTANT_PAYABLE|_|${COLLAB_INDEP_PROFILE}|INR`,
      ),
    ).toBe(20_000);
    const legs = legsOf(txn);
    const debit = legs
      .filter((l) => l.direction === "DEBIT")
      .reduce((s, l) => s + l.paise, 0);
    const credit = legs
      .filter((l) => l.direction === "CREDIT")
      .reduce((s, l) => s + l.paise, 0);
    expect(debit).toBe(99_999);
    expect(credit).toBe(99_999);
  });

  it("is idempotent at the journal level — an existing booking:<paymentId> txn is never re-posted", async () => {
    setMembershipMap({
      [PRIMARY_PROFILE]: { orgId: ORG_LEARNPRO },
      [COLLAB_HOST_PROFILE]: { orgId: ORG_ANOTHER },
    });
    mockedCalculateSplit.mockResolvedValue([
      { consultantProfileId: PRIMARY_PROFILE, share: 59_501, role: "OWNER" },
      {
        consultantProfileId: COLLAB_HOST_PROFILE,
        share: 25_499,
        role: "CO_HOST",
      },
    ]);
    // Crash-recovery shape: the journal txn survived but the earnings tx is
    // being replayed — postLedgerTxn's fast-path must dedupe on the key.
    mockedTx.ledgerTransaction.findUnique.mockResolvedValue({
      id: "ltxn-existing",
    });

    const ownerId = await createEarningsFromPayment({
      payment: makePayment(),
      appointmentType: "WEBINAR",
    });

    expect(ownerId).not.toBeNull();
    expect(mockedTx.ledgerTransaction.create).not.toHaveBeenCalled();
    expect(capturedLedgerTxns).toHaveLength(0);
  });

  it("is idempotent on redelivery — existing earnings short-circuit before any journal work", async () => {
    setMembershipMap({ [PRIMARY_PROFILE]: { orgId: ORG_LEARNPRO } });
    mockedCalculateSplit.mockResolvedValue([]);
    mockedTx.consultantEarnings.findFirst.mockResolvedValue({
      id: "earn-existing",
    });

    const result = await createEarningsFromPayment({
      payment: makePayment(),
      appointmentType: "WEBINAR",
    });

    expect(result).toBe("earn-existing");
    expect(mockedTx.consultantEarnings.create).not.toHaveBeenCalled();
    expect(mockedTx.ledgerTransaction.create).not.toHaveBeenCalled();
  });
});

/**
 * #1458 / Sentry FAMILIARISE_WEB-28 — the BOOKING posting's credits are all
 * derived from `payment.originalAmount` (+ tax), while its debits are the
 * funding legs plus a DISCOUNT plug clamped at >= 0. The posting therefore
 * balances only while Σ(funding legs) <= originalAmount + tax; anything that
 * pushes a funding leg above the nominal price throws LedgerImbalanceError and
 * the booking commits with no journal entry at all.
 */
describe("#1458 org-overage rails keep the booking journal balanced", () => {
  it("WALLET + CHARGE_ORG: the wallet leg alone funds the price and the posting balances", async () => {
    // The exact #1458 payment: a 258,326-paise wallet debit on a 218,920 +
    // 39,406 booking. Before the fix an OVERAGE_INVOICE_ACCRUAL leg of 248,326
    // was added and Payment.amount became 506,652, so debits overshot the
    // credits by the marginal and the journal was dropped.
    setMembershipMap({ [PRIMARY_PROFILE]: null });
    mockedCalculateSplit.mockResolvedValue([]);
    mockedTx.paymentLeg.findMany.mockResolvedValue([
      { source: "WALLET", amountPaise: 258_326 },
    ]);

    await createEarningsFromPayment({
      payment: makePayment({
        amount: 258_326,
        originalAmount: 218_920,
        taxAmount: 39_406,
      }),
      appointmentType: "CONSULTATION",
    });

    const txn = capturedLedgerTxns[0];
    const legs = legsOf(txn);
    const debit = legs
      .filter((l) => l.direction === "DEBIT")
      .reduce((s, l) => s + l.paise, 0);
    const credit = legs
      .filter((l) => l.direction === "CREDIT")
      .reduce((s, l) => s + l.paise, 0);
    expect(debit).toBe(258_326);
    expect(credit).toBe(258_326);
    // No leg was added and no amount bumped, so the wallet debit is the whole
    // funding side and the platform absorbs nothing as DISCOUNT.
    expect(legAmount(txn, "DEBIT", "WALLET|_|_|INR")).toBe(258_326);
    expect(legAmount(txn, "DEBIT", "DISCOUNT|_|_|INR")).toBe(0);
    expect(mockedTx.overageEvent.findFirst).not.toHaveBeenCalled();
  });

  it("INVOICE + CHARGE_ORG with a surcharge: the surcharge is credited to PLATFORM_FEE", async () => {
    // #785's carve leaves INVOICE_ACCRUAL at 0 and OVERAGE_INVOICE_ACCRUAL at
    // base + surcharge, and bumps Payment.amount by the surcharge — which is
    // real funding that sits OUTSIDE originalAmount. The surcharge is platform
    // revenue for exceeding the cap, so it credits PLATFORM_FEE.
    setMembershipMap({ [PRIMARY_PROFILE]: null });
    mockedCalculateSplit.mockResolvedValue([]);
    mockedTx.paymentLeg.findMany.mockResolvedValue([
      { source: "INVOICE_ACCRUAL", amountPaise: 0 },
      { source: "OVERAGE_INVOICE_ACCRUAL", amountPaise: 125_000 },
    ]);
    mockedTx.overageEvent.findFirst.mockResolvedValue({
      surchargePaise: BigInt(25_000),
    });

    await createEarningsFromPayment({
      payment: makePayment({
        amount: 125_000,
        originalAmount: 100_000,
        taxAmount: 0,
      }),
      appointmentType: "CONSULTATION",
    });

    const txn = capturedLedgerTxns[0];
    const legs = legsOf(txn);
    const debit = legs
      .filter((l) => l.direction === "DEBIT")
      .reduce((s, l) => s + l.paise, 0);
    const credit = legs
      .filter((l) => l.direction === "CREDIT")
      .reduce((s, l) => s + l.paise, 0);
    expect(debit).toBe(125_000);
    expect(credit).toBe(125_000);
    // 20% of the nominal 100_000 plus the whole 25_000 surcharge; the
    // consultant pool stays on the nominal price alone.
    expect(legAmount(txn, "CREDIT", "PLATFORM_FEE|_|_|INR")).toBe(45_000);
    expect(
      legAmount(txn, "CREDIT", `CONSULTANT_PAYABLE|_|${PRIMARY_PROFILE}|INR`),
    ).toBe(80_000);
  });
});
