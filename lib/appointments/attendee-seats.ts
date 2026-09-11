/**
 * Attaching a paying attendee to an already-allocated event (#1319 / #1071).
 *
 * Webinars and classes are not booked, they are joined: the consultant
 * allocates the sessions once and every registrant is connected to those same
 * `SlotOfAppointment` rows. Nobody gets a row of their own — a per-attendee row
 * would double the consultant's calendar occupancy per seat sold, and for a
 * class it would also mint a second `Appointment` under the same `classId`,
 * which every session count in the product reads as an extra session.
 *
 * Checkout has always done it this way. The webhook capture fallback grew its
 * own creators that did not, so the same purchase produced two different
 * database shapes depending on whether the appointment existed before capture.
 * Both call sites share this now.
 */

import type { PrismaLike } from "@/lib/prisma";

export type SeatBearingAppointment = {
  slotsOfAppointment: Array<{ id: string }>;
};

/**
 * Connect `userId` to every slot of every supplied appointment.
 *
 * Row-at-a-time by necessity: `updateMany` cannot write an implicit m:n
 * relation. The per-slot `connect` is safe to repeat — the join table's unique
 * index on (A,B) makes a duplicate a no-op rather than a second seat (#834).
 *
 * @returns how many slot rows the attendee was linked to.
 */
export async function connectAttendeeToEventSlots(
  tx: PrismaLike,
  args: { appointments: SeatBearingAppointment[]; userId: string },
): Promise<number> {
  let linkedSlotCount = 0;
  for (const appointment of args.appointments) {
    for (const slot of appointment.slotsOfAppointment) {
      await tx.slotOfAppointment.update({
        where: { id: slot.id },
        data: { user: { connect: { id: args.userId } } },
      });
      linkedSlotCount++;
    }
  }
  return linkedSlotCount;
}
