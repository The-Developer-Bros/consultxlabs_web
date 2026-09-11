/**
 * @jest-environment node
 */

/**
 * #1333 — the staff timeline resolves a booking's trail by appointment, and
 * both halves of that were broken in production.
 *
 * Every helper accepted `meta.appointmentId` and no caller ever supplied one,
 * so `BookingStatusHistory.appointmentId` was NULL on every row and the column
 * was dead weight. And creation is not a transition, so a request that had not
 * moved yet had no rows at all — the timeline read "nothing has moved on this
 * booking yet" for every fresh booking. Both are one row's worth of code and
 * both silently regress, so both are pinned here.
 */

import {
  appendCreationHistory,
  transitionConsultationRequest,
} from "../../lib/booking/transitions";

function consultationTx(before: Record<string, unknown> | null) {
  const create = jest.fn(
    async (_args: { data: Record<string, unknown> }) => ({}),
  );
  const tx = {
    consultation: {
      findUnique: jest.fn(async () => before),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    bookingStatusHistory: { create },
  } as never;
  return { tx, create };
}

describe("BookingStatusHistory carries its appointment (#1333)", () => {
  it("resolves the appointment from the pre-image when the caller passes none", async () => {
    const { tx, create } = consultationTx({
      status: "PENDING",
      appointment: { id: "appt-1" },
    });

    await transitionConsultationRequest(tx, {
      where: { id: "cons-1" },
      to: "APPROVED",
    });

    expect(create.mock.calls[0][0].data).toMatchObject({
      entity: "CONSULTATION",
      entityId: "cons-1",
      fromStatus: "PENDING",
      toStatus: "APPROVED",
      appointmentId: "appt-1",
    });
  });

  // "UNKNOWN" is the lost-race sentinel and must not be reused here: an
  // operator reading it on a creation row would be told a concurrent writer
  // moved something, which is the opposite of what happened.
  it("writes the creation row as CREATED, not the UNKNOWN sentinel", async () => {
    const { tx, create } = consultationTx(null);

    await appendCreationHistory(tx, "CONSULTATION", "cons-2", "PENDING", {
      appointmentId: "appt-2",
      actorUserId: "user-1",
    });

    expect(create.mock.calls[0][0].data).toMatchObject({
      entity: "CONSULTATION",
      entityId: "cons-2",
      fromStatus: "CREATED",
      toStatus: "PENDING",
      appointmentId: "appt-2",
      actorUserId: "user-1",
    });
  });
});
