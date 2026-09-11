/**
 * @jest-environment node
 */

/**
 * PM-4 / PM-13 — dispute-create + refund-failed webhook correctness in
 * app/api/webhooks/utils.ts.
 *
 * PM-4: handleDisputeCreated must page (recordSystemError, CRITICAL_DISPUTE_
 *   UNLINKED) when it can't link the dispute to a payment — both when the
 *   Razorpay lookup throws AND when no payment row matches. Otherwise a dropped
 *   dispute leaves disputed earnings payable until the 6h reconcile cron.
 * PM-13: handleRefundCreated must NOT mint an orphan FAILED Refund row for a
 *   `refund.failed` event on an existing B2C payment when we have no prior
 *   Refund row (dashboard-initiated refund). No money moves either way.
 *
 * We drive the handlers against an in-memory prisma tx stub and mock the
 * razorpay client + system-events recorder so we assert side effects directly.
 */

const recordSystemError = jest.fn().mockResolvedValue(undefined);
const razorpayPaymentsFetch = jest.fn();

jest.mock("../../lib/enterprise/system-events", () => ({
  __esModule: true,
  recordSystemError: (...args: unknown[]) => recordSystemError(...args),
  recordSystemEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../lib/payments/core/razorpay", () => ({
  __esModule: true,
  razorpayClient: { payments: { fetch: (...a: unknown[]) => razorpayPaymentsFetch(...a) } },
  getRazorpayClient: () => ({ payments: { fetch: (...a: unknown[]) => razorpayPaymentsFetch(...a) } }),
}));
jest.mock("../../lib/payments/core/stripe", () => ({ stripeClient: null, getStripeClient: () => null }));

// Minimal stubs for the rest of utils.ts's import graph so module load works.
jest.mock("../../lib/novu", () => ({
  notifyRefundProcessed: jest.fn(),
  notifyDisputeCreated: jest.fn(),
  notifyDisputeResolved: jest.fn(),
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgInvoicePaid: jest.fn(),
  notifyOrgWalletTopupConfirmed: jest.fn(),
}));
jest.mock("../../lib/referrals/service", () => ({ reverseCreditsForPayment: jest.fn() }));
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
// PM-13 — the SUCCEEDED-refund test only needs to prove a Refund row is
// created; the canonical cascade's money work is owned by refund-operation.test.
jest.mock("../../lib/payments/operations/refund", () => ({
  applyRefundCascade: jest.fn().mockResolvedValue({}),
  mintInvoiceRefundCreditNote: jest.fn(),
  mintRefundCreditNote: jest.fn(),
}));

// In-memory store for the tx stub.
type Row = Record<string, unknown>;
const store: {
  payments: Map<string, Row>;
  disputes: Row[];
  refunds: Row[];
  consultantEarnings: Row[];
} = {
  payments: new Map(),
  disputes: [],
  refunds: [],
  consultantEarnings: [],
};

function txStub() {
  return {
    payment: {
      // #1353 — the handlers resolve by EITHER id now (order id or the gateway
      // payment id), so the stub answers the `OR` shape they actually send.
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: { OR?: Array<Record<string, string | undefined>> };
        }) => {
          const clauses = where.OR ?? [];
          return (
            Array.from(store.payments.values()).find((p) =>
              clauses.some(
                (clause) =>
                  (clause.paymentIntent !== undefined &&
                    clause.paymentIntent === p.paymentIntent) ||
                  (clause.gatewayPaymentId !== undefined &&
                    clause.gatewayPaymentId === p.gatewayPaymentId),
              ),
            ) ?? null
          );
        },
      ),
      findUnique: jest.fn(async ({ where }: { where: Row }) => {
        // Lookup is by paymentIntent for the B2C path.
        if (where.paymentIntent) {
          return (
            Array.from(store.payments.values()).find(
              (p) => p.paymentIntent === where.paymentIntent,
            ) ?? null
          );
        }
        return store.payments.get(where.id as string) ?? null;
      }),
    },
    dispute: {
      findUnique: jest.fn(async ({ where }: { where: Row }) =>
        store.disputes.find((d) => d.disputeId === where.disputeId) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Row }) => {
        store.disputes.push(data);
        return data;
      }),
    },
    refund: {
      findUnique: jest.fn(async ({ where }: { where: Row }) =>
        store.refunds.find((r) => r.refundId === where.refundId) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const created = { id: `refund_${store.refunds.length + 1}`, ...data };
        store.refunds.push(created);
        return created;
      }),
      update: jest.fn(async () => ({})),
    },
    consultantEarnings: {
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    // #1008 — org earnings hold/release/refund mirror the consultant side.
    organizationEarnings: {
      updateMany: jest.fn(async () => ({ count: 0 })),
      findMany: jest.fn(async () => []),
      update: jest.fn(async () => ({})),
    },
  };
}

