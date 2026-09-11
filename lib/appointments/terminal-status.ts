import { AppointmentStatus, ClassStatus, WebinarStatus } from "@prisma/client";

/**
 * DOC-1 (#694) — an appointment is "terminal" for document visibility once the
 * underlying booking is cancelled / rejected / expired (e.g. after a refund).
 *
 * Appointment has no status of its own — it lives on the child booking, and
 * each child uses a different enum — so the check is per booking type. COMPLETED
 * is deliberately NOT terminal: a finished engagement keeps its deliverables.
 */
const TERMINAL_BOOKING_STATUSES: readonly AppointmentStatus[] = [
  AppointmentStatus.CANCELLED,
  AppointmentStatus.REJECTED,
  AppointmentStatus.EXPIRED,
];

/**
 * Minimal structural shape — each child is optional so callers can include only
 * the booking types their query actually resolves (a missing child reads as
 * not-terminal). Webinar/Class only cancel, so CANCELLED is their one terminal.
 */
export interface TerminalCheckAppointment {
  consultation?: { status: AppointmentStatus } | null;
  subscription?: { status: AppointmentStatus } | null;
  webinar?: { status: WebinarStatus } | null;
  class?: { status: ClassStatus } | null;
}

export function isBookingTerminal(
  appointment: TerminalCheckAppointment,
): boolean {
  if (appointment.consultation) {
    return TERMINAL_BOOKING_STATUSES.includes(appointment.consultation.status);
  }
  if (appointment.subscription) {
    return TERMINAL_BOOKING_STATUSES.includes(appointment.subscription.status);
  }
  if (appointment.webinar) {
    return appointment.webinar.status === WebinarStatus.CANCELLED;
  }
  if (appointment.class) {
    return appointment.class.status === ClassStatus.CANCELLED;
  }
  return false;
}
