/**
 * @jest-environment node
 */

/**
 * #1470 — the ORG_PAYOUT journal must respect the withholding identity
 * `amountPaise + tdsAmountPaise === netPayoutPaise`.
 *
 * `createOrgPayoutBatch` stores `netPayoutPaise` as the host org's share BEFORE
 * withholding and `amountPaise` as what the rail actually transfers. The
 * completion posting used to debit `netPayoutPaise + tds` and credit CASH
 * `netPayoutPaise`, which balances — so the leg-sum trigger accepted it — while
 * clearing ORG_PAYABLE and crediting CASH by one TDS amount too much on every
 * single org payout. The reversal mirrored the same wrong shape, so only a
 * payout that stayed COMPLETED carried the overstatement.
 *
 * The figures below are the ones observed on deploy-preview-1422 (payout
 * `7cf818fb…`): 852,516 pre-withholding, 852 withheld, 851,664 transferred.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    organizationPayout: {
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      aggregate: jest.fn(),
    },
    organizationEarnings: { updateMany: jest.fn().mockResolvedValue({}) },
    orgAuditLog: { create: jest.fn().mockResolvedValue({}) },
    tDSRecord: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $transaction: jest.fn(),
  },
}));

jest.mock("../../lib/payments/ledger/post", () => ({
  __esModule: true,
  postLedgerTxn: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../lib/enterprise/system-events", () => ({
  __esModule: true,
  recordSystemError: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../lib/observability/report", () => ({
  __esModule: true,
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));

jest.mock("../../lib/payments/tax/tds-service", () => ({
  __esModule: true,
  ...jest.requireActual("../../lib/payments/tax/tds-service"),
  recordOrgTDSDeduction: jest.fn().mockResolvedValue(undefined),
  recordOrgTdsReversal: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../lib/novu/org-workflows", () => ({
  __esModule: true,
  notifyOrgPayoutCompleted: jest.fn().mockResolvedValue(undefined),
  notifyOrgPayoutFailed: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../lib/payments/payouts/razorpay-payouts", () => ({
  __esModule: true,
  getRazorpayPayoutsService: jest.fn(),
}));

import prisma from "@/lib/prisma";
import { postLedgerTxn } from "@/lib/payments/ledger/post";
import { recordSystemError } from "@/lib/enterprise/system-events";
import { reportSentryError } from "@/lib/observability/report";
import { recordOrgTDSDeduction } from "@/lib/payments/tax/tds-service";
import {
  markOrgPayoutCompleted,
  markOrgPayoutReversed,
  OrgPayoutWithholdingMismatchError,
} from "@/lib/payments/payouts/org-payout-service";

const PAYOUT_ID = "op_7cf818fb";
const ORG_ID = "org-host-1";

/** The deploy-preview figures: pre-withholding, withheld, transferred. */
const NET_PAYOUT_PAISE = 852_516;
const TDS_PAISE = 852;
const AMOUNT_PAISE = 851_664;

const mockedPrisma = prisma as unknown as {
  organizationPayout: {
    updateMany: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    aggregate: jest.Mock;
  };
  organizationEarnings: { updateMany: jest.Mock };
  tDSRecord: { deleteMany: jest.Mock };
  $transaction: jest.Mock;
};

function payoutRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYOUT_ID,
    organizationId: ORG_ID,
    netPayoutPaise: NET_PAYOUT_PAISE,
    amountPaise: AMOUNT_PAISE,
    tdsAmountPaise: TDS_PAISE,
    tdsRateAppliedBps: 10, // 0.1% — Section 194-O with a PAN on file
    tdsSectionApplied: "194O",
    currency: "INR",
    organization: { name: "Host Org" },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // The service runs `prisma.$transaction(async (tx) => ...)`; handing the
  // callback the same mocked client puts every inner call on these spies.
  mockedPrisma.$transaction.mockImplementation(async (fn: unknown) =>
    typeof fn === "function"
      ? (fn as (tx: typeof mockedPrisma) => Promise<unknown>)(mockedPrisma)
      : undefined,
  );
  mockedPrisma.organizationPayout.updateMany.mockResolvedValue({ count: 1 });
  mockedPrisma.organizationEarnings.updateMany.mockResolvedValue({ count: 0 });
  mockedPrisma.organizationPayout.aggregate.mockResolvedValue({
    _sum: { netPayoutPaise: 0 },
  });
  mockedPrisma.organizationPayout.findUniqueOrThrow.mockResolvedValue(
    payoutRow(),
  );
});

