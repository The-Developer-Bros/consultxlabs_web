/**
 * @jest-environment node
 */

/**
 * #1319 A12 — every guarded transition appends one BookingStatusHistory row in
 * the same tx, AFTER the compare-and-set succeeded, and never when it failed.
 */

import {
  transitionConsultationRequest,
  transitionSubscriptionRequest,
  transitionWebinarEvent,
  transitionClassEvent,
  transitionRescheduleRequest,
  transitionSlotCompletion,
  transitionTrialSession,
} from "../../lib/booking/transitions";
import { IllegalTransitionError } from "../../lib/enterprise/transitions";

function makeTx(model: string, opts: { count: number; before: string | null }) {
  const order: string[] = [];
  const findUnique = jest.fn(async () => {
    order.push("read");
    return opts.before === null ? null : { status: opts.before };
  });
  const updateMany = jest.fn(async () => {
    order.push("cas");
    return { count: opts.count };
  });
  const create = jest.fn(async (_args: { data: Record<string, unknown> }) => {
    order.push("history");
    return {};
  });
  const tx = {
    [model]: { findUnique, updateMany },
    bookingStatusHistory: { create },
  } as never;
  return { tx, findUnique, updateMany, create, order };
}

const cases: Array<{
  name: string;
  model: string;
  entity: string;
  run: (tx: never) => Promise<void>;
  to: string;
}> = [
  {
    name: "consultation",
    model: "consultation",
    entity: "CONSULTATION",
    to: "APPROVED",
    run: (tx) =>
      transitionConsultationRequest(tx, {
        where: { id: "c1" },
        to: "APPROVED",
        actorUserId: "u1",
        reason: "ok",
      }),
  },
  {
    name: "subscription",
    model: "subscription",
    entity: "SUBSCRIPTION",
    to: "CANCELLED",
    run: (tx) =>
      transitionSubscriptionRequest(tx, {
        where: { id: "s1" },
        to: "CANCELLED",
      }),
  },
  {
    name: "webinar",
    model: "webinar",
    entity: "WEBINAR",
    to: "COMPLETED",
    run: (tx) =>
      transitionWebinarEvent(tx, { where: { id: "w1" }, to: "COMPLETED" }),
  },
  {
    name: "class",
    model: "class",
    entity: "CLASS",
    to: "CANCELLED",
    run: (tx) =>
      transitionClassEvent(tx, { where: { id: "k1" }, to: "CANCELLED" }),
  },
  {
    name: "reschedule request",
    model: "rescheduleRequest",
    entity: "RESCHEDULE_REQUEST",
    to: "ACCEPTED",
    run: (tx) =>
      transitionRescheduleRequest(tx, { where: { id: "r1" }, to: "ACCEPTED" }),
  },
  {
    name: "trial session",
    model: "trialSession",
    entity: "TRIAL",
    to: "CANCELLED",
    run: (tx) =>
      transitionTrialSession(tx, { where: { id: "t1" }, to: "CANCELLED" }),
  },
];

describe.each(cases)(
  "$name transition history",
  ({ model, entity, run, to }) => {
    it("reads the from-status, runs the CAS, then appends one history row", async () => {
      const { tx, create, order } = makeTx(model, {
        count: 1,
        before: "PENDING",
      });
      await run(tx);
      expect(order).toEqual(["read", "cas", "history"]);
      expect(create).toHaveBeenCalledTimes(1);
      const row = create.mock.calls[0][0].data;
      expect(row).toMatchObject({
        entity,
        fromStatus: "PENDING",
        toStatus: to,
      });
    });

    it("writes no history when the CAS matched zero rows", async () => {
      const { tx, create } = makeTx(model, { count: 0, before: "PENDING" });
      await expect(run(tx)).rejects.toBeInstanceOf(IllegalTransitionError);
      expect(create).not.toHaveBeenCalled();
    });

    it("logs UNKNOWN when the row could not be pre-read", async () => {
      const { tx, create } = makeTx(model, { count: 1, before: null });
      await run(tx);
      expect(create.mock.calls[0][0].data.fromStatus).toBe("UNKNOWN");
    });
  },
);

