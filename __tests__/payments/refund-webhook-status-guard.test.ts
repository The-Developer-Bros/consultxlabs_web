/**
 * @jest-environment node
 */

/**
 * Refund status state machine in handleRefundCreated (money-hardening pass).
 *
 * The old guard compared the Prisma enum (`SUCCEEDED`) against the RAW gateway
 * string (`"processed"`), so it never short-circuited and every redelivery or
 * out-of-order event rewrote the row: a stale `refund.created` (status
 * "pending") arriving after `refund.processed` downgraded a settled refund to
 * PENDING — manufacturing the unsweepable real-id-PENDING limbo class.
 *
 * Guard under test:
 *   - PENDING is the only state a gateway event may leave;
 *   - SUCCEEDED / FAILED / CANCELLED are terminal (log-and-return);
 *   - PENDING → SUCCEEDED still runs the cascade side effects exactly once.
 *
 * Modeled on dispute-refund-correctness.test.ts's in-memory tx stub.
 */

const recordSystemError = jest.fn().mockResolvedValue(undefined);

jest.mock("../../lib/enterprise/system-events", () => ({
  __esModule: true,
  recordSystemError: (...args: unknown[]) => recordSystemError(...args),
  recordSystemEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/payments/core/razorpay", () => ({
  __esModule: true,
  razorpayClient: { payments: { fetch: jest.fn() } },
}));
jest.mock("../../lib/payments/core/stripe", () => ({ stripeClient: null }));
jest.mock("../../lib/novu/service", () => ({
  notifyRefundProcessed: jest.fn().mockResolvedValue(undefined),
  notifyRefundFailed: jest.fn(),
}));
jest.mock("../../lib/novu", () => ({
  notifyRefundProcessed: jest.fn().mockResolvedValue(undefined),
  notifyDisputeCreated: jest.fn(),
  notifyDisputeResolved: jest.fn(),
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgInvoicePaid: jest.fn(),
  notifyOrgWalletTopupConfirmed: jest.fn(),
}));
jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: jest.fn().mockResolvedValue(0),
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
const applyRefundCascade = jest.fn().mockResolvedValue({});
jest.mock("../../lib/payments/operations/refund", () => ({
  applyRefundCascade: (...a: unknown[]) => applyRefundCascade(...a),
  mintInvoiceRefundCreditNote: jest.fn(),
  mintRefundCreditNote: jest.fn(),
}));
jest.mock("../../lib/payments/ledger/post", () => ({
  postLedgerTxn: jest.fn().mockResolvedValue({ created: true }),
}));

import prisma from "../../lib/prisma";
import type { RefundStatus } from "@prisma/client";

/** The refund fields the handler reads and the assertions pin. */
interface RefundRow {
  id: string;
  refundId: string;
  status: RefundStatus;
  paymentId: string;
}

/** The one Payment the stubbed database holds, keyed by both of its ids. */
const PAYMENT_ROW = {
  id: "pay_1",
  paymentIntent: "order_1",
  gatewayPaymentId: "pay_gateway_1",
  userId: "user_1",
  organizationId: null,
  amount: 50_000,
  currency: "INR",
  billingAccountId: null,
};

const store: { refunds: RefundRow[] } = { refunds: [] };

function resetStore() {
  store.refunds = [];
}

function txStub() {
  return {
    payment: {
      // #1353 — the handler resolves by EITHER id now, so the stub has to be a
      // real matcher rather than a constant: a test that returns the same row
      // whatever the `where` says cannot tell the two keys apart.
      findFirst: jest.fn(
        async ({ where }: { where: { OR: Array<Record<string, string>> } }) => {
          const matches = where.OR.some(
            (clause) =>
              clause.paymentIntent === PAYMENT_ROW.paymentIntent ||
              clause.gatewayPaymentId === PAYMENT_ROW.gatewayPaymentId,
          );
          return matches ? PAYMENT_ROW : null;
        },
      ),
    },
    creditNote: {
      findUnique: jest.fn(async () => null),
      aggregate: jest.fn(async () => ({ _sum: { totalPaise: null } })),
    },
    walletTopUp: { findFirst: jest.fn(async () => null) },
    organizationInvoice: { findFirst: jest.fn(async () => null) },
    billingAccount: {
      findFirst: jest.fn(async () => null),
      findUniqueOrThrow: jest.fn(),
    },
    orgAuditLog: { create: jest.fn(async () => ({})) },
    refund: {
      findUnique: jest.fn(
        async ({ where }: { where: { refundId: string } }) =>
          store.refunds.find((r) => r.refundId === where.refundId) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Omit<RefundRow, "id"> }) => {
        const created: RefundRow = {
          id: `row_${store.refunds.length + 1}`,
          ...data,
        };
        store.refunds.push(created);
        return created;
      }),
      update: jest.fn(async ({ data }: { data: Partial<RefundRow> }) => {
        const row = store.refunds[0];
        if (row) Object.assign(row, data);
        return row ?? {};
      }),
    },
  };
}

