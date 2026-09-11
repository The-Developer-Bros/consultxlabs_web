/**
 * @jest-environment node
 */

/**
 * #829 — the tentative-slot cleanup must never release a slot that was
 * confirmed (or paid) between its scan and its write. The CAS WHERE re-states
 * isTentative + no-SUCCEEDED-payment, so a concurrent capture webhook's flip
 * makes the row stop matching (re-evaluated under the row lock) instead of
 * being released. The release itself is a soft cancel, so the row survives.
 */

jest.mock("../../lib/prisma", () => {
  const client: Record<string, unknown> = {
    slotOfAppointment: {
      findMany: jest.fn(),
      updateManyAndReturn: jest.fn().mockResolvedValue([]),
    },
    bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
    $disconnect: jest.fn(),
  };
  // #1319 wave 6 — the release runs inside $transaction so the tombstone and
  // its history rows land together; the callback gets the same mocked client.
  client.$transaction = jest.fn((arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: unknown) => unknown)(client)
      : Promise.all(arg as Promise<unknown>[]),
  );
  return { __esModule: true, default: client };
});
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: jest.fn((_j: string, _o: unknown, fn: () => unknown) => fn()),
  CronLockHeldError: class CronLockHeldError extends Error {},
  CronLockUnavailableError: class CronLockUnavailableError extends Error {},
  LONG_JOB_TTL_MS: 35 * 60 * 1000,
}));

import prisma from "../../lib/prisma";
import { cleanupTentativeSlots } from "@/scripts/appointments/cleanup-tentative-slots";

const mocked = prisma as unknown as {
  slotOfAppointment: { findMany: jest.Mock; updateManyAndReturn: jest.Mock };
};

const STALE_SLOT = {
  id: "slot-1",
  appointmentId: "appt-1",
  completionStatus: "SCHEDULED",
  createdAt: new Date("2026-05-01T00:00:00Z"),
  updatedAt: new Date("2026-05-01T00:00:00Z"),
  startsAt: new Date("2026-05-02T10:00:00Z"),
  endsAt: new Date("2026-05-02T11:00:00Z"),
  appointment: { payment: [], consultation: null, subscription: null },
};

beforeEach(() => jest.clearAllMocks());

describe("#829 — cleanup release re-states the tentative + unpaid guards", () => {
  it("carries isTentative + no-SUCCEEDED-payment in the CAS WHERE", async () => {
    mocked.slotOfAppointment.findMany.mockResolvedValue([STALE_SLOT]);
    mocked.slotOfAppointment.updateManyAndReturn.mockResolvedValue([
      { id: "slot-1" },
    ]);

    const result = await cleanupTentativeSlots();

    expect(result.slotsReleased).toBe(1);
    expect(mocked.slotOfAppointment.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["slot-1"] },
          isTentative: true,
          deletedAt: null,
          // The parent-status guards ride alongside (wave 6); the money
          // predicate is what this pin protects.
          appointment: expect.objectContaining({
            payment: { none: { paymentStatus: "SUCCEEDED" } },
          }),
          // The from-set is the optimistic lock. UNVERIFIED belongs in it:
          // auto-complete stamps a past SCHEDULED slot UNVERIFIED without
          // excluding tentative rows, so most 24h-old holds are already
          // there. COMPLETED stays out — a session that happened is not a
          // stale hold.
          completionStatus: { in: ["SCHEDULED", "UNVERIFIED", "RESCHEDULED"] },
        }),
        data: expect.objectContaining({ completionStatus: "CANCELLED" }),
      }),
    );
    // Freed by status, with the row left behind for support.
    const [{ data }] =
      mocked.slotOfAppointment.updateManyAndReturn.mock.calls[0];
    expect(data.deletedAt).toBeInstanceOf(Date);
  });

  it("excludes already-released rows from the cohort read", async () => {
    // Without this the sweep re-collects its own soft-cancelled rows every
    // run and a backlog fills the per-run cap with dead slots forever.
    mocked.slotOfAppointment.findMany.mockResolvedValue([]);
    await cleanupTentativeSlots();

    const [cohortRead] = mocked.slotOfAppointment.findMany.mock.calls[0];
    expect(cohortRead.where).toEqual(
      expect.objectContaining({ isTentative: true, deletedAt: null }),
    );
  });

  it("releases nothing when the scan finds nothing", async () => {
    mocked.slotOfAppointment.findMany.mockResolvedValue([]);
    await cleanupTentativeSlots();
    expect(mocked.slotOfAppointment.updateManyAndReturn).not.toHaveBeenCalled();
  });
});
