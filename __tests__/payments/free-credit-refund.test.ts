/**
 * @jest-environment node
 */

/**
 * #1161 — the free_ (fully-credit-funded) cancellation rail.
 *
 * A booking paid entirely with referral credits carries a synthetic `free_`
 * intent and `Payment.amount === 0`: no gateway was ever involved, yet before
 * this rail existed the cancel path either died on UNKNOWN_GATEWAY or was
 * filtered out on `amount > 0`, so the buyer's credits were gone forever.
 *
 * Pinned here:
 *  - the rail never touches gateway routing (`refundPayment`)
 *  - it restores every consumed credit via reverseCreditsForPayment
 *  - it releases BookingUtilization (#1003 convention; no-op for personal
 *    bookings, which is all a free_ payment can be)
 *  - it mirrors the booking-time PLATFORM_PROMO journal: payables debited,
 *    earnings netted to REFUNDED, txn balanced to the paise
 *  - a second cancellation is a full no-op (the zero-amount Refund row is the
 *    claim) — credits are not double-restored
 */

const mockRefundPayment = jest.fn();
const mockApplyReversal = jest.fn();
const mockReverseCredits = jest.fn();
const mockReverseUtilization = jest.fn();
const mockPostLedgerTxn = jest.fn();
const mockAssertEarningTransition = jest.fn();
const mockRecordTdsReversal = jest.fn();
const mockPaymentFindUnique = jest.fn();

const tx = {
  appointmentParticipant: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  refund: {
    findFirst: jest.fn(),
    create: jest.fn(),
  },
  payment: {
    findUniqueOrThrow: jest.fn(),
  },
  consultantEarnings: {
    update: jest.fn(),
  },
  organizationEarnings: {
    update: jest.fn(),
  },
  organizationPayout: {
    update: jest.fn(),
  },
  orgAuditLog: {
    create: jest.fn(),
  },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findUnique: (...a: unknown[]) => mockPaymentFindUnique(...a),
    },
    $transaction: (fn: (txClient: unknown) => unknown) => fn(tx),
  },
}));

jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => unknown) => fn(),
}));

jest.mock("../../lib/payments/operations/refund", () => ({
  refundPayment: (...a: unknown[]) => mockRefundPayment(...a),
  RefundValidationError: class RefundValidationError extends Error {
    constructor(
      message: string,
      public code: string,
    ) {
      super(message);
      this.name = "RefundValidationError";
    }
  },
}));

jest.mock("../../lib/payments/operations/reversal-engine", () => ({
  applyReversal: (...a: unknown[]) => mockApplyReversal(...a),
}));

jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: (...a: unknown[]) => mockReverseCredits(...a),
}));

jest.mock("../../lib/api/organizations/program-helpers", () => ({
  reverseBookingUtilization: (...a: unknown[]) => mockReverseUtilization(...a),
}));

jest.mock("../../lib/payments/payouts/earning-status", () => ({
  assertEarningStatusTransitionLegal: (...a: unknown[]) =>
    mockAssertEarningTransition(...a),
}));

jest.mock("../../lib/payments/tax/tds-service", () => ({
  recordTdsReversal: (...a: unknown[]) => mockRecordTdsReversal(...a),
}));

// Captured, not executed: the balance assertion below re-derives what the
// ledger would enforce, so a drift ships as a red test instead of a red
// production reconcile report.
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: (...a: unknown[]) => mockPostLedgerTxn(...a),
}));

import { refundBookingPayment } from "../../lib/payments/operations/booking-refund";

const PAYMENT_ID = "pay-free-1";

/** ₹1,000 + ₹180 GST booking, fully covered by referral credits. */
function freeCreditSettlement() {
  return {
    originalAmount: 100_000,
    taxAmount: 18_000,
    legs: [{ source: "REFERRAL_CREDIT", amountPaise: 118_000 }],
    earnings: [
      {
        id: "ce-1",
        consultantProfileId: "cp-1",
        consultantSharePaise: 80_000,
        refundedShareAmount: 0,
        status: "PENDING",
        payoutId: null,
      },
    ],
    organizationEarnings: [],
  };
}