describe("attribution rides the row", () => {
  it("actor and reason are stored when given", async () => {
    const { tx, create } = makeTx("consultation", {
      count: 1,
      before: "PENDING",
    });
    await transitionConsultationRequest(tx, {
      where: { id: "c1" },
      to: "APPROVED",
      actorUserId: "u1",
      reason: "consultant approved",
      organizationId: "org1",
      appointmentId: "a1",
    });
    expect(create.mock.calls[0][0].data).toMatchObject({
      actorUserId: "u1",
      reason: "consultant approved",
      organizationId: "org1",
      appointmentId: "a1",
    });
  });
});

// The slot helper is the one bulk CAS: it sweeps a WhereInput rather than an
// id, so it pre-reads the cohort for from-statuses and appends one row per id
// the UPDATE's own RETURNING says it moved.
describe("slot completion history", () => {
  function slotTx(
    rows: Array<{ id: string; completionStatus: string }>,
    movedIds: string[] = rows.map((r) => r.id),
  ) {
    const order: string[] = [];
    const findMany = jest.fn(async () => {
      order.push("read");
      return rows;
    });
    const updateManyAndReturn = jest.fn(async () => {
      order.push("cas");
      return movedIds.map((id) => ({ id }));
    });
    const create = jest.fn(async (_args: { data: Record<string, unknown> }) => {
      order.push("history");
      return {};
    });
    return {
      tx: {
        slotOfAppointment: { findMany, updateManyAndReturn },
        bookingStatusHistory: { create },
      } as never,
      findMany,
      create,
      order,
    };
  }

  it("appends one SLOT row per slot the sweep moved, carrying each from-status", async () => {
    const { tx, create, order } = slotTx([
      { id: "slot_1", completionStatus: "SCHEDULED" },
      { id: "slot_2", completionStatus: "UNVERIFIED" },
    ]);
    const moved = await transitionSlotCompletion(tx, {
      where: { appointmentId: "apt_1", deletedAt: null },
      to: "CANCELLED",
      actorUserId: "u1",
    });
    expect(moved).toBe(2);
    expect(order).toEqual(["read", "cas", "history", "history"]);
    expect(create.mock.calls.map((c) => c[0].data)).toEqual([
      expect.objectContaining({
        entity: "SLOT",
        entityId: "slot_1",
        fromStatus: "SCHEDULED",
        toStatus: "CANCELLED",
        actorUserId: "u1",
      }),
      expect.objectContaining({
        entity: "SLOT",
        entityId: "slot_2",
        fromStatus: "UNVERIFIED",
        toStatus: "CANCELLED",
      }),
    ]);
  });

  it("pre-reads with the CAS's own from-set, so an ineligible row is never logged", async () => {
    const { tx, findMany } = slotTx([
      { id: "slot_1", completionStatus: "SCHEDULED" },
    ]);
    await transitionSlotCompletion(tx, {
      where: { appointmentId: "apt_1" },
      to: "CANCELLED",
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        appointmentId: "apt_1",
        completionStatus: { in: ["SCHEDULED", "UNVERIFIED", "RESCHEDULED"] },
      },
      select: { id: true, completionStatus: true },
    });
  });

  // A concurrent writer can pull a pre-read row out of the from-set before the
  // CAS lands. Logging the pre-read would invent an audit row for a slot this
  // call never moved, which is a different (and worse) defect than A12's
  // stale from-status.
  it("logs only the ids the CAS actually moved, not the whole pre-read cohort", async () => {
    const { tx, create } = slotTx(
      [
        { id: "slot_1", completionStatus: "SCHEDULED" },
        { id: "slot_2", completionStatus: "SCHEDULED" },
      ],
      ["slot_2"],
    );
    const moved = await transitionSlotCompletion(tx, {
      where: { appointmentId: "apt_1" },
      to: "CANCELLED",
    });
    expect(moved).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data).toMatchObject({
      entity: "SLOT",
      entityId: "slot_2",
      fromStatus: "SCHEDULED",
      toStatus: "CANCELLED",
    });
  });

  it("writes no history when a permitted zero-row sweep matches nothing", async () => {
    const { tx, create } = slotTx([]);
    await expect(
      transitionSlotCompletion(tx, {
        where: { appointmentId: "apt_1" },
        to: "CANCELLED",
        allowZero: true,
      }),
    ).resolves.toBe(0);
    expect(create).not.toHaveBeenCalled();
  });
});