const stub = txStub();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => unknown) => fn(stub),
  },
}));

import {
  handleDisputeCreated,
  handleRefundCreated,
} from "../../app/api/webhooks/utils";

beforeEach(() => {
  jest.clearAllMocks();
  store.payments.clear();
  store.disputes.length = 0;
  store.refunds.length = 0;
  store.consultantEarnings.length = 0;
});

describe("PM-4 — handleDisputeCreated pages when it can't link the dispute", () => {
  it("records a CRITICAL_DISPUTE_UNLINKED system error when the Razorpay fetch throws", async () => {
    razorpayPaymentsFetch.mockRejectedValue(new Error("RZP 500"));

    await handleDisputeCreated(
      "disp_1",
      "pay_charge_1",
      5000,
      "INR",
      "fraudulent",
      "open",
      null,
      true,
      "RAZORPAY",
    );

    expect(recordSystemError).toHaveBeenCalled();
    const summaries = recordSystemError.mock.calls.map(
      (c) => (c[0] as { summary: string }).summary,
    );
    expect(summaries.some((s) => s.includes("CRITICAL_DISPUTE_UNLINKED"))).toBe(
      true,
    );
    // No dispute row was created (it was dropped) — that's exactly why we page.
    expect(store.disputes).toHaveLength(0);
  });

  it("records a CRITICAL_DISPUTE_UNLINKED system error when no payment matches", async () => {
    // Razorpay fetch succeeds and yields an order_id, but no Payment row maps.
    razorpayPaymentsFetch.mockResolvedValue({ order_id: "order_missing" });

    await handleDisputeCreated(
      "disp_2",
      "pay_charge_2",
      5000,
      "INR",
      "fraudulent",
      "open",
      null,
      true,
      "RAZORPAY",
    );

    const summaries = recordSystemError.mock.calls.map(
      (c) => (c[0] as { summary: string }).summary,
    );
    expect(summaries.some((s) => s.includes("CRITICAL_DISPUTE_UNLINKED"))).toBe(
      true,
    );
    expect(store.disputes).toHaveLength(0);
  });

  it("does NOT page when the dispute links cleanly to a payment", async () => {
    razorpayPaymentsFetch.mockResolvedValue({ order_id: "order_ok" });
    store.payments.set("pay_db_1", {
      id: "pay_db_1",
      paymentIntent: "order_ok",
      userId: "user_1",
    });

    await handleDisputeCreated(
      "disp_3",
      "pay_charge_3",
      5000,
      "INR",
      "fraudulent",
      "open",
      null,
      true,
      "RAZORPAY",
    );

    expect(recordSystemError).not.toHaveBeenCalled();
    expect(store.disputes).toHaveLength(1);
  });
});

describe("PM-13 — handleRefundCreated drops orphan refund.failed", () => {
  it("does NOT create a Refund row for refund.failed with no existing refund", async () => {
    store.payments.set("pay_b2c", {
      id: "pay_b2c",
      paymentIntent: "order_b2c",
      userId: "user_2",
      amount: 10000,
    });

    await handleRefundCreated(
      "rfnd_dashboard",
      "order_b2c",
      10000,
      "INR",
      "failed",
      "RAZORPAY",
    );

    expect(stub.refund.create).not.toHaveBeenCalled();
    expect(store.refunds).toHaveLength(0);
  });

  it("still creates a Refund row for a non-failed (succeeded) refund", async () => {
    store.payments.set("pay_b2c_2", {
      id: "pay_b2c_2",
      paymentIntent: "order_b2c_2",
      userId: "user_3",
      amount: 10000,
      organizationId: null,
    });

    await handleRefundCreated(
      "rfnd_ok",
      "order_b2c_2",
      10000,
      "INR",
      "processed",
      "RAZORPAY",
    );

    expect(stub.refund.create).toHaveBeenCalledTimes(1);
    expect(store.refunds).toHaveLength(1);
    expect(store.refunds[0].refundId).toBe("rfnd_ok");
  });
});
