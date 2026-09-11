/**
 * @jest-environment node
 */

/**
 * A LICENSE-funded booking must reverse in the ledger, not just in earnings.
 *
 * `Payment.amount` for a licence booking is the full price; only the funding
 * LEG is zero, because the org's contract absorbs the per-booking cost and no
 * money moves. So the refund cascade's `legAmounts` — which filters
 * `amountPaise > 0` — came back empty, `fundingTotal` was 0, and the whole
 * double-entry block was skipped. Steps 6 and 7 had already incremented the
 * consultant's and the org's refunded share and flipped them REFUNDED.
 *
 * The booking journal DOES post for these: with no funding debit it debits
 * DISCOUNT for the gross and credits the payables, the platform fee and GST
 * (earnings-service.ts). Skipping the reversal stranded those credits as
 * permanent EARNINGS_LEDGER_DRIFT that the reconciler flags and cannot repair.
 *
 * This suite deliberately does NOT stub `applyReversal` or `postLedgerTxn`'s
 * arithmetic — the sibling rails suite stubs the engine to check routing, which
 * means it cannot see this class of bug at all. Here the real cascade runs and
 * the emitted journal is inspected.
 */

const mockPostLedgerTxn = jest.fn();
const mockReverseBookingUtilization = jest.fn();
const mockRecordTdsReversal = jest.fn();
const mockWalletCredit = jest.fn();

jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: (...a: unknown[]) => mockPostLedgerTxn(...a),
}));

jest.mock("../../lib/api/organizations/program-helpers", () => ({
  reverseBookingUtilization: (...a: unknown[]) =>
    mockReverseBookingUtilization(...a),
}));

jest.mock("../../lib/payments/tax/tds-service", () => ({
  recordTdsReversal: (...a: unknown[]) => mockRecordTdsReversal(...a),
}));

jest.mock("../../lib/api/organizations/wallet", () => ({
  walletCredit: (...a: unknown[]) => mockWalletCredit(...a),
}));

jest.mock("../../lib/payments/billing/overage-transitions", () => ({
  transitionOverage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: jest.fn().mockResolvedValue(0),
}));

jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

import type { Posting } from "../../lib/payments/ledger/post";
import { applyRefundCascade } from "../../lib/payments/operations/refund";

const PAYMENT_ID = "pay-license";
const REFUND_ID = "refund-1";
const CONSULTANT = "cp-1";
const ORG = "org-1";

/**
 * ₹10,000 licence booking + ₹1,800 GST. Consultant keeps 7,000, the host org
 * 2,000, the platform 1,000 — the same split the booking journal credited.
 */
const GROSS = 1_000_000;
const TAX = 180_000;
const CONSULTANT_SHARE = 700_000;
const ORG_SHARE = 200_000;

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    amount: GROSS,
    originalAmount: GROSS,
    taxAmount: TAX,
    organizationId: ORG,
    billingAccountId: null,
    billableToOrgInvoiceId: null,
    parentPaymentId: null,
    gstTcsCollectedPaise: null,
    // The whole point: one leg, worth nothing.
    legs: [
      {
        id: "leg-1",
        source: "LICENSE",
        amountPaise: 0,
        sourceRef: "assignment-1",
      },
    ],
    earnings: [
      {
        id: "earn-1",
        consultantProfileId: CONSULTANT,
        consultantSharePaise: CONSULTANT_SHARE,
        refundedShareAmount: 0,
        status: "PENDING",
        payoutId: null,
      },
    ],
    organizationEarnings: [
      {
        id: "oe-1",
        organizationId: ORG,
        orgSharePaise: ORG_SHARE,
        refundedAmountPaise: 0,
        status: "PENDING",
        orgPayoutId: null,
        orgPayout: null,
      },
    ],
    bookingUtilization: { id: "util-1", engagementsConsumed: 1 },
    ...overrides,
  };
}

let payment: ReturnType<typeof paymentRow>;

function txStub() {
  return {
    refund: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    payment: {
      findUniqueOrThrow: jest.fn(async () => payment),
      findUnique: jest.fn(async () => payment),
    },
    consultantEarnings: { update: jest.fn().mockResolvedValue({}) },
    organizationEarnings: { update: jest.fn().mockResolvedValue({}) },
    organizationPayout: { update: jest.fn().mockResolvedValue({}) },
    organizationInvoice: { findUnique: jest.fn().mockResolvedValue(null) },
    creditNote: { findUnique: jest.fn().mockResolvedValue(null) },
    // #1365 — the B2C sibling mint probes both of these and no-ops when the
    // payment has no consumer invoice, which is the case in every fixture here.
    consumerCreditNote: { findUnique: jest.fn().mockResolvedValue(null) },
    consumerInvoice: { findUnique: jest.fn().mockResolvedValue(null) },
    overageEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    orgAuditLog: { create: jest.fn().mockResolvedValue({}) },
    paymentLeg: { upsert: jest.fn().mockResolvedValue({}) },
    gstTcsAdjustment: { create: jest.fn().mockResolvedValue({}) },
    ledgerTransaction: { findUnique: jest.fn().mockResolvedValue(null) },
    organization: { findUnique: jest.fn().mockResolvedValue(null) },
  };
}