describe("#1470 — markOrgPayoutCompleted ORG_PAYOUT posting", () => {
  it("debits ORG_PAYABLE pre-withholding and credits CASH post-withholding", async () => {
    const result = await markOrgPayoutCompleted(PAYOUT_ID);

    expect(result).toEqual({ wasNoOp: false, status: "COMPLETED" });
    expect(postLedgerTxn).toHaveBeenCalledTimes(1);
    const [, txnArg] = (postLedgerTxn as jest.Mock).mock.calls[0];
    expect(txnArg.idempotencyKey).toBe(`orgpayout:${PAYOUT_ID}`);
    expect(txnArg.kind).toBe("ORG_PAYOUT");
    expect(txnArg.postings).toEqual([
      {
        account: { kind: "ORG_PAYABLE", organizationId: ORG_ID },
        direction: "DEBIT",
        amountPaise: NET_PAYOUT_PAISE, // 852,516 — NOT 853,368
      },
      {
        account: { kind: "CASH" },
        direction: "CREDIT",
        amountPaise: AMOUNT_PAISE, // 851,664 — NOT 852,516
      },
      {
        account: { kind: "TDS_PAYABLE" },
        direction: "CREDIT",
        amountPaise: TDS_PAISE, // 852
      },
    ]);
  });

  it("files the 194-O return on the pre-withholding gross, not gross + TDS", async () => {
    // One prior COMPLETED payout of 1,000,000 pre-withholding in the same FY.
    mockedPrisma.organizationPayout.aggregate.mockResolvedValue({
      _sum: { netPayoutPaise: 1_000_000 },
    });

    await markOrgPayoutCompleted(PAYOUT_ID);

    expect(recordOrgTDSDeduction).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        tdsDeducted: TDS_PAISE,
        // 1,000,000 + 852,516. The old code added both payouts' TDS on top.
        cumulativeAmountCredited: 1_852_516,
      }),
    );
  });

  it("refuses to post a guessed figure when the withholding identity is broken", async () => {
    // The pre-#1470 row shape: amountPaise never reduced by the withholding.
    mockedPrisma.organizationPayout.findUniqueOrThrow.mockResolvedValue(
      payoutRow({ amountPaise: NET_PAYOUT_PAISE }),
    );

    await expect(markOrgPayoutCompleted(PAYOUT_ID)).rejects.toThrow(
      OrgPayoutWithholdingMismatchError,
    );

    // Nothing was journalled, so the CAS transaction rolls back and the
    // at-least-once webhook (or the stuck-payout sweep) re-drives it.
    expect(postLedgerTxn).not.toHaveBeenCalled();
    expect(recordOrgTDSDeduction).not.toHaveBeenCalled();
    expect(recordSystemError).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        category: "PAYOUT",
        summary: expect.stringContaining("ORG_PAYOUT_WITHHOLDING_MISMATCH"),
        context: expect.objectContaining({
          orgPayoutId: PAYOUT_ID,
          netPayoutPaise: NET_PAYOUT_PAISE,
          amountPaise: NET_PAYOUT_PAISE,
          tdsAmountPaise: TDS_PAISE,
        }),
      }),
    );
    expect(reportSentryError).toHaveBeenCalledWith(
      expect.any(OrgPayoutWithholdingMismatchError),
      expect.objectContaining({
        subsystem: "payments",
        op: "markOrgPayoutCompleted",
      }),
    );
  });

  it("refuses a negative payout that satisfies the identity arithmetically", async () => {
    // #1473 review — -852,516 + 0 === -852,516 passes the equation, and the
    // posting site skips the journal for anything not > 0, so without the
    // non-negativity guard this row would settle COMPLETED with no ledger entry.
    mockedPrisma.organizationPayout.findUniqueOrThrow.mockResolvedValue(
      payoutRow({
        netPayoutPaise: -NET_PAYOUT_PAISE,
        amountPaise: -NET_PAYOUT_PAISE,
        tdsAmountPaise: 0,
      }),
    );

    await expect(markOrgPayoutCompleted(PAYOUT_ID)).rejects.toThrow(
      OrgPayoutWithholdingMismatchError,
    );

    expect(postLedgerTxn).not.toHaveBeenCalled();
    expect(recordOrgTDSDeduction).not.toHaveBeenCalled();
  });
});

describe("#1470 — markOrgPayoutReversed mirrors the corrected posting", () => {
  it("debits CASH post-withholding and credits ORG_PAYABLE pre-withholding", async () => {
    const result = await markOrgPayoutReversed(
      PAYOUT_ID,
      "bank returned funds",
    );

    expect(result).toEqual({ wasNoOp: false, status: "REVERSED" });
    expect(postLedgerTxn).toHaveBeenCalledTimes(1);
    const [, txnArg] = (postLedgerTxn as jest.Mock).mock.calls[0];
    expect(txnArg.idempotencyKey).toBe(`orgpayout-reversal:${PAYOUT_ID}`);
    expect(txnArg.postings).toEqual([
      {
        account: { kind: "CASH" },
        direction: "DEBIT",
        amountPaise: AMOUNT_PAISE, // 851,664
      },
      {
        account: { kind: "ORG_PAYABLE", organizationId: ORG_ID },
        direction: "CREDIT",
        amountPaise: NET_PAYOUT_PAISE, // 852,516
      },
      {
        account: { kind: "TDS_PAYABLE" },
        direction: "DEBIT",
        amountPaise: TDS_PAISE, // 852
      },
    ]);
  });

  it("refuses the reversal when the withholding identity is broken", async () => {
    mockedPrisma.organizationPayout.findUniqueOrThrow.mockResolvedValue(
      payoutRow({ amountPaise: NET_PAYOUT_PAISE }),
    );

    await expect(
      markOrgPayoutReversed(PAYOUT_ID, "bank returned funds"),
    ).rejects.toThrow(OrgPayoutWithholdingMismatchError);

    expect(postLedgerTxn).not.toHaveBeenCalled();
    expect(recordSystemError).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining("ORG_PAYOUT_WITHHOLDING_MISMATCH"),
      }),
    );
    expect(reportSentryError).toHaveBeenCalledWith(
      expect.any(OrgPayoutWithholdingMismatchError),
      expect.objectContaining({ op: "markOrgPayoutReversed" }),
    );
  });
});
