/**
 * @jest-environment node
 */

/**
 * #1319 — earnings that could never be accrued, and nobody was told.
 *
 * Settlement for an org-funded checkout runs after the checkout transaction
 * commits; a failure there is recorded and stepped past. `syncPaymentEarnings`
 * is the only thing that repairs the result, and it looked back thirty days —
 * so a payment that stayed unaccrued for a month left the cohort silently and
 * the consultant was simply never paid for a session they had already
 * delivered. Meanwhile a payment the sweep could NOT heal (a booking that
 * resolves no consultant at all) was re-read on every run and skipped with a
 * `console.warn`, forever, which is not an alert.
 *
 * These tests pin the three behaviours that fixes that: the cohort ignores the
 * thirty-day boundary, an unhealable payment pages exactly once a day, and a
 * healable one still accrues.
 */

const mockPaymentFindMany = jest.fn();
const mockConsultantEarningsFindMany = jest.fn();
const mockSystemEventFindMany = jest.fn();
const mockCreateEarningsFromPayment = jest.fn();
const mockRecordSystemError = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findMany: (...a: unknown[]) => mockPaymentFindMany(...a) },
    consultantEarnings: {
      findMany: (...a: unknown[]) => mockConsultantEarningsFindMany(...a),
    },
    systemEvent: {
      findMany: (...a: unknown[]) => mockSystemEventFindMany(...a),
    },
    $disconnect: jest.fn(),
  },
}));

jest.mock("../../lib/payments/payouts/earnings-service", () => ({
  createEarningsFromPayment: (...a: unknown[]) =>
    mockCreateEarningsFromPayment(...a),
}));

jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: (...a: unknown[]) => mockRecordSystemError(...a),
}));

// The lock is mutual exclusion, not correctness (#476/ADR 13); the sweep's
// behaviour is what is under test.
jest.mock("../../lib/cron/with-cron-lock", () => ({
  LONG_JOB_TTL_MS: 1,
  withCronLock: (_name: string, _opts: unknown, fn: () => Promise<unknown>) =>
    fn(),
}));

import { syncPaymentEarnings } from "@/scripts/earnings/sync-payment-earnings";

const DAY = 24 * 60 * 60 * 1000;
const CONSULTANT_PROFILE = "cp-1";

/** A SUCCEEDED payment on a consultation whose plan names a consultant. */
function healablePayment(id: string, ageDays: number) {
  return {
    id,
    amount: BigInt(500_000),
    originalAmount: 500_000,
    appointmentId: `appt-${id}`,
    organizationId: null,
    createdAt: new Date(Date.now() - ageDays * DAY),
    appointment: {
      appointmentType: "CONSULTATION",
      consultation: {
        consultationPlan: { consultantProfileId: CONSULTANT_PROFILE },
      },
      subscription: null,
      webinar: null,
      class: null,
    },
  };
}

/** A booking that exists but names nobody who could be paid for it. */
function unaccruablePayment(id: string, ageDays: number) {
  const p = healablePayment(id, ageDays);
  return {
    ...p,
    appointment: { ...p.appointment, consultation: null },
  };
}

/** A payment with no booking at all — the orphaned-payment alerter's beat. */
function orphanPayment(id: string, ageDays: number) {
  const p = healablePayment(id, ageDays);
  return { ...p, appointmentId: null, appointment: null };
}

