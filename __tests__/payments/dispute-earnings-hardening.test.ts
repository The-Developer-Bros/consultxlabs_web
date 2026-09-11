/**
 * @jest-environment node
 */

/**
 * #1020 findings 1–3 — dispute → earnings hardening in handleDisputeCreated /
 * handleDisputeUpdated (app/api/webhooks/utils.ts).
 *
 * 1. preDisputeStatus — a dispute HELD a PENDING earning and a WON release
 *    force-matured it to READY. The hold now records the prior status and the
 *    release restores it; a second dispute can't clobber a first hold's
 *    marker because the hold CAS excludes already-HELD rows.
 * 2. Paid-earning clawback — the LOST loops queried status:HELD only, missing
 *    earnings already paid out before the chargeback landed. Both loops now
 *    include PAID rows; the consultant rail has no auto-clawback, so it flips
 *    state truthfully and pages ops once per dispute with the total.
 * 3. Proration — a PARTIAL dispute used to reverse the FULL share on both
 *    sides; reversals are now floored to `share × dispute/payment`.
 *
 * The tx stub is typed against real row interfaces (not string-keyed blobs):
 * every fixture field is compile-checked against what the handler reads.
 */

import type { DisputeStatus, EarningStatus } from "@prisma/client";

/** The payload shape recordSystemError receives (lib/enterprise/system-events). */
interface SystemErrorPayload {
  organizationId?: string | null;
  category?: string;
  summary: string;
  err?: unknown;
  context?: Record<string, unknown>;
}

const recordSystemError = jest
  .fn<Promise<void>, [SystemErrorPayload]>()
  .mockResolvedValue(undefined);
const razorpayPaymentsFetch = jest.fn<
  Promise<{ order_id: string }>,
  [chargeId: string]
>();
const applyReversal = jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({});
const recordTdsReversal = jest.fn<
  Promise<void>,
  [{ payoutId: string; consultantProfileId: string; earningsId: string; refundAmountPaise: number; paymentAmountPaise: number }]
>();

