/**
 * @jest-environment node
 */

/**
 * #1319 — the two lifecycles that had no CAS helper: SlotOfAppointment
 * completion and TrialSession status. The maps are pinned exactly so a silent
 * widening (e.g. letting COMPLETED come from CANCELLED) fails review here.
 */

import {
  SLOT_COMPLETION_ALLOWED_FROM,
  TRIAL_ALLOWED_FROM,
  transitionSlotCompletion,
  transitionTrialSession,
} from "../../lib/booking/transitions";
import { IllegalTransitionError } from "../../lib/enterprise/transitions";

type SlotTx = Parameters<typeof transitionSlotCompletion>[0];
type TrialTx = Parameters<typeof transitionTrialSession>[0];

// #1319 A12 — both helpers pre-read the from-status and append one
// BookingStatusHistory row per moved row, so the mock tx carries the read and
// the history delegate as well as the CAS itself. The slot CAS is
// updateManyAndReturn: the ids it returns are the only ids that get history.
function slotTx(count: number, from: string = "SCHEDULED") {
  const ids = Array.from({ length: count }, (_, i) => ({
    id: `slot_${i + 1}`,
    appointmentId: "apt_1",
  }));
  const updateManyAndReturn = jest.fn().mockResolvedValue(ids);
  const findMany = jest
    .fn()
    .mockResolvedValue(ids.map(({ id }) => ({ id, completionStatus: from })));
  const create = jest.fn().mockResolvedValue({});
  return {
    tx: {
      slotOfAppointment: { updateManyAndReturn, findMany },
      bookingStatusHistory: { create },
    } as unknown as SlotTx,
    updateManyAndReturn,
    findMany,
    create,
  };
}

function trialTx(count: number, from: string = "SCHEDULED") {
  const updateMany = jest.fn().mockResolvedValue({ count });
  const findUnique = jest.fn().mockResolvedValue({ status: from });
  const create = jest.fn().mockResolvedValue({});
  return {
    tx: {
      trialSession: { updateMany, findUnique },
      bookingStatusHistory: { create },
    } as unknown as TrialTx,
    updateMany,
    findUnique,
    create,
  };
}

describe("SLOT_COMPLETION_ALLOWED_FROM", () => {
  it("pins every edge", () => {
    expect(SLOT_COMPLETION_ALLOWED_FROM).toEqual({
      SCHEDULED: ["RESCHEDULED"],
      COMPLETED: ["SCHEDULED", "UNVERIFIED"],
      UNVERIFIED: ["SCHEDULED", "COMPLETED"],
      CANCELLED: ["SCHEDULED", "UNVERIFIED", "RESCHEDULED"],
      RESCHEDULED: ["SCHEDULED", "RESCHEDULED"],
    });
  });

  it("a late Stream webhook cannot resurrect a cancelled slot", () => {
    expect(SLOT_COMPLETION_ALLOWED_FROM.COMPLETED).not.toContain("CANCELLED");
    expect(SLOT_COMPLETION_ALLOWED_FROM.UNVERIFIED).not.toContain("CANCELLED");
  });
});

describe("transitionSlotCompletion", () => {
  it("bakes the allowed-from set into the WHERE and returns the count", async () => {
    const { tx, updateManyAndReturn, create } = slotTx(2);
    const moved = await transitionSlotCompletion(tx, {
      where: { appointmentId: "apt_1", deletedAt: null },
      to: "CANCELLED",
      data: { deletedAt: new Date("2026-09-02T00:00:00Z") },
    });
    expect(moved).toBe(2);
    expect(updateManyAndReturn).toHaveBeenCalledWith({
      where: {
        appointmentId: "apt_1",
        deletedAt: null,
        completionStatus: { in: ["SCHEDULED", "UNVERIFIED", "RESCHEDULED"] },
      },
      data: {
        completionStatus: "CANCELLED",
        deletedAt: new Date("2026-09-02T00:00:00Z"),
      },
      // #1333 — the owning appointment comes back with each moved row so the
      // history row it writes can name it.
      select: { id: true, appointmentId: true },
    });
    // #1333 — one history row per moved slot, each naming the appointment the
    // row came back with, not a null fallback.
    expect(create).toHaveBeenCalledTimes(2);
    for (const [call] of create.mock.calls) {
      expect(call.data).toEqual(
        expect.objectContaining({
          entity: "SLOT",
          toStatus: "CANCELLED",
          appointmentId: "apt_1",
        }),
      );
    }
  });

  it("fromIn narrows the set", async () => {
    const { tx, updateManyAndReturn } = slotTx(1);
    await transitionSlotCompletion(tx, {
      where: { id: "slot_1" },
      to: "COMPLETED",
      fromIn: ["SCHEDULED"],
    });
    expect(updateManyAndReturn.mock.calls[0][0].where).toEqual({
      id: "slot_1",
      completionStatus: { in: ["SCHEDULED"] },
    });
  });

  it("zero rows throws unless allowZero", async () => {
    const { tx } = slotTx(0);
    await expect(
      transitionSlotCompletion(tx, {
        where: { id: "slot_1" },
        to: "COMPLETED",
      }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    await expect(
      transitionSlotCompletion(tx, {
        where: { id: "slot_1" },
        to: "COMPLETED",
        allowZero: true,
      }),
    ).resolves.toBe(0);
  });
});

describe("TRIAL_ALLOWED_FROM", () => {
  it("pins every edge (mirror of the route's validTransitions, keyed by target)", () => {
    expect(TRIAL_ALLOWED_FROM).toEqual({
      PENDING: [],
      AWAITING_PAYMENT: ["PENDING"],
      SCHEDULED: ["PENDING", "AWAITING_PAYMENT"],
      COMPLETED: ["SCHEDULED"],
      CONVERTED: ["COMPLETED"],
      CANCELLED: ["PENDING", "AWAITING_PAYMENT", "SCHEDULED"],
      REJECTED: ["PENDING"],
    });
  });

  it("a cancelled or converted trial cannot be auto-completed", () => {
    expect(TRIAL_ALLOWED_FROM.COMPLETED).toEqual(["SCHEDULED"]);
  });
});

describe("transitionTrialSession", () => {
  it("throws IllegalTransitionError on zero rows", async () => {
    const { tx } = trialTx(0);
    await expect(
      transitionTrialSession(tx, { where: { id: "trial_1" }, to: "COMPLETED" }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it("carries extra data and the default from-set", async () => {
    const { tx, updateMany } = trialTx(1);
    await transitionTrialSession(tx, {
      where: { id: "trial_1" },
      to: "CONVERTED",
      data: { convertedToSubscriptionId: "sub_1" },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "trial_1", status: { in: ["COMPLETED"] } },
      data: { status: "CONVERTED", convertedToSubscriptionId: "sub_1" },
    });
  });
});