function sum(
  postings: Array<{ direction: string; amountPaise: number }>,
  d: string,
) {
  return postings
    .filter((p) => p.direction === d)
    .reduce((s, p) => s + p.amountPaise, 0);
}

beforeEach(() => {
  jest.clearAllMocks();
  tx.refund.findFirst.mockResolvedValue(null);
  tx.refund.create.mockResolvedValue({ id: "refund-row-1" });
  tx.consultantEarnings.update.mockResolvedValue({});
  tx.organizationEarnings.update.mockResolvedValue({});
  tx.payment.findUniqueOrThrow.mockResolvedValue(freeCreditSettlement());
  mockReverseCredits.mockResolvedValue(118_000);
  mockReverseUtilization.mockResolvedValue(undefined);
});

describe("refundBookingPayment — free_ credit rail (#1161)", () => {
  it("restores credits, reverses utilization, nets earnings and posts the mirrored journal — never touching the gateway", async () => {
    mockPaymentFindUnique
      .mockResolvedValueOnce({ paymentIntent: "free_1730000000_abc" })
      .mockResolvedValueOnce({
        id: PAYMENT_ID,
        currency: "INR",
        paymentStatus: "SUCCEEDED",
        paymentGateway: "RAZORPAY",
      });

    const result = await refundBookingPayment({
      paymentId: PAYMENT_ID,
      reason: "cancellation",
      initiatedByUserId: "user-1",
    });

    // The whole point of the rail: no gateway call, ever.
    expect(mockRefundPayment).not.toHaveBeenCalled();
    expect(mockApplyReversal).not.toHaveBeenCalled();

    expect(result).toEqual({
      refundId: "refund-row-1",
      amountRefundedPaise: 0,
      rail: "CREDITS",
    });
    // No amounts passed → full restoration of every usage row.
    expect(mockReverseCredits).toHaveBeenCalledWith(PAYMENT_ID, tx);
    expect(mockReverseUtilization).toHaveBeenCalledWith(tx, {
      paymentId: PAYMENT_ID,
      reason: "cancellation",
    });
    expect(tx.refund.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paymentId: PAYMENT_ID,
          amountPaise: 0,
          status: "SUCCEEDED",
          refundId: expect.stringMatching(/^credits_/),
        }),
      }),
    );

    // The payable's source row nets first, so payout math follows the ledger.
    expect(tx.consultantEarnings.update).toHaveBeenCalledWith({
      where: { id: "ce-1" },
      data: { refundedShareAmount: 80_000, status: "REFUNDED" },
    });
    expect(mockAssertEarningTransition).toHaveBeenCalledWith(
      "ce-1",
      "PENDING",
      "REFUNDED",
    );

    // Mirror of the booking-time journal: PLATFORM_PROMO back to credit;
    // payables, GST and the fee plug debited. Balanced to the paise.
    expect(mockPostLedgerTxn).toHaveBeenCalledTimes(1);
    const posting = mockPostLedgerTxn.mock.calls[0][1];
    expect(posting).toEqual(
      expect.objectContaining({
        kind: "REFUND",
        paymentId: PAYMENT_ID,
        idempotencyKey: "refund:refund-row-1",
      }),
    );
    expect(sum(posting.postings, "DEBIT")).toBe(
      sum(posting.postings, "CREDIT"),
    );
    expect(posting.postings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account: { kind: "PLATFORM_PROMO" },
          direction: "CREDIT",
          amountPaise: 118_000,
        }),
        expect.objectContaining({
          account: { kind: "CONSULTANT_PAYABLE", consultantProfileId: "cp-1" },
          direction: "DEBIT",
          amountPaise: 80_000,
        }),
        expect.objectContaining({
          account: { kind: "GST_PAYABLE" },
          direction: "DEBIT",
          amountPaise: 18_000,
        }),
        // Residual: funding − shares − GST = the platform's fee slice.
        expect.objectContaining({
          account: { kind: "PLATFORM_FEE" },
          direction: "DEBIT",
          amountPaise: 20_000,
        }),
      ]),
    );
  });

  it("is a no-op on a second cancellation — the zero-amount Refund row is the idempotency claim", async () => {
    mockPaymentFindUnique
      .mockResolvedValueOnce({ paymentIntent: "free_1730000000_abc" })
      .mockResolvedValueOnce({
        id: PAYMENT_ID,
        currency: "INR",
        paymentStatus: "SUCCEEDED",
        paymentGateway: "RAZORPAY",
      });
    tx.refund.findFirst.mockResolvedValue({ id: "refund-row-already" });

    await expect(
      refundBookingPayment({ paymentId: PAYMENT_ID, reason: "cancellation" }),
    ).rejects.toMatchObject({ code: "ALREADY_FULLY_REFUNDED" });

    // Nothing restored twice, nothing posted twice.
    expect(mockReverseCredits).not.toHaveBeenCalled();
    expect(mockReverseUtilization).not.toHaveBeenCalled();
    expect(mockPostLedgerTxn).not.toHaveBeenCalled();
    expect(tx.refund.create).not.toHaveBeenCalled();
  });

  it("skips the ledger settlement when no earnings rows exist — there is no journal to invert", async () => {
    mockPaymentFindUnique
      .mockResolvedValueOnce({ paymentIntent: "free_1730000000_abc" })
      .mockResolvedValueOnce({
        id: PAYMENT_ID,
        currency: "INR",
        paymentStatus: "SUCCEEDED",
        paymentGateway: "RAZORPAY",
      });
    tx.payment.findUniqueOrThrow.mockResolvedValue({
      ...freeCreditSettlement(),
      earnings: [],
      organizationEarnings: [],
    });

    await refundBookingPayment({
      paymentId: PAYMENT_ID,
      reason: "cancellation",
    });

    // Credits and utilization still restore — only the counter-posting waits
    // for a mirrored original.
    expect(mockReverseCredits).toHaveBeenCalled();
    expect(mockReverseUtilization).toHaveBeenCalled();
    expect(mockPostLedgerTxn).not.toHaveBeenCalled();
  });

  it("lets PLATFORM_FEE absorb a negative residual instead of dropping the posting", async () => {
    mockPaymentFindUnique
      .mockResolvedValueOnce({ paymentIntent: "free_1730000000_abc" })
      .mockResolvedValueOnce({
        id: PAYMENT_ID,
        currency: "INR",
        paymentStatus: "SUCCEEDED",
        paymentGateway: "RAZORPAY",
      });
    // A discount code shrank the credit funding below the shares + GST.
    tx.payment.findUniqueOrThrow.mockResolvedValue({
      ...freeCreditSettlement(),
      legs: [{ source: "REFERRAL_CREDIT", amountPaise: 106_200 }],
      earnings: [
        {
          id: "ce-1",
          consultantProfileId: "cp-1",
          consultantSharePaise: 90_000,
          refundedShareAmount: 0,
          status: "PENDING",
          payoutId: null,
        },
      ],
    });

    await refundBookingPayment({
      paymentId: PAYMENT_ID,
      reason: "cancellation",
    });

    const posting = mockPostLedgerTxn.mock.calls[0][1];
    expect(sum(posting.postings, "DEBIT")).toBe(
      sum(posting.postings, "CREDIT"),
    );
    // 106,200 − 90,000 − 18,000 = −1,800 → credited back through the fee.
    expect(posting.postings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account: { kind: "PLATFORM_FEE" },
          direction: "CREDIT",
          amountPaise: 1_800,
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// #1218-triage — the org-clawback and TDS branches of
// reverseFreeCreditSettlement were never exercised (all fixtures had empty
// organizationEarnings and payoutId: null).
// ---------------------------------------------------------------------------
describe("free_ credit rail — org clawback + TDS reversal branches", () => {
  beforeEach(() => {
    mockPaymentFindUnique
      .mockResolvedValueOnce({ paymentIntent: "free_1730000000_abc" })
      .mockResolvedValueOnce({
        id: PAYMENT_ID,
        currency: "INR",
        paymentStatus: "SUCCEEDED",
        paymentGateway: "RAZORPAY",
      });
  });

  it("nets PAID-out consultant earnings and reverses their TDS", async () => {
    tx.payment.findUniqueOrThrow.mockResolvedValue({
      ...freeCreditSettlement(),
      earnings: [
        {
          id: "ce-paid",
          consultantProfileId: "cp-1",
          consultantSharePaise: 80_000,
          refundedShareAmount: 0,
          status: "PAID",
          payoutId: "payout-9",
        },
      ],
    });

    await refundBookingPayment({
      paymentId: PAYMENT_ID,
      reason: "cancellation",
    });

    // The paid share nets to REFUNDED…
    const earningUpdate = tx.consultantEarnings.update.mock.calls.find(
      ([arg]: [{ where: { id: string } }]) => arg.where.id === "ce-paid",
    );
    // Cumulative-set semantics on this rail (not {increment}).
    expect(earningUpdate[0].data).toMatchObject({
      status: "REFUNDED",
      refundedShareAmount: 80_000,
    });
    // …and the withholding against its payout is reversed.
    expect(mockRecordTdsReversal).toHaveBeenCalledWith(
      expect.anything(), // tx client
      expect.objectContaining({
        payoutId: "payout-9",
        earningsId: "ce-paid",
      }),
    );
    // Journal still balances with the paid-share debit included.
    const postings = mockPostLedgerTxn.mock.calls[0][1].postings;
    expect(sum(postings, "DEBIT")).toBe(sum(postings, "CREDIT"));
  });

  it("claws back a COMPLETED org payout and writes the audit row", async () => {
    tx.payment.findUniqueOrThrow.mockResolvedValue({
      ...freeCreditSettlement(),
      organizationEarnings: [
        {
          id: "oe-1",
          organizationId: "org-1",
          orgSharePaise: 20_000,
          refundedAmountPaise: 0,
          status: "PAID",
          orgPayoutId: "opayout-7",
          orgPayout: { status: "COMPLETED", clawbackInitiatedAt: null },
        },
      ],
      // No consultant side — org-collaborator-only settlement.
      earnings: [],
    });
    const orgEarningUpdates: Array<{ data: Record<string, unknown> }> = [];
    tx.organizationEarnings.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => {
        orgEarningUpdates.push({ data });
        return {};
      },
    );

    await refundBookingPayment({
      paymentId: PAYMENT_ID,
      reason: "cancellation",
    });

    // Org share flips to REFUNDED with the full proration.
    expect(orgEarningUpdates[0]?.data).toMatchObject({
      status: "REFUNDED",
      refundedAmountPaise: 20_000, // cumulative-set
    });
    // Clawback recorded on the COMPLETED payout — exactly once stamped.
    const clawback = tx.organizationPayout.update.mock.calls.find(
      ([arg]: [{ data?: { clawbackAmountPaise?: unknown } }]) =>
        !!arg.data?.clawbackAmountPaise,
    );
    expect(clawback?.[0].data.clawbackAmountPaise).toEqual({
      increment: 20_000,
    });
    expect(tx.orgAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ category: "PAYOUT" }),
      }),
    );
    // And the journal balances with the ORG_PAYABLE debit present.
    const postings =
      mockPostLedgerTxn.mock.calls[mockPostLedgerTxn.mock.calls.length - 1][1]
        .postings;
    expect(
      postings.some(
        (p: { account: { kind: string }; direction: string }) =>
          p.account.kind === "ORG_PAYABLE" && p.direction === "DEBIT",
      ),
    ).toBe(true);
    expect(sum(postings, "DEBIT")).toBe(sum(postings, "CREDIT"));
  });
});
