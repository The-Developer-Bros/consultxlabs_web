/**
 * @jest-environment node
 */

/**
 * PR-3 (live payout submission, RazorpayX) — `processOrgPayout` wires
 * the actual gateway call after flipping the row PENDING → PROCESSING.
 *
 * What we cover:
 *   - ENABLE_LIVE_PAYOUTS=false → does NOT advance (stays PENDING), no gateway
 *     call. #785: claiming PENDING→PROCESSING with no live submission would
 *     zombie the row in PROCESSING (no webhook to advance/rollback it).
 *   - ENABLE_LIVE_PAYOUTS=true + 200 OK → gateway response persisted on
 *     the row (gatewayPayoutId, gatewayResponseRaw); status stays
 *     PROCESSING (UTR + COMPLETED come from the webhook later).
 *   - ENABLE_LIVE_PAYOUTS=true + 4xx → row rolled to FAILED, failedAt
 *     stamped, failureReason populated, earnings released back to READY
 *     (status=READY + orgPayoutId=null).
 *   - Idempotency at the state-machine layer: a second processOrgPayout
 *     call against the now-PROCESSING row is a no-op AND does not
 *     re-submit to the gateway.
 *
 * What we don't cover here (lives in the integration smoke):
 *   - Real RazorpayX HTTP semantics; we mock the SDK wrapper.
 *   - Real Postgres serializable isolation; we mock $transaction.
 *   - The webhook reconciler (PR-3 also adds
 *     payout-webhook-reconciler.test.ts for that surface).
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    organizationPayout: {
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
    },
    organizationPayoutAccount: {
      findUnique: jest.fn(),
    },
    organizationEarnings: {
      updateMany: jest.fn(),
      // #1020 — the disbursement dispute guard probes for live disputes.
      findFirst: jest.fn().mockResolvedValue(null),
    },
    orgAuditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn(),
  },
}));

jest.mock("../../lib/payments/payouts/razorpay-payouts", () => ({
  __esModule: true,
  getRazorpayPayoutsService: jest.fn(),
}));

jest.mock("../../lib/novu/org-workflows", () => ({
  __esModule: true,
  notifyOrgPayoutCompleted: jest.fn().mockResolvedValue(undefined),
  notifyOrgPayoutFailed: jest.fn().mockResolvedValue(undefined),
}));

import prisma from "@/lib/prisma";
import { getRazorpayPayoutsService } from "@/lib/payments/payouts/razorpay-payouts";
import { processOrgPayout } from "@/lib/payments/payouts/org-payout-service";

const mockedPrisma = prisma as unknown as {
  organizationPayout: {
    updateMany: jest.Mock;
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    update: jest.Mock;
  };
  organizationPayoutAccount: { findUnique: jest.Mock };
  organizationEarnings: { updateMany: jest.Mock };
  orgAuditLog: { create: jest.Mock };
  $transaction: jest.Mock;
};
const mockedGetService = getRazorpayPayoutsService as jest.Mock;

const PAYOUT_ID = "po_test_123";
const ORG_ID = "org-1";
const FUND_ACCT = "fa_test_xyz";
const RAZORPAY_PAYOUT_ID = "pout_NXXXX";

function wireTxAsPassthrough() {
  // The service runs `prisma.$transaction(async (tx) => ...)` — we
  // swap `tx` for the same mocked client so all calls land on our
  // jest.fn() spies. Inner-tx returns whatever the callback returns.
  mockedPrisma.$transaction.mockImplementation(async (fn: unknown) => {
    if (typeof fn === "function") {
      return (fn as (tx: typeof mockedPrisma) => Promise<unknown>)(
        mockedPrisma,
      );
    }
    return undefined;
  });
}

function setupHappyClaim() {
  // Row was PENDING — claim succeeds.
  mockedPrisma.organizationPayout.updateMany.mockResolvedValue({ count: 1 });
  mockedPrisma.organizationPayout.findUniqueOrThrow.mockResolvedValue({
    id: PAYOUT_ID,
    organizationId: ORG_ID,
    amountPaise: 250000, // ₹2,500
    currency: "INR",
    paymentGateway: "RAZORPAY",
    payoutReference: null,
  });
}

function setupVerifiedAccount() {
  mockedPrisma.organizationPayoutAccount.findUnique.mockResolvedValue({
    status: "VERIFIED",
    razorpayContactId: "cont_xxx",
    razorpayFundAccountId: FUND_ACCT,
  });
}

function setupGatewayService(opts: {
  createPayout: jest.Mock;
}) {
  mockedGetService.mockReturnValue({
    generateIdempotencyKey: (id: string) => `payout_${id}`,
    determinePayoutMode: () => "IMPS" as const,
    createPayout: opts.createPayout,
  });
}

describe("processOrgPayout — live submission gating", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ENABLE_LIVE_PAYOUTS;
    wireTxAsPassthrough();
  });

  it("ENABLE_LIVE_PAYOUTS=false → does NOT advance (stays PENDING), no claim, no gateway call (#785)", async () => {
    // #785 — flag off must NOT claim PENDING→PROCESSING: with no gateway
    // submission and no webhook to advance/rollback, a PROCESSING row would
    // zombie forever. It stays PENDING for a later live run.
    mockedPrisma.organizationPayout.findUnique.mockResolvedValue({
      status: "PENDING",
    });
    const createPayout = jest.fn();
    setupGatewayService({ createPayout });

    const result = await processOrgPayout(PAYOUT_ID);

    expect(result).toEqual({
      status: "PENDING",
      submittedToGateway: false,
      claimed: false,
    });
    // The row was NOT advanced — no PENDING→PROCESSING claim happened.
    expect(mockedPrisma.organizationPayout.updateMany).not.toHaveBeenCalled();
    expect(createPayout).not.toHaveBeenCalled();
    expect(mockedGetService).not.toHaveBeenCalled();
    expect(mockedPrisma.organizationPayout.update).not.toHaveBeenCalled();
  });

  it("ENABLE_LIVE_PAYOUTS=true + 200 OK → persists gatewayPayoutId + gatewayResponseRaw, status stays PROCESSING", async () => {
    process.env.ENABLE_LIVE_PAYOUTS = "true";
    setupHappyClaim();
    setupVerifiedAccount();
    const createPayout = jest.fn().mockResolvedValue({
      id: RAZORPAY_PAYOUT_ID,
      status: "queued",
      amount: 250000,
      currency: "INR",
      mode: "IMPS",
      utr: undefined,
    });
    setupGatewayService({ createPayout });

    const result = await processOrgPayout(PAYOUT_ID);

    expect(result).toEqual({
      status: "PROCESSING",
      submittedToGateway: true,
      claimed: true,
    });
    expect(createPayout).toHaveBeenCalledTimes(1);
    expect(createPayout).toHaveBeenCalledWith(
      expect.objectContaining({
        fundAccountId: FUND_ACCT,
        amount: 250000,
        currency: "INR",
        idempotencyKey: `payout_${PAYOUT_ID}`,
        purpose: "payout",
      }),
    );
    // The gateway response must land on the row.
    expect(mockedPrisma.organizationPayout.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PAYOUT_ID },
        data: expect.objectContaining({
          gatewayPayoutId: RAZORPAY_PAYOUT_ID,
          gatewayResponseRaw: expect.objectContaining({
            id: RAZORPAY_PAYOUT_ID,
          }),
        }),
      }),
    );
    // Status must NOT be flipped to COMPLETED here — that's the
    // webhook reconciler's job.
    const updateCalls = mockedPrisma.organizationPayout.update.mock.calls;
    for (const [arg] of updateCalls) {
      expect(arg.data.status).toBeUndefined();
    }
  });

  it("ENABLE_LIVE_PAYOUTS=true + 4xx (validation) → status=FAILED, failureReason+failedAt populated, earnings released to READY", async () => {
    process.env.ENABLE_LIVE_PAYOUTS = "true";
    setupHappyClaim();
    setupVerifiedAccount();
    const createPayout = jest
      .fn()
      .mockRejectedValue(
        new Error("RazorpayX API error: Invalid fund_account_id"),
      );
    setupGatewayService({ createPayout });

    // After the 4xx, the helper opens a tx and conditionally rolls
    // PROCESSING → FAILED. Re-arm the spies for that second pass:
    //   - first updateMany was the PENDING → PROCESSING claim
    //   - second updateMany is the PROCESSING → FAILED roll
    //   - third updateMany is the earnings release (PAID → READY)
    // We keep the same spies; assert via call args afterwards.
    mockedPrisma.organizationPayout.updateMany
      .mockResolvedValueOnce({ count: 1 }) // claim PENDING → PROCESSING
      .mockResolvedValueOnce({ count: 1 }); // claim PROCESSING → FAILED
    mockedPrisma.organizationEarnings.updateMany.mockResolvedValue({
      count: 3,
    });
    mockedPrisma.organizationPayout.findUniqueOrThrow
      // first call: inside processOrgPayout claim tx
      .mockResolvedValueOnce({
        id: PAYOUT_ID,
        organizationId: ORG_ID,
        amountPaise: 250000,
        currency: "INR",
        paymentGateway: "RAZORPAY",
        payoutReference: null,
      })
      // second call: inside submitOrgPayoutToGateway
      .mockResolvedValueOnce({
        id: PAYOUT_ID,
        organizationId: ORG_ID,
        amountPaise: 250000,
        currency: "INR",
        paymentGateway: "RAZORPAY",
        payoutReference: null,
      })
      // third call: inside markPayoutFailedFromSubmission
      .mockResolvedValueOnce({ organizationId: ORG_ID });

    const result = await processOrgPayout(PAYOUT_ID);

    // We don't strictly care what `processOrgPayout` returns on the
    // 4xx path because the failure is recorded out-of-band; the
    // contract is "no throw, side effects observable on the row".
    expect(result.submittedToGateway).toBe(true);

    // Find the FAILED roll updateMany call.
    const updateManyCalls =
      mockedPrisma.organizationPayout.updateMany.mock.calls;
    const failedRoll = updateManyCalls.find(
      ([arg]) => arg.data?.status === "FAILED",
    );
    expect(failedRoll).toBeDefined();
    expect(failedRoll![0]).toEqual(
      expect.objectContaining({
        where: { id: PAYOUT_ID, status: "PROCESSING" },
        data: expect.objectContaining({
          status: "FAILED",
          failureReason: expect.stringContaining("Invalid fund_account_id"),
          failedAt: expect.any(Date),
        }),
      }),
    );

    // #993 — a PROCESSING→FAILED submission never reached PAID: batch creation
    // staged the earnings READY→BATCHED, so the failure release is BATCHED→READY
    // (orgPayoutId nulled), not PAID→READY.
    expect(mockedPrisma.organizationEarnings.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgPayoutId: PAYOUT_ID, status: "BATCHED" },
        data: { status: "READY", orgPayoutId: null },
      }),
    );
  });

  it("idempotency — second processOrgPayout against PROCESSING row is a no-op AND does not call gateway", async () => {
    process.env.ENABLE_LIVE_PAYOUTS = "true";

    // Claim returns 0: row is no longer PENDING (already PROCESSING).
    mockedPrisma.organizationPayout.updateMany.mockResolvedValue({ count: 0 });
    mockedPrisma.organizationPayout.findUnique.mockResolvedValue({
      status: "PROCESSING",
    });
    const createPayout = jest.fn();
    setupGatewayService({ createPayout });

    const result = await processOrgPayout(PAYOUT_ID);

    expect(result).toEqual({
      status: "PROCESSING",
      submittedToGateway: false,
      claimed: false,
    });
    expect(createPayout).not.toHaveBeenCalled();
    // The factory should also not be touched on the no-op path —
    // confirms we early-returned BEFORE the submission helper.
    expect(mockedGetService).not.toHaveBeenCalled();
  });
});
