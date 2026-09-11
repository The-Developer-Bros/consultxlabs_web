/**
 * @jest-environment node
 */

/**
 * PM-15 (part 1 — reconciler delegation) — the stuck-payout reconciler must
 * record a gateway-confirmed payout through the canonical handlePayoutWebhook,
 * NOT a bare inline `status=COMPLETED` + `earnings PAID` flip. The old inline
 * path skipped TDS recording, the payout ledger postings (revenue/payable
 * counters), and the UTR.
 *
 * Here we mock handlePayoutWebhook (the same boundary every other webhook test
 * uses — the index drags in the Stream ESM graph that Jest can't transform) and
 * assert the reconciler DELEGATES with the mapped status and never performs the
 * bare flip. The money recording inside handlePayoutWebhook (TDS + ledger) is
 * pinned separately in stuck-payouts-money-handler.test.ts, which drives the
 * REAL handler.
 */

const handlePayoutWebhook = jest.fn().mockResolvedValue(undefined);

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  withCronLock: (_name: string, _opts: unknown, fn: () => unknown) => fn(),
  LONG_JOB_TTL_MS: 1000,
  CronLockHeldError: class extends Error {},
  CronLockUnavailableError: class extends Error {},
}));

jest.mock("../../lib/payments/payouts", () => ({
  __esModule: true,
  handlePayoutWebhook: (...a: unknown[]) => handlePayoutWebhook(...a),
}));

type Row = Record<string, unknown>;

const STUCK_PAYOUT: Row = {
  id: "po_stuck_1",
  consultantProfileId: "cprof_1",
  provider: "RAZORPAY",
  providerPayoutId: "pout_live_1",
  amount: 100000,
  currency: "INR",
  status: "PROCESSING",
  retryCount: 0,
  updatedAt: new Date(0),
  consultantProfile: { user: { name: "Asha", email: "asha@x.com" } },
};

let payoutRow: Row;

// `var` (not let/const): the hoisted jest.mock factory runs before this
// declaration line, and only `var` is initialized (to undefined) at hoist time
// — a let/const would still be in its TDZ when the factory assigns to it.
// eslint-disable-next-line no-var
var prismaStub: {
  consultantPayout: {
    findMany: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  consultantEarnings: { updateMany: jest.Mock };
  $disconnect: jest.Mock;
};

jest.mock("../../lib/prisma", () => {
  prismaStub = {
    consultantPayout: {
      findMany: jest.fn(async () => [payoutRow]),
      update: jest.fn(async ({ data }: { data: Row }) => {
        Object.assign(payoutRow, data);
        return payoutRow;
      }),
      // #1407 — the retry reset is a CAS updateMany now; the count is what
      // each test decides the race produced.
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    consultantEarnings: {
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    $disconnect: jest.fn(async () => {}),
  };
  return { __esModule: true, default: prismaStub };
});

import { handleStuckPayouts } from "../../scripts/payouts/handle-stuck-payouts";

beforeEach(() => {
  jest.clearAllMocks();
  payoutRow = { ...STUCK_PAYOUT };
  process.env.RAZORPAY_KEY_ID = "k";
  process.env.RAZORPAY_SECRET = "s";
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ status: "processed", utr: "UTR1234567890" }),
  });
});

