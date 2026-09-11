/**
 * @jest-environment node
 */

/**
 * #677 — a lost chargeback on a B2C (non-org) booking must post the REFUND
 * ledger leg, exactly as the org path does via applyOrgChargeback. Before this
 * fix the B2C path flipped earnings to REFUNDED but posted nothing, so the
 * booking journal kept its CASH-in + payable and the reconcile cron flagged
 * REVERSED_EARNING_WITHOUT_REFUND_TXN ("the cash left but the payable was never
 * cleared in the journal").
 *
 * Unit-tests applyB2cChargebackReversal directly: we seed the original
 * `booking:<paymentId>` journal in an in-memory tx stub, mock postLedgerTxn, and
 * assert the reversal it builds is the (proportional) inverse and always balances.
 */

const postLedgerTxn = jest.fn().mockResolvedValue({
  transactionId: "t1",
  created: true,
});
const recordSystemError = jest.fn().mockResolvedValue(undefined);

jest.mock("../../lib/payments/ledger/post", () => ({
  __esModule: true,
  postLedgerTxn: (...a: unknown[]) => postLedgerTxn(...a),
  ledgerBalancePaise: jest.fn(),
  ledgerBalanceFromJournalPaise: jest.fn(),
  ledgerAccountId: jest.fn(),
  LedgerImbalanceError: class extends Error {},
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  __esModule: true,
  recordSystemError: (...a: unknown[]) => recordSystemError(...a),
  recordSystemEvent: jest.fn().mockResolvedValue(undefined),
}));

