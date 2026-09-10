/**
 * @jest-environment node
 */

/**
 * #785 (task #10) — B5 stuck-webhook sweeper. Re-drives WebhookEvent rows left
 * processed=false after an after()-callback crash, reconstructing the envelope
 * the per-event schemas require (entity/account_id/contains/created_at) and
 * routing through the real dispatch. Pins the loop + reconstruction + the
 * success/fail/throw accounting.
 */

// Factories create the jest.fn()s inline (retrieved via the mocked modules
// below) — referencing outer consts here would hit import-hoisting init order.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    webhookEvent: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      // claim CAS before each re-drive
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  },
}));
jest.mock("../../app/api/webhooks/razorpay-dispatch", () => ({
  processRazorpayWebhookEvent: jest.fn(),
}));

// #476 — the sweep cores are now wrapped in withCronLock; pass through so
// these unit tests exercise the sweep logic, not the lock (covered in
// with-cron-lock.test.ts).
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: jest.fn((_job: string, _opts: unknown, fn: () => unknown) =>
    fn(),
  ),
  CronLockHeldError: class CronLockHeldError extends Error {},
  CronLockUnavailableError: class CronLockUnavailableError extends Error {},
  LONG_JOB_TTL_MS: 35 * 60 * 1000,
}));

import prisma from "../../lib/prisma";
import { processRazorpayWebhookEvent } from "../../app/api/webhooks/razorpay-dispatch";
import { sweepStuckWebhookEvents } from "../../scripts/cleanup/sweep-stuck-webhook-events";

const mockWe = (
  prisma as unknown as {
    webhookEvent: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      // #1205-triage — the sweeper's claim CAS before each re-drive.
      updateMany: jest.Mock;
    };
  }
).webhookEvent;
const mockProcess = processRazorpayWebhookEvent as jest.Mock;

const stuckRow = (over: Record<string, unknown> = {}) => ({
  eventId: "payment.captured:pay_1",
  eventType: "payment.captured",
  payload: { payment: { entity: { id: "pay_1" } } },
  receivedAt: new Date("2026-06-01T00:00:00Z"),
  claimedAt: null as Date | null | undefined,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockWe.update.mockResolvedValue({});
});