type TxStub = ReturnType<typeof txStub>;

// Single typed seam over the real client: the handler's $transaction callback
// runs against our stub (env-backed prisma import, same trick as before —
// the double cast is confined to this one assignment).
type TransactionFn = (
  fn: (tx: TxStub) => Promise<unknown>,
  opts?: unknown,
) => Promise<unknown>;
(prisma as unknown as { $transaction: TransactionFn }).$transaction = (fn) =>
  fn(txStub());

import { handleRefundCreated } from "../../app/api/webhooks/utils";

beforeEach(() => {
  jest.clearAllMocks();
  resetStore();
  applyRefundCascade.mockClear().mockResolvedValue({});
});

describe("handleRefundCreated status transition guard", () => {
  test("a stale refund.created does NOT downgrade a SUCCEEDED refund", async () => {
    store.refunds.push({
      id: "row_1",
      refundId: "rfnd_1",
      status: "SUCCEEDED",
      paymentId: "pay_1",
    });

    await handleRefundCreated(
      "rfnd_1",
      "order_1",
      10_000,
      "INR",
      "pending", // raw gateway string from a late/out-of-order refund.created
      "RAZORPAY",
    );

    // No update may run at all — the row must stay settled.
    expect(store.refunds[0].status).toBe("SUCCEEDED");
    // And the cascade must not re-run.
    expect(applyRefundCascade).not.toHaveBeenCalled();
  });

  test("a redelivered refund.processed cannot resurrect a FAILED refund", async () => {
    store.refunds.push({
      id: "row_1",
      refundId: "rfnd_1",
      status: "FAILED",
      paymentId: "pay_1",
    });

    await handleRefundCreated(
      "rfnd_1",
      "order_1",
      10_000,
      "INR",
      "processed",
      "RAZORPAY",
    );

    expect(store.refunds[0].status).toBe("FAILED");
    expect(applyRefundCascade).not.toHaveBeenCalled();
  });

  test("PENDING → processed maps the enum, settles, and cascades once", async () => {
    store.refunds.push({
      id: "row_1",
      refundId: "rfnd_1",
      status: "PENDING",
      paymentId: "pay_1",
    });

    await handleRefundCreated(
      "rfnd_1",
      "order_1",
      10_000,
      "INR",
      "processed",
      "RAZORPAY",
    );

    expect(store.refunds[0].status).toBe("SUCCEEDED");
    expect(applyRefundCascade).toHaveBeenCalledTimes(1);
    expect(applyRefundCascade).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ paymentId: "pay_1", refundId: "row_1" }),
    );
  });

  // #1353 — the pin for the lookup change. Razorpay's refund webhook carries
  // only the `pay_…` payment id, and when the dispatcher's `payments.fetch`
  // translation failed it handed that id through as `paymentIntentId`. A lookup
  // keyed solely on `Payment.paymentIntent` (which holds the ORDER id) could
  // never match it, so the handler deferred and the sweeper re-drove the event
  // for up to a week against a payment that had been captured all along.
  test("a refund whose paymentIntentId is a pay_ id resolves via gatewayPaymentId", async () => {
    store.refunds.push({
      id: "row_1",
      refundId: "rfnd_1",
      status: "PENDING",
      paymentId: "pay_1",
    });

    await handleRefundCreated(
      "rfnd_1",
      // Not an order id — exactly what the dispatcher passes through when the
      // gateway translation is unavailable.
      "pay_gateway_1",
      10_000,
      "INR",
      "processed",
      "RAZORPAY",
      "pay_gateway_1",
    );

    // Resolved, settled and cascaded — not deferred.
    expect(store.refunds[0].status).toBe("SUCCEEDED");
    expect(applyRefundCascade).toHaveBeenCalledTimes(1);
  });

  test("same-status redelivery of a PENDING refund is a no-op", async () => {
    store.refunds.push({
      id: "row_1",
      refundId: "rfnd_1",
      status: "PENDING",
      paymentId: "pay_1",
    });

    await handleRefundCreated(
      "rfnd_1",
      "order_1",
      10_000,
      "INR",
      "pending",
      "RAZORPAY",
    );

    expect(applyRefundCascade).not.toHaveBeenCalled();
    expect(store.refunds).toHaveLength(1);
  });
});
