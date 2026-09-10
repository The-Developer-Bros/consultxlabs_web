/**
 * @jest-environment node
 */

/**
 * Refund reconcile matcher (money-hardening pass).
 *
 * The old matcher required `gateway metadata.created`, which NO writer ever
 * set — it could never match, so every placeholder was force-FAILED at 24h
 * even when the refund HAD landed. Failing restores the refundable balance,
 * ops retries under a fresh idempotency key, and the gateway issues a SECOND
 * refund: platform loss. Recovery is also bound by Stripe's 24h idempotency
 * key retention / Razorpay's no-self-serve-replay: "fail locally, retry under
 * a new key" is never safe without a gateway lookup first.
 *
 * Under test:
 *   - exact bind on notes.reservationId (the identity we ride to the gateway);
 *   - FAIL only after 24h AND a succeeded listing with no reservation match;
 *   - ambiguous legacy candidates (multiple amount matches, no ids) stay
 *     PENDING and page instead of guessing;
 *   - real-id PENDING rows are polled via getRefund and settled.
 */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    refund: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn(),
  },
}));
jest.mock("../../lib/payments", () => ({
  listRefunds: jest.fn(),
  getRefund: jest.fn(),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyRefundFailed: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  // Passthrough — the lock machinery has its own suite; these tests own the
  // matcher semantics.
  withCronLock: (_key: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
  LONG_JOB_TTL_MS: 35 * 60_000,
}));

import prisma from "../../lib/prisma";
import { listRefunds, getRefund } from "../../lib/payments";
import { reportSentryMessage } from "../../lib/observability/report";
import { reconcilePendingRefunds } from "../../scripts/refunds/reconcile-pending-refunds";

/** The Prisma refund surface the reconcile core touches. */
interface ReconcileRefundMock {
  findMany: jest.Mock;
  findUnique: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
}
interface ReconcilePrismaMock {
  refund: ReconcileRefundMock;
}

// Single seam over the generated client (repo-wide mock idiom).
const refundTable = (prisma as unknown as ReconcilePrismaMock).refund;
const mockList = listRefunds as jest.Mock;
const mockGet = getRefund as jest.Mock;
const mockPage = reportSentryMessage as jest.Mock;

const HOUR = 60 * 60 * 1000;

/** A stale placeholder row as the reconcile core's selector sees it. */
interface PlaceholderRow {
  id: string;
  refundId: string;
  status: "PENDING";
  amountPaise: number;
  createdAt: Date;
  metadata: Record<string, string>;
  payment: { paymentIntent: string; paymentGateway: "RAZORPAY" | "STRIPE" };
  ageHours?: number;
}

function placeholderRow(overrides: Partial<PlaceholderRow> = {}): PlaceholderRow {
  const ageHours = overrides.ageHours ?? 2;
  const { ageHours: _ignored, ...rest } = overrides;
  void _ignored;
  return {
    id: "res_1",
    refundId: "pending_uuid-1",
    status: "PENDING",
    amountPaise: 10_000,
    createdAt: new Date(Date.now() - ageHours * HOUR),
    metadata: {},
    payment: {
      paymentIntent: "order_1",
      paymentGateway: "RAZORPAY",
    },
    ...rest,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  refundTable.findUnique.mockResolvedValue(null);
});

describe("reconcilePendingRefunds placeholder matching", () => {
  test("binds exactly on notes.reservationId === the reservation row id", async () => {
    refundTable.findMany
      .mockResolvedValueOnce([placeholderRow()])
      .mockResolvedValueOnce([]); // real-id pass
    mockList.mockResolvedValueOnce([
      {
        refundId: "rfnd_exact",
        amount: 10_000,
        currency: "INR",
        status: "processed",
        metadata: { reservationId: "res_1" }, // what Phase 2 rode to the gateway
      },
    ]);

    const result = await reconcilePendingRefunds();

    expect(result.reconciledCount).toBe(1);
    expect(refundTable.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "res_1" },
        data: expect.objectContaining({
          refundId: "rfnd_exact",
          status: "SUCCEEDED",
        }),
      }),
    );
    // Never failed while a match existed.
    expect(result.failedCount).toBe(0);
  });

  test("FAILs a >24h placeholder only when the listing succeeded and no reservation match exists", async () => {
    refundTable.findMany
      .mockResolvedValueOnce([placeholderRow({ ageHours: 30 })])
      .mockResolvedValueOnce([]);
    // Gateway listing SUCCEEDED — genuinely no refund landed for this key.
    mockList.mockResolvedValueOnce([
      {
        refundId: "rfnd_other",
        amount: 55_555,
        status: "processed",
        metadata: { reservationId: "res_someone_else" },
      },
    ]);

    const result = await reconcilePendingRefunds();

    expect(result.failedCount).toBe(1);
    expect(refundTable.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "res_1" },
        data: expect.objectContaining({ status: "FAILED" }),
      }),
    );
  });

  test("a young unmatched placeholder stays PENDING within the grace window", async () => {
    refundTable.findMany
      .mockResolvedValueOnce([placeholderRow({ ageHours: 2 })])
      .mockResolvedValueOnce([]);
    mockList.mockResolvedValueOnce([]);

    const result = await reconcilePendingRefunds();

    expect(result.failedCount).toBe(0);
    expect(result.skippedCount).toBeGreaterThanOrEqual(1);
    expect(refundTable.update).not.toHaveBeenCalled();
  });

  test("ambiguous legacy candidates stay PENDING and page instead of guessing", async () => {
    refundTable.findMany
      .mockResolvedValueOnce([
        placeholderRow({ ageHours: 30, metadata: { source: "app" } }),
      ])
      .mockResolvedValueOnce([]);
    // Two same-amount gateway refunds carrying NO reservation id — binding
    // either would be a coin flip on someone else's money.
    mockList.mockResolvedValueOnce([
      { refundId: "rfnd_a", amount: 10_000, status: "processed", metadata: {} },
      { refundId: "rfnd_b", amount: 10_000, status: "processed", metadata: {} },
    ]);

    const result = await reconcilePendingRefunds();

    expect(result.failedCount).toBe(0);
    expect(refundTable.update).not.toHaveBeenCalled();
    expect(mockPage).toHaveBeenCalledWith(
      expect.stringContaining("Ambiguous"),
      expect.objectContaining({ tags: { feature: "refund-reconcile" } }),
    );
  });
});