/** The postings the cascade emitted, flattened. */
function emittedPostings(): Posting[] {
  expect(mockPostLedgerTxn).toHaveBeenCalled();
  return mockPostLedgerTxn.mock.calls[0][1].postings as Posting[];
}

function sum(postings: Posting[], direction: "DEBIT" | "CREDIT"): number {
  return postings
    .filter((p) => p.direction === direction)
    .reduce((s, p) => s + p.amountPaise, 0);
}

beforeEach(() => {
  jest.clearAllMocks();
  payment = paymentRow();
  mockPostLedgerTxn.mockResolvedValue({ id: "txn-1" });
  mockReverseBookingUtilization.mockResolvedValue({
    reversed: true,
    engagementsReversed: 1,
    fullyReversed: true,
  });
});

describe("a full refund of a LICENSE-funded booking", () => {
  it("posts a reversal journal at all", async () => {
    await applyRefundCascade(txStub() as never, {
      paymentId: PAYMENT_ID,
      refundId: REFUND_ID,
      amountPaise: GROSS,
      reason: "cancellation",
    });

    // This is the bug: the block was skipped entirely because every funding
    // leg was worth zero, while the earnings were reversed regardless.
    expect(mockPostLedgerTxn).toHaveBeenCalledTimes(1);
    expect(mockPostLedgerTxn.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        idempotencyKey: `refund:${REFUND_ID}`,
        kind: "REFUND",
        paymentId: PAYMENT_ID,
      }),
    );
  });

  it("balances to the paise", async () => {
    await applyRefundCascade(txStub() as never, {
      paymentId: PAYMENT_ID,
      refundId: REFUND_ID,
      amountPaise: GROSS,
      reason: "cancellation",
    });

    const postings = emittedPostings();
    expect(sum(postings, "DEBIT")).toBe(sum(postings, "CREDIT"));
    expect(sum(postings, "DEBIT")).toBeGreaterThan(0);
  });

  it("returns the funding to DISCOUNT, mirroring the booking journal", async () => {
    await applyRefundCascade(txStub() as never, {
      paymentId: PAYMENT_ID,
      refundId: REFUND_ID,
      amountPaise: GROSS,
      reason: "cancellation",
    });

    const credits = emittedPostings().filter((p) => p.direction === "CREDIT");
    // The booking debited DISCOUNT for gross + tax because no funding leg
    // carried money; the reversal credits the same account for the same total.
    expect(credits).toEqual([
      expect.objectContaining({
        account: expect.objectContaining({ kind: "DISCOUNT" }),
        amountPaise: GROSS + TAX,
      }),
    ]);
  });

  it("debits back every share the booking credited", async () => {
    await applyRefundCascade(txStub() as never, {
      paymentId: PAYMENT_ID,
      refundId: REFUND_ID,
      amountPaise: GROSS,
      reason: "cancellation",
    });

    const debits = emittedPostings().filter((p) => p.direction === "DEBIT");
    const byKind = Object.fromEntries(
      debits.map((d) => [d.account.kind, d.amountPaise]),
    );

    expect(byKind.CONSULTANT_PAYABLE).toBe(CONSULTANT_SHARE);
    expect(byKind.ORG_PAYABLE).toBe(ORG_SHARE);
    expect(byKind.GST_PAYABLE).toBe(TAX);
    // The residual is the platform's own cut, returned in full.
    expect(byKind.PLATFORM_FEE).toBe(GROSS - CONSULTANT_SHARE - ORG_SHARE);
  });

  it("still returns the engagement to the program cap", async () => {
    await applyRefundCascade(txStub() as never, {
      paymentId: PAYMENT_ID,
      refundId: REFUND_ID,
      amountPaise: GROSS,
      reason: "cancellation",
    });

    expect(mockReverseBookingUtilization).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ paymentId: PAYMENT_ID }),
    );
  });
});

describe("a half refund of a LICENSE-funded booking", () => {
  it("balances, and reverses exactly half of every share", async () => {
    await applyRefundCascade(txStub() as never, {
      paymentId: PAYMENT_ID,
      refundId: REFUND_ID,
      amountPaise: GROSS / 2,
      reason: "partial cancellation",
    });

    const postings = emittedPostings();
    expect(sum(postings, "DEBIT")).toBe(sum(postings, "CREDIT"));

    const byKind = Object.fromEntries(
      postings
        .filter((p) => p.direction === "DEBIT")
        .map((d) => [d.account.kind, d.amountPaise]),
    );
    expect(byKind.CONSULTANT_PAYABLE).toBe(CONSULTANT_SHARE / 2);
    expect(byKind.ORG_PAYABLE).toBe(ORG_SHARE / 2);
    expect(byKind.GST_PAYABLE).toBe(TAX / 2);
  });
});

describe("bookings that genuinely have nothing to reverse", () => {
  it("posts no journal when there are no earnings either", async () => {
    payment = paymentRow({ earnings: [], organizationEarnings: [] });

    await applyRefundCascade(txStub() as never, {
      paymentId: PAYMENT_ID,
      refundId: REFUND_ID,
      amountPaise: GROSS,
      reason: "cancellation",
    });

    // No share was ever credited, so there is nothing to take back. Inventing
    // a DISCOUNT credit here would fabricate a one-sided journal.
    expect(mockPostLedgerTxn).not.toHaveBeenCalled();
  });
});