describe("sweepStuckWebhookEvents (#785)", () => {
  it("a LOST claim (claimedAt raced) skips the re-drive entirely (#1205-triage)", async () => {
    const ev = stuckRow();
    (mockWe.findMany as jest.Mock).mockResolvedValue([ev]);
    // Another driver claimed between selection and claim: CAS misses.
    (mockWe.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    const result = await sweepStuckWebhookEvents({ staleMinutes: 6 });

    expect(processRazorpayWebhookEvent).not.toHaveBeenCalled();
    expect(result.recovered).toBe(0);
  });

  it("the claim CAS keys on claimedAt, not receivedAt (age must survive re-drives)", async () => {
    const ev = stuckRow();
    (mockWe.findMany as jest.Mock).mockResolvedValue([ev]);
    (mockWe.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    await sweepStuckWebhookEvents({ staleMinutes: 6 });

    const [claim] = (mockWe.updateMany as jest.Mock).mock.calls;
    expect(claim[0].where).toMatchObject({
      eventId: ev.eventId,
      OR: [{ claimedAt: null }, { claimedAt: ev.claimedAt }],
    });
    expect(claim[0].data.claimedAt).toBeInstanceOf(Date);
    // receivedAt untouched — the give-up cap ages on it.
    expect(claim[0].where.receivedAt).toBeUndefined();
    expect(claim[0].data.receivedAt).toBeUndefined();
  });

  it("re-drives a stuck event and reconstructs the full envelope", async () => {
    mockWe.findMany.mockResolvedValue([stuckRow()]);
    mockProcess.mockResolvedValue(undefined);
    mockWe.findUnique.mockResolvedValue({ error: null, processed: true });

    const r = await sweepStuckWebhookEvents({ staleMinutes: 6 });

    expect(r).toMatchObject({ scanned: 1, recovered: 1, stillFailing: 0 });

    // Razorpay only, and BOTH stuck shapes.
    //
    // The selector used to be `processed: false, error: null` — "crashed before
    // we recorded anything". That silently excluded every handler that failed
    // loudly: markWebhookEventProcessed stamps `processed=true, error!=null` in
    // the dispatch's finally, Razorpay already got its 200 and will not
    // redeliver, so nothing on earth re-drove those rows. A transient failure
    // inside handleRefundCreated meant the gateway had refunded the customer
    // and the platform kept no record of it at all.
    const where = mockWe.findMany.mock.calls[0][0].where;
    // #1134 P1-2 — Stream joined the sweep. Its route acknowledges before
    // processing (a 15-second total retry budget that a cold instance cannot
    // fit), so a failed Stream handler has no redelivery to rescue it and this
    // is the only thing that will re-drive it.
    expect(where).toMatchObject({ provider: { in: ["razorpay", "stream"] } });
    expect(where.OR).toEqual([
      { processed: false, error: null },
      expect.objectContaining({ error: { not: null } }),
    ]);
    // The errored branch is age-bounded so a deterministically-failing row
    // retries for a week and then stops rather than churning forever.
    expect(where.OR[1].receivedAt).toHaveProperty("gte");
    // envelope reconstruction supplies the fields the schemas demand
    const [env, evType, evId] = mockProcess.mock.calls[0];
    expect(env).toMatchObject({
      entity: "event",
      event: "payment.captured",
      contains: ["payment"], // top-level payload keys
      payload: { payment: { entity: { id: "pay_1" } } },
    });
    expect(typeof env.account_id).toBe("string");
    expect(typeof env.created_at).toBe("number");
    expect(evType).toBe("payment.captured");
    expect(evId).toBe("payment.captured:pay_1");
  });

  it("a re-drive that still errors counts as stillFailing, not recovered", async () => {
    mockWe.findMany.mockResolvedValue([stuckRow()]);
    mockProcess.mockResolvedValue(undefined);
    mockWe.findUnique.mockResolvedValue({
      error: "handler boom",
      processed: true,
    });

    const r = await sweepStuckWebhookEvents({ staleMinutes: 6 });

    expect(r.recovered).toBe(0);
    expect(r.stillFailing).toBe(1);
    expect(r.errors[0]).toContain("handler boom");
  });

  it("a throw mid-dispatch is caught + the row force-marked (never re-swept forever)", async () => {
    mockWe.findMany.mockResolvedValue([stuckRow()]);
    mockProcess.mockRejectedValue(new Error("kaboom"));

    const r = await sweepStuckWebhookEvents({ staleMinutes: 6 });

    expect(r.stillFailing).toBe(1);
    expect(mockWe.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventId: "payment.captured:pay_1" },
        data: expect.objectContaining({ processed: true }),
      }),
    );
  });

  it("empty scan → no-op", async () => {
    mockWe.findMany.mockResolvedValue([]);
    const r = await sweepStuckWebhookEvents();
    expect(r).toMatchObject({ scanned: 0, recovered: 0, stillFailing: 0 });
    expect(mockProcess).not.toHaveBeenCalled();
  });

  // #813 — a defer-sentinel handler (refund-before-capture) leaves the row in
  // the same processed=false/error=null signature it started with. The sweeper
  // must NOT count that as recovered, and must NOT terminally mark it until it
  // ages past the give-up cap.
  it("a re-drive that stays deferred is counted as deferred, not recovered", async () => {
    const recent = new Date(Date.now() - 60 * 60_000); // 1h old, under the cap
    mockWe.findMany.mockResolvedValue([
      stuckRow({ eventId: "refund.created:rfnd_1", receivedAt: recent }),
    ]);
    mockProcess.mockResolvedValue(undefined);
    // dispatch deferred → it skipped the mark, row unchanged
    mockWe.findUnique.mockResolvedValue({ error: null, processed: false });

    const r = await sweepStuckWebhookEvents({ staleMinutes: 6 });

    expect(r).toMatchObject({
      scanned: 1,
      recovered: 0,
      stillFailing: 0,
      deferred: 1,
      gaveUp: 0,
    });
    expect(mockWe.update).not.toHaveBeenCalled();
  });

  it("a deferred event past the give-up cap is terminally marked + counted", async () => {
    const old = new Date(Date.now() - 200 * 60 * 60_000); // 200h > 168h cap
    mockWe.findMany.mockResolvedValue([
      stuckRow({ eventId: "refund.created:rfnd_2", receivedAt: old }),
    ]);
    mockProcess.mockResolvedValue(undefined);
    mockWe.findUnique.mockResolvedValue({ error: null, processed: false });

    const r = await sweepStuckWebhookEvents({ staleMinutes: 6 });

    expect(r).toMatchObject({ deferred: 0, gaveUp: 1, recovered: 0 });
    expect(mockWe.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventId: "refund.created:rfnd_2" },
        data: expect.objectContaining({
          processed: true,
          error: "gave up: payment never arrived",
        }),
      }),
    );
    expect(r.errors[0]).toContain("gave up");
  });
});