describe("reconcilePendingRefunds real-id PENDING polling", () => {
  test("polls getRefund and settles a lost-webhook confirmation", async () => {
    refundTable.findMany
      .mockResolvedValueOnce([]) // no placeholders
      .mockResolvedValueOnce([
        {
          id: "row_9",
          refundId: "rfnd_real",
          status: "PENDING",
          amountPaise: 10_000,
          createdAt: new Date(Date.now() - 3 * HOUR),
          payment: { paymentGateway: "RAZORPAY" },
        },
      ]);
    mockGet.mockResolvedValueOnce({
      refundId: "rfnd_real",
      amount: 10_000,
      currency: "INR",
      status: "SUCCEEDED", // mapper output, not the raw gateway string
      metadata: undefined,
    });

    const result = await reconcilePendingRefunds();

    expect(mockGet).toHaveBeenCalledWith("rfnd_real", "RAZORPAY");
    expect(result.reconciledCount).toBe(1);
    expect(refundTable.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "row_9" },
        data: expect.objectContaining({ status: "SUCCEEDED" }),
      }),
    );
  });

  test("a still-settling real-id refund is never aged out locally", async () => {
    refundTable.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "row_9",
          refundId: "rfnd_real",
          status: "PENDING",
          amountPaise: 10_000,
          createdAt: new Date(Date.now() - 72 * HOUR), // 3 days old
          payment: { paymentGateway: "RAZORPAY" },
        },
      ]);
    mockGet.mockResolvedValueOnce({
      refundId: "rfnd_real",
      amount: 10_000,
      currency: "INR",
      status: "PENDING", // normal-speed refunds take 5–7 business days
      metadata: undefined,
    });

    const result = await reconcilePendingRefunds();

    expect(result.failedCount).toBe(0);
    expect(refundTable.update).not.toHaveBeenCalled();
  });

  // #1458 — with STRIPE_ENABLED unset, the Stripe client is never built, so
  // getRefund threw for every Stripe row, the error list filled up and the whole
  // run reported success:false — the cleanup route answered 500 for what is
  // deliberate configuration.
  test("a fenced STRIPE refund is skipped and counted, not failed", async () => {
    const previous = process.env.STRIPE_ENABLED;
    delete process.env.STRIPE_ENABLED;
    try {
      refundTable.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          id: "row_stripe",
          refundId: "re_real",
          status: "PENDING",
          amountPaise: 10_000,
          createdAt: new Date(Date.now() - 3 * HOUR),
          payment: { paymentGateway: "STRIPE" },
        },
      ]);

      const result = await reconcilePendingRefunds();

      expect(mockGet).not.toHaveBeenCalled();
      expect(result.skippedFenced).toBe(1);
      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.STRIPE_ENABLED;
      else process.env.STRIPE_ENABLED = previous;
    }
  });
});
