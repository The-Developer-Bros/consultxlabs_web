import { TAppointment } from "@/types/appointment";

// Get the participant management URL for an appointment
export const getParticipantManagementUrl = (
  appointment: TAppointment,
  consultantId: string,
): string => {
  const baseUrl = `/dashboard/consultant/${consultantId}/appointments/participants`;

  // Only group sessions have a roster worth managing. CONSULTATION and
  // SUBSCRIPTION are 1-on-1 — they used to emit URLs here, but the pages
  // those URLs pointed at were unreachable (supportsParticipantManagement
  // below has always excluded them) and rendered a "roster" of two people.
  switch (appointment.appointmentType) {
    case "WEBINAR":
      return `${baseUrl}/webinars/${appointment.webinarId}`;
    case "CLASS":
      return `${baseUrl}/classes/${appointment.classId}`;
    default:
      return "#";
  }
};

// Check if an appointment type supports participant management
export const supportsParticipantManagement = (
  appointment: TAppointment,
): boolean => {
  return !!(
    appointment.webinarId ||
    appointment.classId
  );
};