jest.mock("../../lib/enterprise/system-events", () => ({
  __esModule: true,
  recordSystemError: (...args: Parameters<typeof recordSystemError>) =>
    recordSystemError(...args),
  recordSystemEvent: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
}));
// #1221 — the client is lazy-initialized via getRazorpayClient(); the mock
// hands back an object shaped like the SDK surface the handler touches.
jest.mock("../../lib/payments/core/razorpay", () => ({
  __esModule: true,
  getRazorpayClient: () => ({
    payments: {
      fetch: (chargeId: string) => razorpayPaymentsFetch(chargeId),
    },
  }),
}));
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
jest.mock("../../lib/novu/service", () => ({
  notifyRefundFailed: jest.fn(),
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
jest.mock("../../lib/payments/operations/reversal-engine", () => ({
  applyReversal: (...a: Parameters<typeof applyReversal>) =>
    applyReversal(...a),
}));
jest.mock("../../lib/payments/tax/tds-service", () => ({
  recordTdsReversal: (...a: Parameters<typeof recordTdsReversal>) =>
    recordTdsReversal(...a),
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  applyRefundCascade: jest.fn().mockResolvedValue({}),
  mintInvoiceRefundCreditNote: jest.fn(),
  mintRefundCreditNote: jest.fn().mockResolvedValue({ creditNoteId: null }),
}));
// #1365 — the chargeback path now mints the B2C credit note beside the org one.
jest.mock("../../lib/payments/billing/consumer-invoice", () => ({
  mintConsumerCreditNote: jest
    .fn()
    .mockResolvedValue({ consumerCreditNoteId: null }),
  mintConsumerInvoice: jest.fn().mockResolvedValue({ consumerInvoiceId: null }),
}));

// ---------------------------------------------------------------------------
// Row types — exactly the fields the handler reads/writes. Fixtures are these
// interfaces, so a typo'd or missing field fails compilation, not production.
// ---------------------------------------------------------------------------

interface PaymentRow {
  id: string;
  paymentIntent: string;
  /** #1353 — the gateway `pay_…` id; the second key the handlers match on. */
  gatewayPaymentId?: string | null;
  userId: string;
  amount: number;
  organizationId: string | null;
  billingAccountId: string | null;
  gstTcsCollectedPaise: number | null;
}

interface DisputeRow {
  id: string;
  disputeId: string;
  status: DisputeStatus;
  amountPaise: number;
  paymentId: string;
}

interface ConsultantEarningRow {
  id: string;
  paymentId: string;
  status: EarningStatus;
  preDisputeStatus?: EarningStatus | null;
  consultantSharePaise: number;
  refundedShareAmount: number;
  consultantProfileId: string;
  payoutId: string | null;
}

interface OrgEarningRow {
  id: string;
  paymentId: string;
  status: EarningStatus;
  preDisputeStatus?: EarningStatus | null;
  orgSharePaise: number;
  refundedAmountPaise: number;
  organizationId: string;
  orgPayoutId: string | null;
  orgPayout: { status: string } | null;
}

/** Prisma-style update payload the handler issues (increment ops included). */
interface IncrementOp {
  increment: number;
}
type EarningsUpdate = Partial<Omit<ConsultantEarningRow, "refundedShareAmount" | "refundedAmountPaise">> & {
  refundedShareAmount?: number | IncrementOp;
  refundedAmountPaise?: number | IncrementOp;
};

/** The two WHERE shapes handleDispute* issues on earnings tables. */
interface EarningsHoldWhere {
  paymentId: string;
  status?: EarningStatus;
  preDisputeStatus?: EarningStatus | null;
}
interface EarningsLostWhere {
  paymentId: string;
  status?: { in: EarningStatus[] };
}

function isIncrement(value: unknown): value is IncrementOp {
  return (
    value !== null &&
    typeof value === "object" &&
    "increment" in (value as IncrementOp)
  );
}

/** Apply a Prisma-style update (plain sets + `{increment}` ops) to a row. */
function resolveUpdate(
  row: ConsultantEarningRow | OrgEarningRow,
  data: EarningsUpdate,
): void {
  const target = row as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    const current = target[key];
    target[key] = isIncrement(value)
      ? (typeof current === "number" ? current : 0) + value.increment
      : value;
  }
}

// ---------------------------------------------------------------------------
// Store + tx stub
// ---------------------------------------------------------------------------

const store: {
  payments: Map<string, PaymentRow>;
  disputes: DisputeRow[];
  consultantEarnings: ConsultantEarningRow[];
  orgEarnings: OrgEarningRow[];
} = { payments: new Map(), disputes: [], consultantEarnings: [], orgEarnings: [] };

function resetStore(): void {
  store.payments.clear();
  store.disputes.length = 0;
  store.consultantEarnings.length = 0;
  store.orgEarnings.length = 0;
}

function inList(status: EarningsLostWhere["status"], actual: EarningStatus): boolean {
  return !status || status.in.includes(actual);
}

interface TxStub {
  payment: {
    findUnique: (args: { where: { paymentIntent?: string; id?: string } }) => Promise<PaymentRow | null>;
    // #1353 — handleDisputeCreated resolves by either id through an `OR`.
    findFirst: (args: {
      where: { OR?: Array<Record<string, string | undefined>> };
    }) => Promise<PaymentRow | null>;
  };
  dispute: {
    findUnique: (args: { where: { disputeId: string } }) => Promise<(DisputeRow & { payment: PaymentRow | null }) | null>;
    create: (args: { data: Omit<DisputeRow, "id"> }) => Promise<DisputeRow>;
    update: (args: { where: { disputeId: string }; data: Partial<DisputeRow> }) => Promise<DisputeRow | null>;
  };
  consultantEarnings: {
    updateMany: (args: { where: EarningsHoldWhere; data: Record<string, unknown> }) => Promise<{ count: number }>;
    findMany: (args: { where: EarningsLostWhere }) => Promise<ConsultantEarningRow[]>;
    update: (args: { where: { id: string }; data: EarningsUpdate }) => Promise<ConsultantEarningRow | null>;
  };
  organizationEarnings: {
    updateMany: (args: { where: EarningsHoldWhere; data: Record<string, unknown> }) => Promise<{ count: number }>;
    findMany: (args: { where: EarningsLostWhere }) => Promise<OrgEarningRow[]>;
    update: (args: { where: { id: string }; data: EarningsUpdate }) => Promise<OrgEarningRow | null>;
  };
  refund: {
    findUnique: () => Promise<null>;
    update: () => Promise<Record<string, never>>;
    create: () => Promise<Record<string, never>>;
    aggregate: () => Promise<{ _sum: { amountPaise: number | null } }>;
  };
  billingAccount: { findFirst: () => Promise<null> };
  ledgerTransaction: {
    findUnique: () => Promise<null>;
    create: () => Promise<Record<string, never>>;
  };
  orgAuditLog: { create: () => Promise<Record<string, never>> };
  gstTcsAdjustment: { create: () => Promise<Record<string, never>> };
}

let tx: TxStub;

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { $transaction: jest.fn() },
}));