describe("PM-15 — stuck-payout reconcile delegates to handlePayoutWebhook", () => {
  it("processed payout → delegates COMPLETED to handlePayoutWebhook, not a bare status flip", async () => {
    const result = await handleStuckPayouts();

    expect(result.reconciledCount).toBe(1);

    // Delegated to the canonical engine with the mapped status, gateway id, and
    // the bank UTR (so the handler persists it on the COMPLETED branch).
    expect(handlePayoutWebhook).toHaveBeenCalledTimes(1);
    expect(handlePayoutWebhook).toHaveBeenCalledWith(
      "RAZORPAY",
      "pout_live_1",
      "COMPLETED",
      undefined,
      "UTR1234567890",
    );

    // The OLD inline money flip must be gone: no direct COMPLETED status write
    // and no direct earnings→PAID write on the reconciler.
    const directCompletedFlip = prismaStub.consultantPayout.update.mock.calls.some(
      ([arg]: [{ data?: Row }]) => arg?.data?.status === "COMPLETED",
    );
    expect(directCompletedFlip).toBe(false);
    const directEarningsPaid = prismaStub.consultantEarnings.updateMany.mock.calls.some(
      ([arg]: [{ data?: Row }]) => arg?.data?.status === "PAID",
    );
    expect(directEarningsPaid).toBe(false);
  });

  it("failed payout → delegates FAILED with the failure reason", async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "reversed", failure_reason: "bounced" }),
    });

    await handleStuckPayouts();

    // Razorpay `reversed` maps to FAILED; the reconciler delegates the unlink +
    // TDS-reversal to the canonical handler instead of leaving earnings linked.
    // No UTR on a non-completing payout, so the trailing arg is undefined.
    expect(handlePayoutWebhook).toHaveBeenCalledWith(
      "RAZORPAY",
      "pout_live_1",
      "FAILED",
      "bounced",
      undefined,
    );
  });

  // #1407 — RazorpayX `failed` (bank refused a queued payout) had no arm here
  // while Stripe's did, so the payout fell through as an unknown status and was
  // skipped: PROCESSING forever, earnings still linked to money that never left.
  it("gateway `failed` → delegates FAILED, not skipped as an unknown status", async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "failed", failure_reason: "account closed" }),
    });

    const result = await handleStuckPayouts();

    expect(handlePayoutWebhook).toHaveBeenCalledWith(
      "RAZORPAY",
      "pout_live_1",
      "FAILED",
      "account closed",
      undefined,
    );
    expect(result.skippedCount).toBe(0);
  });

  it("still-processing payout → no delegation (status unchanged)", async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "processing" }),
    });

    await handleStuckPayouts();

    expect(handlePayoutWebhook).not.toHaveBeenCalled();
  });
});

/**
 * #1407 — the retry reset must be a CAS. The cohort is read once and each
 * payout then costs a gateway round-trip, so a concurrent process-payouts run
 * or a payout webhook can move a row while this job is out. A bare `update`
 * stamped it back to APPROVED and the next batch paid it twice.
 */
describe("#1407 — retry reset loses the CAS", () => {
  it("count 0 → no second payout is armed and the row is reported skipped", async () => {
    // Never reached the gateway, so this is the retry branch.
    payoutRow = { ...STUCK_PAYOUT, providerPayoutId: null, retryCount: 0 };
    prismaStub.consultantPayout.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await handleStuckPayouts();

    expect(prismaStub.consultantPayout.updateMany).toHaveBeenCalledWith({
      where: {
        id: "po_stuck_1",
        status: "PROCESSING",
        providerPayoutId: null,
      },
      data: { status: "APPROVED", retryCount: { increment: 1 } },
    });
    // Not re-armed for a second disbursement, and no bare write behind the CAS.
    expect(result.retriedCount).toBe(0);
    expect(payoutRow.status).toBe("PROCESSING");
    expect(prismaStub.consultantPayout.update).not.toHaveBeenCalled();
    expect(result.skippedCount).toBe(1);
  });

  it("count 1 → the winner re-arms once and the increment rides the CAS", async () => {
    payoutRow = { ...STUCK_PAYOUT, providerPayoutId: null, retryCount: 0 };
    prismaStub.consultantPayout.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await handleStuckPayouts();

    // Exactly one reset attempt for the one stuck row, and the retryCount bump
    // is part of the same guarded write rather than a follow-up update.
    expect(prismaStub.consultantPayout.updateMany).toHaveBeenCalledTimes(1);
    expect(result.retriedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(prismaStub.consultantPayout.update).not.toHaveBeenCalled();
  });
});
