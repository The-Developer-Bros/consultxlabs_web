/**
 * @jest-environment node
 */

/**
 * #1424 — the tentative-clear sweep of `reconcile-slot-availability` reads a
 * cohort of tentative slots whose payment succeeded and then stamps them
 * confirmed. The write used to be scoped by `id IN (...)` alone, so it did not
 * care whether a row was still in the cohort. A partial reschedule releases a
 * slot as `isTentative=true` / `completionStatus=RESCHEDULED` while leaving the
 * parent APPROVED, which the sweep's parent-status guard does not see; a slot
 * that moved that way between the read and the write was stamped confirmed and
 * blocked the consultant's calendar for a session nobody would ever deliver.
 * ADR 21: a sweep repeats its own predicate in the WHERE it writes with.
 */

jest.mock("../../lib/prisma", () => {
  const db: Record<string, unknown> = {
    slotOfAppointment: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    subscription: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    class: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    appointment: { findMany: jest.fn().mockResolvedValue([]) },
    slotOfAvailabilityWeekly: { groupBy: jest.fn().mockResolvedValue([]) },
    slotOfAvailabilityCustom: { groupBy: jest.fn().mockResolvedValue([]) },
    $disconnect: jest.fn(),
  };
  return { __esModule: true, default: db };
});

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  LONG_JOB_TTL_MS: 1,
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
}));

// The allocator is out of scope here and drags Novu/undici into the graph.
jest.mock("../../utils/slotAllocation/SlotAllocationService", () => ({
  __esModule: true,
  SlotAllocationService: { allocate: jest.fn() },
}));
jest.mock("../../utils/slotAllocation/SlotCalculationService", () => ({
  __esModule: true,
  SlotCalculationService: {
    getSlotsPerCall: jest.fn().mockReturnValue(1),
    calculateRequiredSlots: jest.fn().mockReturnValue(1),
  },
}));

import prisma from "../../lib/prisma";
import { reconcileSlotAvailability } from "../../scripts/appointments/reconcile-slot-availability";
import { SlotCompletionStatus } from "@prisma/client";

describe("reconcile-slot-availability × tentative-clear race (#1424)", () => {
  it("skips a slot whose completion status changed after the cohort read", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    // Two slots read; one is moved to RESCHEDULED by a partial reschedule
    // before the write lands, so the CAS matches only the other.
    (prisma.slotOfAppointment.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: "slot-live",
        appointmentId: "apt-1",
        startsAt: new Date("2026-10-01T10:00:00Z"),
        endsAt: new Date("2026-10-01T10:30:00Z"),
      },
      {
        id: "slot-rescheduled",
        appointmentId: "apt-2",
        startsAt: new Date("2026-10-01T11:00:00Z"),
        endsAt: new Date("2026-10-01T11:30:00Z"),
      },
    ]);
    (prisma.slotOfAppointment.updateMany as jest.Mock).mockResolvedValue({
      count: 1,
    });

    const result = await reconcileSlotAvailability();

    const write = (prisma.slotOfAppointment.updateMany as jest.Mock).mock
      .calls[0][0];
    expect(write.data).toEqual({ isTentative: false });
    expect(write.where.id).toEqual({
      in: ["slot-live", "slot-rescheduled"],
    });
    // The cohort predicate is repeated at write time, so a row that left the
    // cohort cannot be stamped confirmed by its id alone.
    expect(write.where.isTentative).toBe(true);
    expect(write.where.deletedAt).toBeNull();
    expect(write.where.completionStatus.in).not.toContain(
      SlotCompletionStatus.RESCHEDULED,
    );
    expect(write.where.completionStatus.in).not.toContain(
      SlotCompletionStatus.CANCELLED,
    );
    expect(write.where.completionStatus.in).toContain(
      SlotCompletionStatus.SCHEDULED,
    );

    // Only the row the write actually matched is counted, and the shortfall is
    // logged rather than swallowed.
    expect(result.tentativeFlagsCleared).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("reconcile_tentative_clear_raced"),
    );
    warn.mockRestore();
  });
});