import prisma from "../../lib/prisma";
import {
  handleDisputeCreated,
  handleDisputeUpdated,
} from "../../app/api/webhooks/utils";

const mockedTransaction = prisma.$transaction as unknown as jest.Mock;

/** Build the per-test stub against the live store. */
function makeTxStub(): TxStub {
  return {
    payment: {
      findFirst: async ({ where }) => {
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
      findUnique: async ({ where }) => {
        if (where.paymentIntent) {
          return (
            Array.from(store.payments.values()).find(
              (p) => p.paymentIntent === where.paymentIntent,
            ) ?? null
          );
        }
        return store.payments.get(where.id ?? "") ?? null;
      },
    },
    dispute: {
      findUnique: async ({ where }) => {
        const row = store.disputes.find((d) => d.disputeId === where.disputeId);
        if (!row) return null;
        // Hydrate the include the handler selects (#738-B tax-parity read).
        return { ...row, payment: store.payments.get(row.paymentId) ?? null };
      },
      create: async ({ data }) => {
        const created: DisputeRow = { id: `disp_row_${store.disputes.length + 1}`, ...data };
        store.disputes.push(created);
        return created;
      },
      update: async ({ where, data }) => {
        const row = store.disputes.find((d) => d.disputeId === where.disputeId);
        if (!row) return null;
        Object.assign(row, data);
        return row;
      },
    },
    consultantEarnings: {
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const e of store.consultantEarnings) {
          if (e.paymentId !== where.paymentId) continue;
          if (where.status && e.status !== where.status) continue;
          if (
            where.preDisputeStatus !== undefined &&
            e.preDisputeStatus !== where.preDisputeStatus
          )
            continue;
          resolveUpdate(e, data);
          count++;
        }
        return { count };
      },
      findMany: async ({ where }) =>
        // Snapshot copies — real Prisma returns detached row images, and the
        // handler must not observe its own earlier update through them.
        store.consultantEarnings
          .filter(
            (e) =>
              e.paymentId === where.paymentId &&
              inList(where.status, e.status),
          )
          .map((e) => ({ ...e })),
      update: async ({ where, data }) => {
        const row = store.consultantEarnings.find((e) => e.id === where.id);
        if (!row) return null;
        resolveUpdate(row, data);
        return row;
      },
    },
    organizationEarnings: {
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const e of store.orgEarnings) {
          if (e.paymentId !== where.paymentId) continue;
          if (where.status && e.status !== where.status) continue;
          if (
            where.preDisputeStatus !== undefined &&
            e.preDisputeStatus !== where.preDisputeStatus
          )
            continue;
          resolveUpdate(e, data);
          count++;
        }
        return { count };
      },
      findMany: async ({ where }) =>
        store.orgEarnings
          .filter(
            (e) =>
              e.paymentId === where.paymentId &&
              inList(where.status, e.status),
          )
          .map((e) => ({ ...e })),
      update: async ({ where, data }) => {
        const row = store.orgEarnings.find((e) => e.id === where.id);
        if (!row) return null;
        resolveUpdate(row, data);
        return row;
      },
    },
    // applyOrgChargeback / B2C-reversal net prior SUCCEEDED refunds against
    // the chargeback; the appliers are stubbed, so report zero history.
    refund: {
      findUnique: async () => null,
      update: async () => ({}),
      create: async () => ({}),
      aggregate: async () => ({ _sum: { amountPaise: 0 } }),
    },
    billingAccount: { findFirst: async () => null },
    ledgerTransaction: {
      findUnique: async () => null,
      create: async () => ({}),
    },
    orgAuditLog: { create: async () => ({}) },
    gstTcsAdjustment: { create: async () => ({}) },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetStore();
  tx = makeTxStub();
  // handleDispute* passes options ({ isolationLevel, maxWait, timeout }) —
  // ignore them and run the callback against the fresh stub.
  mockedTransaction.mockImplementation(
    (fn: (tx: TxStub) => Promise<unknown>) => fn(tx),
  );
  razorpayPaymentsFetch.mockResolvedValue({ order_id: "order_ok" });
});

function seedPayment(amountPaise: number): void {
  store.payments.set("pay_db_1", {
    id: "pay_db_1",
    paymentIntent: "order_ok",
    userId: "user_1",
    amount: amountPaise,
    organizationId: null,
    billingAccountId: null,
    gstTcsCollectedPaise: null,
  });
}

