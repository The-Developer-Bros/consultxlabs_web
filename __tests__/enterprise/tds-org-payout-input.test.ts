/**
 * @jest-environment node
 */

/**
 * Validates the TDS inputs that `org-payout-service.ts` constructs for
 * `computeTdsForPayout` produce the expected withholding shape. The
 * full `computeTdsForPayout` matrix is covered in tds-derivation.test.ts;
 * this file pins down the org-payout-specific shape:
 *   - host orgs are RESIDENT in v1
 *   - PAN is encrypted at rest → signalled via `panOnFile` (#785), NOT by
 *     passing the ciphertext as `panNumber`
 *   - Section 194-O default (0.1%) applies when a PAN is on file
 *   - missing PAN → Section 194-O 5% no-PAN carve-out
 *
 * Together these guard against the regression where the org pipeline
 * silently ships `tdsAmountPaise=0` because the old code never called
 * the TDS helper at all — and the #785 regression where the encrypted-PAN
 * ciphertext was passed as `panNumber` and wrongly hit the 5% fallback.
 *
 * The last block leaves the pure-arithmetic surface and drives
 * `markOrgPayoutCompleted` itself, because the rate a payout carries is what
 * decides whether the completion can file a `TDSRecord` at all (#1354).
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

import { computeTdsForPayout } from "@/lib/compliance/tds";
import prisma from "@/lib/prisma";
import { recordSystemError } from "@/lib/enterprise/system-events";
import { reportSentryMessage } from "@/lib/observability/report";
import { recordOrgTDSDeduction } from "@/lib/payments/tax/tds-service";
import { markOrgPayoutCompleted } from "@/lib/payments/payouts/org-payout-service";

describe("org payout TDS construction", () => {
  it("Resident host org with valid PAN → 194-O 0.1%", () => {
    const r = computeTdsForPayout({
      grossAmountPaise: 1_000_000,
      consultant: {
        panNumber: "AAACA1234B",
        residencyStatus: "RESIDENT",
        tdsSection: null,
        tdsRateBps: null,
        tdsLowerRateCert: null,
        providerCountry: null,
      },
    });
    expect(r.tdsSection).toBe("194O");
    expect(r.tdsRate).toBeCloseTo(0.001, 6);
    expect(r.tdsAmountPaise).toBe(1_000); // 0.1% of 10L paise
    expect(r.fallbackApplied).toBe(false);
  });

  it("Resident host org with missing PAN → 194-O 5% no-PAN carve-out", () => {
    const r = computeTdsForPayout({
      grossAmountPaise: 1_000_000,
      consultant: {
        panNumber: null,
        residencyStatus: "RESIDENT",
        tdsSection: null,
        tdsRateBps: null,
        tdsLowerRateCert: null,
        providerCountry: null,
      },
    });
    expect(r.tdsRate).toBeCloseTo(0.05, 6);
    expect(r.tdsAmountPaise).toBe(50_000);
    expect(r.fallbackApplied).toBe(true);
  });

  it("Resident host org with malformed PAN → 194-O 5% no-PAN carve-out", () => {
    const r = computeTdsForPayout({
      grossAmountPaise: 1_000_000,
      consultant: {
        panNumber: "invalid",
        residencyStatus: "RESIDENT",
        tdsSection: null,
        tdsRateBps: null,
        tdsLowerRateCert: null,
        providerCountry: null,
      },
    });
    expect(r.fallbackApplied).toBe(true);
    expect(r.tdsAmountPaise).toBe(50_000);
  });

  it("#785 — encrypted PAN on file (the REAL org-payout input) → 0.1%, not 5%", () => {
    // org-payout-service passes panNumber:null + panOnFile:!!panEncrypted.
    const r = computeTdsForPayout({
      grossAmountPaise: 4_000_000,
      consultant: {
        panNumber: null,
        panOnFile: true,
        residencyStatus: "RESIDENT",
        tdsSection: null,
        tdsRateBps: null,
        tdsLowerRateCert: null,
        providerCountry: null,
      },
    });
    expect(r.tdsSection).toBe("194O");
    expect(r.tdsRate).toBeCloseTo(0.001, 6);
    expect(r.tdsAmountPaise).toBe(4_000); // 0.1% — NOT 200_000 (the 5% bug)
    expect(r.fallbackApplied).toBe(false);
  });

  it("#785 — passing the ciphertext as panNumber WOULD wrongly fall back (documents the bug)", () => {
    const r = computeTdsForPayout({
      grossAmountPaise: 4_000_000,
      consultant: {
        panNumber: "ENCRYPTED", // the old, wrong shape — ciphertext as PAN
        residencyStatus: "RESIDENT",
        tdsSection: null,
        tdsRateBps: null,
        tdsLowerRateCert: null,
        providerCountry: null,
      },
    });
    // This is why callers MUST use panOnFile: the ciphertext fails isValidPan.
    expect(r.fallbackApplied).toBe(true);
    expect(r.tdsAmountPaise).toBe(200_000); // 5% — the over-withholding
  });

  it("rounds down (Math.floor) — never over-withholds", () => {
    const r = computeTdsForPayout({
      grossAmountPaise: 9_999, // 0.1% = 9.999 paise → 9
      consultant: {
        panNumber: "AAACA1234B",
        residencyStatus: "RESIDENT",
        tdsSection: null,
        tdsRateBps: null,
        tdsLowerRateCert: null,
        providerCountry: null,
      },
    });
    expect(r.tdsAmountPaise).toBe(9);
  });
});

describe("markOrgPayoutCompleted — withheld TDS with no stored rate (#1354)", () => {
  const PAYOUT_ID = "op_legacy_no_rate";
  const ORG_ID = "org-legacy-1";

  const mockedPrisma = prisma as unknown as {
    organizationPayout: {
      updateMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      aggregate: jest.Mock;
    };
    tDSRecord: { deleteMany: jest.Mock };
    $transaction: jest.Mock;
  };

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
    mockedPrisma.organizationPayout.aggregate.mockResolvedValue({
      _sum: { netPayoutPaise: 0 },
    });
  });

  it("writes no TDSRecord and reports the gap through the system-error recorder", async () => {
    // A payout batched before `tdsRateAppliedBps` existed: the withholding is
    // real and already on TDS_PAYABLE, but the rate the return must cite is
    // not recoverable from it (computeTdsForPayout floors, so gross/tds does
    // not invert).
    mockedPrisma.organizationPayout.findUniqueOrThrow.mockResolvedValue({
      id: PAYOUT_ID,
      organizationId: ORG_ID,
      netPayoutPaise: 999_000,
      // #1470 — amountPaise is the post-withholding transfer, so it must
      // satisfy amountPaise + tds === netPayoutPaise or the posting is refused.
      amountPaise: 998_000,
      tdsAmountPaise: 1_000,
      tdsRateAppliedBps: null,
      tdsSectionApplied: null,
      currency: "INR",
      organization: { name: "Legacy Org" },
    });

    const result = await markOrgPayoutCompleted(PAYOUT_ID);

    // The completion still stands — cash moved, so it is never rolled back.
    expect(result).toEqual({ wasNoOp: false, status: "COMPLETED" });
    expect(recordOrgTDSDeduction).not.toHaveBeenCalled();
    expect(mockedPrisma.tDSRecord.deleteMany).not.toHaveBeenCalled();

    expect(recordSystemError).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        category: "PAYOUT",
        summary: expect.stringContaining("ORG_PAYOUT_TDS_RATE_MISSING"),
        context: expect.objectContaining({
          orgPayoutId: PAYOUT_ID,
          organizationId: ORG_ID,
          tdsAmountPaise: 1_000,
        }),
      }),
    );
    expect(reportSentryMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ level: "warning" }),
    );
  });
});
