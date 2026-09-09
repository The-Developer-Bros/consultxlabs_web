import prisma from "@/lib/prisma";
import { bookingAppointmentFilter } from "@/lib/booking/cancellation-scope";
import { DISPUTE_INACTIVE_FOR_GATING } from "./dispute-status";

/**
 * #1008 — true when a non-terminal (live) dispute exists on any payment for the
 * BOOKING this appointment belongs to. Callers block state mutations (cancel /
 * reschedule) while a dispute is contested: the appointment is evidence, and a
 * cancel-driven refund would double-pay against a gateway chargeback that may
 * still land.
 *
 * Scoped to the booking, not the row. A subscription's payment lives on the
 * slot-less placeholder appointment created at checkout, so matching on the
 * appointment the caller happens to hold meant the guard never fired for a
 * subscription at all. Defence in depth either way — `refundPayment` re-checks
 * for a live dispute inside its own Serializable reservation — but the guard is
 * what produces the readable 409 instead of a swallowed refund failure.
 *
 * Served by Dispute(paymentId,status) + Payment(appointmentId) indexes. No
 * admin bypass in v1 — TODO(#1319): allow an explicit privileged override.
 */
export async function hasActiveDisputeForAppointment(
  appointmentId: string,
): Promise<boolean> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      consultationId: true,
      subscriptionId: true,
      classId: true,
      webinarId: true,
    },
  });
  const dispute = await prisma.dispute.findFirst({
    where: {
      payment: appointment
        ? {
            appointment: bookingAppointmentFilter({
              ...appointment,
              appointmentId: appointment.id,
            }),
          }
        : { appointmentId },
      status: { notIn: DISPUTE_INACTIVE_FOR_GATING },
    },
    select: { id: true },
  });
  return dispute !== null;
}