async function openDispute(amountPaise: number, disputeId = "disp_1"): Promise<void> {
  await handleDisputeCreated(
    disputeId,
    "pay_charge_1",
    amountPaise,
    "INR",
    "fraudulent",
    "open",
    null,
    true,
    "RAZORPAY",
  );
}

async function seedOpenDispute(amountPaise: number): Promise<void> {
  store.disputes.push({
    id: "disp_row_1",
    disputeId: "disp_1",
    status: "NEEDS_RESPONSE",
    amountPaise,
    paymentId: "pay_db_1",
  });
}

describe("#1020-1 — hold records the pre-dispute status", () => {
  test("tags PENDING and READY rows with their own prior status", async () => {
    seedPayment(10_000);
    store.consultantEarnings.push(
      { id: "ce_pend", paymentId: "pay_db_1", status: "PENDING", consultantSharePaise: 5_000, refundedShareAmount: 0, consultantProfileId: "cp_1", payoutId: null },
      { id: "ce_ready", paymentId: "pay_db_1", status: "READY", consultantSharePaise: 5_000, refundedShareAmount: 0, consultantProfileId: "cp_1", payoutId: null },
    );

    await openDispute(5_000);

    expect(store.consultantEarnings.find((e) => e.id === "ce_pend")).toMatchObject({
      status: "HELD",
      preDisputeStatus: "PENDING",
    });
    expect(store.consultantEarnings.find((e) => e.id === "ce_ready")).toMatchObject({
      status: "HELD",
      preDisputeStatus: "READY",
    });
  });

  test("a second dispute on the same payment does NOT clobber the first hold's marker", async () => {
    seedPayment(10_000);
    store.consultantEarnings.push({
      id: "ce_ready",
      paymentId: "pay_db_1",
      status: "READY",
      consultantSharePaise: 8_000,
      refundedShareAmount: 0,
      consultantProfileId: "cp_1",
      payoutId: null,
    });

    await openDispute(5_000, "disp_a");
    await openDispute(2_000, "disp_b");

    expect(store.consultantEarnings[0]).toMatchObject({
      status: "HELD",
      preDisputeStatus: "READY",
    });
  });
});

describe("#1020-1 — WON restores the true prior state", () => {
  async function win(): Promise<void> {
    seedPayment(10_000);
    await seedOpenDispute(5_000);
    await handleDisputeUpdated("disp_1", "won", null);
  }

  test("a PENDING-held earning returns to PENDING, not READY", async () => {
    store.consultantEarnings.push({
      id: "ce_1",
      paymentId: "pay_db_1",
      status: "HELD",
      preDisputeStatus: "PENDING",
      consultantSharePaise: 5_000,
      refundedShareAmount: 0,
      consultantProfileId: "cp_1",
      payoutId: null,
    });

    await win();

    expect(store.consultantEarnings[0]).toMatchObject({
      status: "PENDING",
      preDisputeStatus: null,
    });
  });

  test("a READY-held earning returns to READY", async () => {
    store.consultantEarnings.push({
      id: "ce_1",
      paymentId: "pay_db_1",
      status: "HELD",
      preDisputeStatus: "READY",
      consultantSharePaise: 5_000,
      refundedShareAmount: 0,
      consultantProfileId: "cp_1",
      payoutId: null,
    });

    await win();

    expect(store.consultantEarnings[0]).toMatchObject({
      status: "READY",
      preDisputeStatus: null,
    });
  });

  test("legacy rows held before the column shipped still release to READY", async () => {
    store.orgEarnings.push({
      id: "oe_legacy",
      paymentId: "pay_db_1",
      status: "HELD",
      preDisputeStatus: null,
      orgSharePaise: 2_000,
      refundedAmountPaise: 0,
      organizationId: "org_1",
      orgPayoutId: null,
      orgPayout: null,
    });

    await win();

    expect(store.orgEarnings[0]).toMatchObject({
      status: "READY",
      preDisputeStatus: null,
    });
  });
});

