/**
 * @jest-environment node
 */

/**
 * PM-15 (part 2 — the canonical engine records money) — pins what the stuck-
 * payout reconciler now delegates to. The old inline flip set status=COMPLETED
 * + earnings PAID and stopped; the canonical handlePayoutWebhook additionally
 * records the TDS deduction and posts the payout ledger transaction (the
 * revenue/payable counters). This drives the REAL handler on a PROCESSING →
 * COMPLETED transition and asserts both happen — and that it's idempotent
 * against a duplicate (the live webhook racing the reconcile).
 *
 * Imported straight from payout-service (NOT the lib/payments/payouts index,
 * which pulls in the Stream ESM graph Jest can't transform).
 */

const recordTDSDeduction = jest.fn().mockResolvedValue(undefined);
const postLedgerTxn = jest.fn().mockResolvedValue({ created: true });
const notifyPayoutProcessed = jest.fn().mockResolvedValue(undefined);

jest.mock("../../lib/payments/tax/tds-service", () => ({
  __esModule: true,
  recordTDSDeduction: (...a: unknown[]) => recordTDSDeduction(...a),
  getIndianFinancialYear: () => "2026-27",
  getFYDateRange: () => ({ start: new Date(2026, 3, 1), end: new Date(2027, 2, 31) }),
  getCurrentFYCumulativePayments: jest.fn().mockResolvedValue(0),
  TDS_THRESHOLD_PAISE: 5_000_000,
}));
jest.mock("../../lib/payments/ledger/post", () => ({
  __esModule: true,
  postLedgerTxn: (...a: unknown[]) => postLedgerTxn(...a),
}));
jest.mock("../../lib/novu/service", () => ({
  __esModule: true,
  notifyPayoutProcessed: (...a: unknown[]) => notifyPayoutProcessed(...a),
}));
jest.mock("../../lib/url", () => ({ getAppUrl: () => "http://localhost:3000" }));
// payout-service imports these at module top — stub so the module loads under
// the test env. handlePayoutWebhook's COMPLETED path uses none of them.
jest.mock("../../lib/redis", () => ({
  acquireLock: jest.fn().mockResolvedValue("tok"),
  releaseLock: jest.fn().mockResolvedValue(undefined),
}));

type Row = Record<string, unknown>;

const PAYOUT: Row = {
  id: "po_1",
  consultantProfileId: "cprof_1",
  amount: 100000,
  currency: "INR",
  status: "PROCESSING",
  tdsDeducted: 1000,
  tdsRateAppliedBps: 100,
  tdsFinancialYear: "2026-27",
  // #993 — a PROCESSING payout's earnings were staged READY→BATCHED at batch
  // creation; the COMPLETED webhook flips BATCHED→PAID.
  earnings: [{ id: "ce_1", payoutId: "po_1", status: "BATCHED" }],
};

let payoutRow: Row;

// `var` (not let/const): the hoisted jest.mock factory runs before this
// declaration line, and only `var` is initialized (to undefined) at hoist time.
// eslint-disable-next-line no-var
var prismaStub: {
  consultantPayout: { findFirst: jest.Mock; updateMany: jest.Mock; aggregate: jest.Mock };
  consultantEarnings: { updateMany: jest.Mock };
  tDSRecord: { deleteMany: jest.Mock };
  consultantProfile: { findUnique: jest.Mock };
  $transaction: (fn: (tx: unknown) => unknown) => unknown;
};

jest.mock("../../lib/prisma", () => {
  prismaStub = {
    consultantPayout: {
      findFirst: jest.fn(async () => payoutRow),
      updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const notIn = (where.status as { notIn?: string[] })?.notIn;
        if (notIn && notIn.includes(payoutRow.status as string)) {
          return { count: 0 }; // already terminal — idempotent no-op
        }
        Object.assign(payoutRow, data);
        return { count: 1 };
      }),
      aggregate: jest.fn(async () => ({ _sum: { amount: 0 } })),
    },
    consultantEarnings: { updateMany: jest.fn(async () => ({ count: 1 })) },
    tDSRecord: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    consultantProfile: { findUnique: jest.fn(async () => ({ userId: "user_1" })) },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prismaStub),
  };
  return { __esModule: true, default: prismaStub };
});

import { handlePayoutWebhook } from "../../lib/payments/payouts/payout-service";

beforeEach(() => {
  jest.clearAllMocks();
  payoutRow = { ...PAYOUT, earnings: [{ id: "ce_1", payoutId: "po_1", status: "BATCHED" }] };
});

describe("PM-15 — handlePayoutWebhook records TDS + ledger on COMPLETED", () => {
  it("records the TDS deduction and posts the payout ledger txn (revenue counters)", async () => {
    await handlePayoutWebhook("RAZORPAY", "pout_live_1", "COMPLETED");

    // TDS recorded — the inline reconciler flip never did this.
    expect(recordTDSDeduction).toHaveBeenCalledTimes(1);
    expect(recordTDSDeduction.mock.calls[0][0]).toMatchObject({
      payoutId: "po_1",
      tdsSection: "194O",
      tdsDeducted: 1000,
    });

    // Payout ledger transaction posted — the revenue/payable counters that
    // drifted when the old path skipped the canonical handler.
    expect(postLedgerTxn).toHaveBeenCalledTimes(1);
    expect(postLedgerTxn.mock.calls[0][1]).toMatchObject({
      kind: "PAYOUT",
      idempotencyKey: "payout:po_1",
    });

    // Canonical state landed: COMPLETED + earnings BATCHED→PAID. #993 — the PAID
    // flip is CAS-guarded on the BATCHED from-state (staged at batch creation),
    // so only genuinely-batched earnings settle at completion.
    expect(payoutRow.status).toBe("COMPLETED");
    expect(prismaStub.consultantEarnings.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { payoutId: "po_1", status: "BATCHED" },
        data: expect.objectContaining({ status: "PAID" }),
      }),
    );
  });

  it("idempotent: an already-COMPLETED payout records no new TDS/ledger", async () => {
    payoutRow.status = "COMPLETED";

    await handlePayoutWebhook("RAZORPAY", "pout_live_1", "COMPLETED");

    // The claim matched zero rows (notIn COMPLETED) ⇒ no second money write.
    expect(recordTDSDeduction).not.toHaveBeenCalled();
    expect(postLedgerTxn).not.toHaveBeenCalled();
  });
});