/** Answer the cursor-paginated scan with one page, then nothing. */
function servePayments(rows: unknown[]) {
  let served = false;
  mockPaymentFindMany.mockImplementation(async () => {
    if (served) return [];
    served = true;
    return rows;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConsultantEarningsFindMany.mockResolvedValue([]);
  mockSystemEventFindMany.mockResolvedValue([]);
  mockRecordSystemError.mockResolvedValue(undefined);
  mockCreateEarningsFromPayment.mockResolvedValue("earn-1");
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("the cohort has no age window", () => {
  it("asks for every unaccrued SUCCEEDED payment, not the last thirty days", async () => {
    servePayments([]);

    await syncPaymentEarnings();

    const where = mockPaymentFindMany.mock.calls[0][0].where;
    expect(where).toEqual({
      paymentStatus: "SUCCEEDED",
      earnings: { none: {} },
    });
    // The thirty-day floor is the bug; its absence is the fix.
    expect(where.createdAt).toBeUndefined();
  });

  it("heals a payment nine months past the old boundary", async () => {
    servePayments([healablePayment("pay-old", 270)]);

    const result = await syncPaymentEarnings();

    expect(result.createdCount).toBe(1);
    expect(mockCreateEarningsFromPayment).toHaveBeenCalledWith(
      expect.objectContaining({ appointmentType: "CONSULTATION" }),
    );
    // Nothing to escalate: the sweep did its job.
    expect(result.pagedCount).toBe(0);
    expect(mockRecordSystemError).not.toHaveBeenCalled();
  });

  it("takes the oldest first and caps the run", async () => {
    servePayments([]);

    await syncPaymentEarnings();

    const args = mockPaymentFindMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
    expect(args.take).toBeLessThanOrEqual(500);
  });

  it("stops at the per-run ceiling instead of scanning forever", async () => {
    // Every page comes back full, so only the ceiling can end the loop.
    mockPaymentFindMany.mockImplementation(async (args: { take: number }) =>
      Array.from({ length: args.take }, (_, i) =>
        healablePayment(`pay-${Math.random()}-${i}`, 400),
      ),
    );

    const result = await syncPaymentEarnings();

    expect(result.totalProcessed).toBe(500);
  });
});

describe("a payment nobody can ever be paid for gets escalated", () => {
  it("pages once, with the payment id as the day's dedupe key", async () => {
    servePayments([unaccruablePayment("pay-stuck", 5)]);

    const result = await syncPaymentEarnings();

    expect(result.pagedCount).toBe(1);
    expect(mockRecordSystemError).toHaveBeenCalledTimes(1);

    const call = mockRecordSystemError.mock.calls[0][0];
    expect(call.category).toBe("PAYMENT");
    expect(call.correlationId).toMatch(/^earnings-unaccrued:pay-stuck:\d{4}-/);
    expect(call.context).toEqual(
      expect.objectContaining({
        paymentId: "pay-stuck",
        appointmentId: "appt-pay-stuck",
      }),
    );
    expect(String(call.err)).toContain("EARNINGS_UNACCRUABLE_NO_CONSULTANT");

    // And it did not pretend to heal it.
    expect(mockCreateEarningsFromPayment).not.toHaveBeenCalled();
    expect(result.skippedCount).toBe(1);
  });

  it("stays quiet when today's alert already exists", async () => {
    servePayments([unaccruablePayment("pay-stuck", 5)]);
    mockSystemEventFindMany.mockImplementation(
      async (args: { where: { correlationId: { in: string[] } } }) =>
        args.where.correlationId.in.map((correlationId) => ({
          correlationId,
        })),
    );

    const result = await syncPaymentEarnings();

    expect(result.pagedCount).toBe(0);
    expect(mockRecordSystemError).not.toHaveBeenCalled();
  });

  it("checks the whole batch's keys in one read", async () => {
    servePayments([
      unaccruablePayment("stuck-a", 5),
      unaccruablePayment("stuck-b", 90),
      unaccruablePayment("stuck-c", 400),
    ]);

    const result = await syncPaymentEarnings();

    expect(result.pagedCount).toBe(3);
    expect(mockSystemEventFindMany).toHaveBeenCalledTimes(1);
    expect(
      mockSystemEventFindMany.mock.calls[0][0].where.correlationId.in,
    ).toHaveLength(3);
  });

  it("leaves a payment younger than a day alone", async () => {
    // Settlement runs after the checkout transaction commits, so a fresh
    // payment with no earnings may simply still be in flight.
    servePayments([unaccruablePayment("pay-fresh", 0)]);

    const result = await syncPaymentEarnings();

    expect(result.pagedCount).toBe(0);
    expect(mockSystemEventFindMany).not.toHaveBeenCalled();
    expect(result.skippedCount).toBe(1);
  });

  it("does not page a payment with no booking at all", async () => {
    // That cohort is `alert-orphaned-payments`', and it legitimately contains
    // the `appointmentId: null` overage side-charge, which never accrues.
    servePayments([orphanPayment("pay-orphan", 400)]);

    const result = await syncPaymentEarnings();

    expect(result.pagedCount).toBe(0);
    expect(mockRecordSystemError).not.toHaveBeenCalled();
    expect(result.skippedCount).toBe(1);
  });
});

describe("the healed case still accrues", () => {
  it("creates earnings and reports them", async () => {
    servePayments([healablePayment("pay-1", 2), healablePayment("pay-2", 40)]);

    const result = await syncPaymentEarnings();

    expect(result.createdCount).toBe(2);
    expect(result.errorCount).toBe(0);
    expect(result.success).toBe(true);
    expect(mockCreateEarningsFromPayment).toHaveBeenCalledTimes(2);
    expect(
      mockCreateEarningsFromPayment.mock.calls[0][0].payment.appointment
        .consultantProfile,
    ).toEqual({ id: CONSULTANT_PROFILE });
  });

  it("skips a payment that already grew earnings between the read and now", async () => {
    servePayments([healablePayment("pay-raced", 10)]);
    mockConsultantEarningsFindMany.mockResolvedValue([
      { paymentId: "pay-raced" },
    ]);

    const result = await syncPaymentEarnings();

    expect(result.createdCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(mockCreateEarningsFromPayment).not.toHaveBeenCalled();
  });
});