describe("#1020-3 — LOST reversals are prorated to the disputed fraction", () => {
  test("a half-amount dispute refunds HALF the consultant share, not all of it", async () => {
    seedPayment(10_000);
    store.consultantEarnings.push({
      id: "ce_1",
      paymentId: "pay_db_1",
      status: "HELD",
      preDisputeStatus: "READY",
      consultantSharePaise: 8_000,
      refundedShareAmount: 0,
      consultantProfileId: "cp_1",
      payoutId: null,
    });
    await seedOpenDispute(5_000); // exactly half

    await handleDisputeUpdated("disp_1", "lost", null);

    expect(store.consultantEarnings[0]).toMatchObject({
      status: "REFUNDED",
      refundedShareAmount: 4_000, // floor(8000 × 0.5)
    });
  });

  test("a full-amount dispute keeps reversing the whole remaining share", async () => {
    seedPayment(10_000);
    store.consultantEarnings.push({
      id: "ce_1",
      paymentId: "pay_db_1",
      status: "HELD",
      consultantSharePaise: 8_000,
      refundedShareAmount: 500,
      consultantProfileId: "cp_1",
      payoutId: null,
    });
    await seedOpenDispute(10_000);

    await handleDisputeUpdated("disp_1", "lost", null);

    // refundedShareAmount is CUMULATIVE: 500 already refunded from an app
    // refund + the capped 7500 reversal now = the full share. The reversal
    // itself was capped at remaining-refundable, not the gross proration.
    expect(store.consultantEarnings[0]).toMatchObject({
      refundedShareAmount: 8_000,
    });
  });
});

describe("#1020-2 — already-paid earnings enter the LOST clawback", () => {
  test("PAID consultant earnings flip REFUNDED and page ops ONCE with the total", async () => {
    seedPayment(10_000);
    store.consultantEarnings.push(
      { id: "ce_paid1", paymentId: "pay_db_1", status: "PAID", consultantSharePaise: 6_000, refundedShareAmount: 0, consultantProfileId: "cp_1", payoutId: "payout_1" },
      { id: "ce_paid2", paymentId: "pay_db_1", status: "PAID", consultantSharePaise: 2_000, refundedShareAmount: 0, consultantProfileId: "cp_2", payoutId: null },
    );
    await seedOpenDispute(10_000); // full dispute → factor 1

    await handleDisputeUpdated("disp_1", "lost", null);

    expect(store.consultantEarnings.map((e) => e.status)).toEqual([
      "REFUNDED",
      "REFUNDED",
    ]);
    // TDS reversed against the paid-out earning's payout.
    expect(recordTdsReversal).toHaveBeenCalledTimes(1);
    // Exactly ONE ops page carrying the combined manual-recovery total —
    // dispatched POST-commit, so an aborted tx can never page (see below).
    const pages = recordSystemError.mock.calls
      .map(([payload]) => payload.summary)
      .filter((summary) => summary.includes("Chargeback clawback needed"));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain("8000 paise");
  });

  test("an aborted transaction never pages — the page is post-commit", async () => {
    seedPayment(10_000);
    store.consultantEarnings.push({
      id: "ce_paid1",
      paymentId: "pay_db_1",
      status: "PAID",
      consultantSharePaise: 6_000,
      refundedShareAmount: 0,
      consultantProfileId: "cp_1",
      payoutId: "payout_1",
    });
    await seedOpenDispute(10_000);

    // SSI abort: prisma.$transaction rejects after the handler staged the page.
    mockedTransaction.mockImplementationOnce(async () => {
      throw new Error("P2034 serialization failure");
    });

    await expect(handleDisputeUpdated("disp_1", "lost", null)).rejects.toThrow(
      /serialization failure/,
    );

    const clawbackPages = recordSystemError.mock.calls
      .map(([payload]) => payload.summary)
      .filter((summary) => summary.includes("Chargeback clawback needed"));
    expect(clawbackPages).toHaveLength(0);
  });

  test("PAID org earnings are clawed back through the reversal engine, prorated", async () => {
    seedPayment(10_000);
    store.orgEarnings.push({
      id: "oe_paid",
      paymentId: "pay_db_1",
      status: "PAID",
      orgSharePaise: 2_000,
      refundedAmountPaise: 0,
      organizationId: "org_1",
      orgPayoutId: "opayout_1",
      orgPayout: { status: "COMPLETED" },
    });
    await seedOpenDispute(5_000); // 50%

    await handleDisputeUpdated("disp_1", "lost", null);

    expect(store.orgEarnings[0]).toMatchObject({
      status: "REFUNDED",
      refundedAmountPaise: 1_000, // floor(2000 × 0.5)
    });
    expect(applyReversal).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        source: expect.objectContaining({
          kind: "PAYOUT_CLAWBACK",
          orgPayoutId: "opayout_1",
        }),
        amountPaise: 1_000,
      }),
    );
  });
});
