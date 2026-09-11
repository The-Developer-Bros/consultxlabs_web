/**
 * Recording Utility Functions
 * Shared helpers for recording-related operations
 */

import prisma from "@/lib/prisma";

/**
 * Type for appointment with ownership relations
 * Used for checking if a consultant owns a recording/session
 */
export interface OwnedPlan {
  consultantProfileId: string | null;
  recordingEnabled?: boolean;
}

export interface AppointmentWithOwnership {
  webinar?: { webinarPlan?: OwnedPlan | null } | null;
  class?: { classPlan?: OwnedPlan | null } | null;
  // #1134 P1-6 — 1:1 was simply absent here, which is why recording a
  // consultation or a subscription was impossible rather than merely disabled:
  // isAppointmentOwner returned false for the actual owner, so start-recording
  // 403'd, and isRecordingEnabledForAppointment reported false regardless of
  // what the plan said.
  consultation?: { consultationPlan?: OwnedPlan | null } | null;
  subscription?: { subscriptionPlan?: OwnedPlan | null } | null;
}

/**
 * The plan behind an appointment, whichever of the four kinds it is.
 * One resolver so ownership and the recording flag can never disagree about
 * which plan they are reading — the bug above was exactly that divergence.
 */
export function resolveAppointmentPlan(
  appointment: AppointmentWithOwnership | null | undefined,
): OwnedPlan | null {
  if (!appointment) return null;
  return (
    appointment.webinar?.webinarPlan ??
    appointment.class?.classPlan ??
    appointment.consultation?.consultationPlan ??
    appointment.subscription?.subscriptionPlan ??
    null
  );
}

/**
 * Check if a consultant owns an appointment (webinar or class)
 *
 * @param appointment - The appointment with webinar/class plan relations
 * @param consultantProfileId - The consultant's profile ID to check against
 * @returns true if the consultant owns the appointment
 */
export function isAppointmentOwner(
  appointment: AppointmentWithOwnership | null | undefined,
  consultantProfileId: string | null | undefined,
): boolean {
  if (!consultantProfileId) return false;
  const plan = resolveAppointmentPlan(appointment);
  return !!plan && plan.consultantProfileId === consultantProfileId;
}

/**
 * Check if recording is enabled for an appointment
 *
 * @param appointment - The appointment with webinar/class plan relations
 * @returns true if recording is enabled for this appointment's plan
 */
export function isRecordingEnabledForAppointment(
  appointment: AppointmentWithOwnership | null | undefined,
): boolean {
  return resolveAppointmentPlan(appointment)?.recordingEnabled === true;
}

/**
 * Get ownership info from a recording with nested relations
 *
 * @param recording - Recording with meetingSession -> slotOfAppointment -> appointment relations
 * @param consultantProfileId - The consultant's profile ID to check against
 * @returns Object with isOwner and recordingEnabled flags
 */
export function getRecordingOwnershipInfo(
  recording: {
    meetingSession?: {
      slotOfAppointment?: {
        appointment?: AppointmentWithOwnership | null;
      } | null;
    } | null;
  } | null,
  consultantProfileId: string | null | undefined,
): { isOwner: boolean; recordingEnabled: boolean } {
  const appointment = recording?.meetingSession?.slotOfAppointment?.appointment;

  return {
    isOwner: isAppointmentOwner(appointment, consultantProfileId),
    recordingEnabled: isRecordingEnabledForAppointment(appointment),
  };
}

/**
 * Get ownership info from a meeting session with nested relations
 *
 * @param meetingSession - MeetingSession with slotOfAppointment -> appointment relations
 * @param consultantProfileId - The consultant's profile ID to check against
 * @returns Object with isOwner and recordingEnabled flags
 */
/**
 * Appointment shape for title generation (includes plan titles for all event types)
 */
interface AppointmentWithTitles {
  webinar?: { webinarPlan?: { title?: string } | null } | null;
  class?: { classPlan?: { title?: string } | null } | null;
  consultation?: { consultationPlan?: { title?: string } | null } | null;
  subscription?: { subscriptionPlan?: { title?: string } | null } | null;
}

/**
 * Generate a recording title from appointment info and date.
 * Shared across recording handlers and sync functions to avoid duplication.
 */
export function generateRecordingTitle(
  appointment: AppointmentWithTitles | null | undefined,
  recordedAt: Date,
): string {
  let title = "Recording";

  if (appointment?.webinar?.webinarPlan?.title) {
    title = `Webinar: ${appointment.webinar.webinarPlan.title}`;
  } else if (appointment?.class?.classPlan?.title) {
    title = `Class: ${appointment.class.classPlan.title}`;
  } else if (appointment?.consultation?.consultationPlan?.title) {
    title = `Consultation: ${appointment.consultation.consultationPlan.title}`;
  } else if (appointment?.subscription?.subscriptionPlan?.title) {
    title = `Subscription: ${appointment.subscription.subscriptionPlan.title}`;
  }

  const dateStr = recordedAt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return `${title} - ${dateStr}`;
}

/**
 * Get all attendee user IDs for a webinar or class event — everyone connected
 * to one of the event's slots.
 */
export async function getEventAttendeeIds(
  appointment:
    | {
        webinar?: { id: string } | null;
        class?: { id: string } | null;
      }
    | null
    | undefined,
  existingUserIds: string[] = [],
): Promise<string[]> {
  if (!appointment) return existingUserIds;

  let eventFilter: { webinarId: string } | { classId: string } | null = null;
  if (appointment.webinar) {
    eventFilter = { webinarId: appointment.webinar.id };
  } else if (appointment.class) {
    eventFilter = { classId: appointment.class.id };
  }

  if (!eventFilter) return existingUserIds;

  const slotUsers = await prisma.slotOfAppointment.findMany({
    where: { appointment: eventFilter },
    select: { user: { select: { id: true } } },
  });

  return Array.from(
    new Set([
      ...existingUserIds,
      ...slotUsers.flatMap((s) => s.user.map((u) => u.id)),
    ]),
  );
}

export function getMeetingSessionOwnershipInfo(
  meetingSession: {
    slotOfAppointment?: {
      appointment?: AppointmentWithOwnership | null;
    } | null;
  } | null,
  consultantProfileId: string | null | undefined,
): { isOwner: boolean; recordingEnabled: boolean } {
  const appointment = meetingSession?.slotOfAppointment?.appointment;

  return {
    isOwner: isAppointmentOwner(appointment, consultantProfileId),
    recordingEnabled: isRecordingEnabledForAppointment(appointment),
  };
}