// Stubs for the rest of utils.ts's import graph so the module loads (mirrors
// dispute-refund-correctness.test.ts — these paths have side-effectful graphs).
jest.mock("../../lib/payments/core/razorpay", () => ({ razorpayClient: {} }));
jest.mock("../../lib/payments/core/stripe", () => ({ stripeClient: null }));
jest.mock("../../lib/novu", () => ({
  notifyRefundProcessed: jest.fn(),
  notifyDisputeCreated: jest.fn(),
  notifyDisputeResolved: jest.fn(),
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgInvoicePaid: jest.fn(),
  notifyOrgWalletTopupConfirmed: jest.fn(),
}));
jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: jest.fn(),
}));
jest.mock("../../lib/api/organizations/wallet", () => ({
  confirmTopUp: jest.fn(),
  walletCredit: jest.fn(),
  walletDebit: jest.fn(),
  WalletInsufficientFundsError: class extends Error {},
}));
jest.mock("../../lib/payments/payouts", () => ({
  handlePayoutWebhook: jest.fn(),
  markOrgPayoutCompleted: jest.fn(),
  markOrgPayoutFailed: jest.fn(),
  markOrgPayoutReversed: jest.fn(),
  markConsultantPayoutReversed: jest.fn(),
}));
jest.mock("../../lib/payments/webhooks/handlers", () => ({
  handlePaymentSuccess: jest.fn(),
  handlePaymentFailure: jest.fn(),
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  applyRefundCascade: jest.fn(),
  mintInvoiceRefundCreditNote: jest.fn(),
  mintRefundCreditNote: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { applyB2cChargebackReversal } from "../../app/api/webhooks/utils";

type Entry = {
  direction: "DEBIT" | "CREDIT";
  amountPaise: bigint;
  account: {
    kind: string;
    organizationId: string | null;
    consultantProfileId: string | null;
  };
};

function dr(kind: string, amt: number, scope: Record<string, string> = {}): Entry {
  return {
    direction: "DEBIT",
    amountPaise: BigInt(amt),
    account: {
      kind,
      organizationId: scope.organizationId ?? null,
      consultantProfileId: scope.consultantProfileId ?? null,
    },
  };
}
function cr(kind: string, amt: number, scope: Record<string, string> = {}): Entry {
  return { ...dr(kind, amt, scope), direction: "CREDIT" };
}

function makeTx(opts: {
  bookingEntries: Entry[] | null;
  priorRefundSum?: bigint | null;
  chargebackExists?: boolean;
}) {
  return {
    ledgerTransaction: {
      findUnique: jest.fn(async ({ where }: { where: { idempotencyKey: string } }) => {
        if (where.idempotencyKey.startsWith("chargeback:")) {
          return opts.chargebackExists ? { id: "cb_existing" } : null;
        }
        if (where.idempotencyKey.startsWith("booking:")) {
          return opts.bookingEntries
            ? { id: "booking_txn", entries: opts.bookingEntries }
            : null;
        }
        return null;
      }),
    },
    refund: {
      aggregate: jest.fn(async () => ({
        _sum: { amountPaise: opts.priorRefundSum ?? null },
      })),
    },
  };
}

type PostArg = {
  idempotencyKey: string;
  kind: string;
  paymentId: string;
  postings: Array<{
    account: { kind: string; consultantProfileId?: string | null };
    direction: "DEBIT" | "CREDIT";
    amountPaise: number;
  }>;
};

const sumBy = (arg: PostArg, kind: string, dir: "DEBIT" | "CREDIT") =>
  arg.postings
    .filter((p) => p.account.kind === kind && p.direction === dir)
    .reduce((s, p) => s + p.amountPaise, 0);
const balanced = (arg: PostArg) => {
  const d = arg.postings.filter((p) => p.direction === "DEBIT").reduce((s, p) => s + p.amountPaise, 0);
  const c = arg.postings.filter((p) => p.direction === "CREDIT").reduce((s, p) => s + p.amountPaise, 0);
  return { d, c };
};

describe("#677 — applyB2cChargebackReversal (B2C lost-chargeback ledger leg)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("posts the exact inverse of the booking journal for a full chargeback", async () => {
    const tx = makeTx({
      bookingEntries: [
        dr("CASH", 12000),
        cr("CONSULTANT_PAYABLE", 9000, { consultantProfileId: "c1" }),
        cr("PLATFORM_FEE", 1800),
        cr("GST_PAYABLE", 1200),
      ],
    });

    await applyB2cChargebackReversal(tx as never, {
      paymentId: "pay1",
      disputeId: "disp1",
      amountPaise: 12000,
      paymentAmountPaise: 12000,
    });

    expect(postLedgerTxn).toHaveBeenCalledTimes(1);
    const arg = postLedgerTxn.mock.calls[0][1] as PostArg;
    expect(arg.idempotencyKey).toBe("chargeback:disp1");
    expect(arg.kind).toBe("REFUND");
    expect(arg.paymentId).toBe("pay1");

    // Exact negation of the booking: Cr CASH; Dr each value leg.
    expect(sumBy(arg, "CASH", "CREDIT")).toBe(12000);
    expect(sumBy(arg, "CONSULTANT_PAYABLE", "DEBIT")).toBe(9000);
    expect(sumBy(arg, "PLATFORM_FEE", "DEBIT")).toBe(1800);
    expect(sumBy(arg, "GST_PAYABLE", "DEBIT")).toBe(1200);
    // Consultant scope preserved.
    expect(
      arg.postings.find((p) => p.account.kind === "CONSULTANT_PAYABLE")?.account
        .consultantProfileId,
    ).toBe("c1");

    const { d, c } = balanced(arg);
    expect(d).toBe(c);
    expect(c).toBe(12000);
  });

  it("preserves multi-funding legs (referral credit) on a full chargeback", async () => {
    // Booking funded by card (CASH) + referral credit (PLATFORM_PROMO contra-debit).
    const tx = makeTx({
      bookingEntries: [
        dr("CASH", 8000),
        dr("PLATFORM_PROMO", 2000),
        cr("CONSULTANT_PAYABLE", 8000, { consultantProfileId: "c1" }),
        cr("PLATFORM_FEE", 1000),
        cr("GST_PAYABLE", 1000),
      ],
    });

    await applyB2cChargebackReversal(tx as never, {
      paymentId: "pay_mix",
      disputeId: "disp_mix",
      amountPaise: 10000,
      paymentAmountPaise: 10000,
    });

    const arg = postLedgerTxn.mock.calls[0][1] as PostArg;
    // Only the card portion returns as CASH; the promo portion reverses to PROMO.
    expect(sumBy(arg, "CASH", "CREDIT")).toBe(8000);
    expect(sumBy(arg, "PLATFORM_PROMO", "CREDIT")).toBe(2000);
    const { d, c } = balanced(arg);
    expect(d).toBe(c);
  });

  it("scales proportionally and stays balanced for a partial chargeback", async () => {
    const tx = makeTx({
      bookingEntries: [
        dr("CASH", 10000),
        cr("CONSULTANT_PAYABLE", 7500, { consultantProfileId: "c1" }),
        cr("PLATFORM_FEE", 1500),
        cr("GST_PAYABLE", 1000),
      ],
    });

    // 3333 / 10000 — deliberately produces flooring residual.
    await applyB2cChargebackReversal(tx as never, {
      paymentId: "pay2",
      disputeId: "disp2",
      amountPaise: 3333,
      paymentAmountPaise: 10000,
    });

    const arg = postLedgerTxn.mock.calls[0][1] as PostArg;
    const { d, c } = balanced(arg);
    expect(d).toBe(c); // PLATFORM_FEE residual keeps it balanced despite floors
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThanOrEqual(3333);
  });

  it("nets against prior SUCCEEDED refunds and skips when fully covered", async () => {
    const tx = makeTx({
      bookingEntries: [
        dr("CASH", 5000),
        cr("CONSULTANT_PAYABLE", 4000, { consultantProfileId: "c1" }),
        cr("PLATFORM_FEE", 1000),
      ],
      priorRefundSum: BigInt(5000),
    });

    await applyB2cChargebackReversal(tx as never, {
      paymentId: "pay3",
      disputeId: "disp3",
      amountPaise: 5000,
      paymentAmountPaise: 5000,
    });

    expect(postLedgerTxn).not.toHaveBeenCalled();
  });

  it("is idempotent when the chargeback txn already exists", async () => {
    const tx = makeTx({
      bookingEntries: [dr("CASH", 1000), cr("PLATFORM_FEE", 1000)],
      chargebackExists: true,
    });

    await applyB2cChargebackReversal(tx as never, {
      paymentId: "pay4",
      disputeId: "disp4",
      amountPaise: 1000,
      paymentAmountPaise: 1000,
    });

    expect(postLedgerTxn).not.toHaveBeenCalled();
  });

  it("pages and skips when there is no booking journal to mirror", async () => {
    const tx = makeTx({ bookingEntries: null });

    await applyB2cChargebackReversal(tx as never, {
      paymentId: "pay5",
      disputeId: "disp5",
      amountPaise: 1000,
      paymentAmountPaise: 1000,
    });

    expect(postLedgerTxn).not.toHaveBeenCalled();
    expect(recordSystemError).toHaveBeenCalledTimes(1);
  });
});
