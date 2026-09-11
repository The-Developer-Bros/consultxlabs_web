import { format } from "date-fns";
import { TAppointment } from "@/types/appointment";
import { isDeadSlot } from "@/lib/appointments/slots";

/**
 * The LIVE slot rows of an appointment — dead rows (CANCELLED / RESCHEDULED /
 * deletedAt tombstone) and tentative holds excluded.
 *
 * Booking-journey audit B7: the Today/Upcoming helpers used to iterate every
 * row, so a reschedule's released slots (still carrying their original
 * startsAt on an APPROVED parent) rendered as "Today's Appointment", and a
 * tentative hold could announce itself in "Needs you now". Every consumer of
 * these helpers — Today/Upcoming lists, HomeTab action items — inherits the
 * filter.
 */
function liveSlotsOf(appointment: TAppointment): TAppointment["slotsOfAppointment"] {
  return (appointment.slotsOfAppointment ?? []).filter(
    (slot) => !isDeadSlot(slot) && !slot.isTentative,
  );
}

// =============================================================================
// Collaborator Types
// =============================================================================

/**
 * Collaborator shape from Prisma when included with consultantProfile.user.
 * Not all queries include collaborators, so access requires a runtime guard.
 */
interface PlanCollaborator {
  consultantProfileId: string;
  role: string;
  status?: string;
}

interface PlanWithCollaborators {
  collaborators?: PlanCollaborator[];
}

// =============================================================================
// Collaborator Role Helpers
// =============================================================================

/**
 * Determine the collaborator role for the current consultant on a webinar/class appointment.
 * Returns null for consultations/subscriptions (no collaborators) or solo events without collaborators.
 *
 * Uses PlanWithCollaborators cast + Array.isArray guard because not all Prisma
 * queries that produce TAppointment include the collaborators relation.
 */
export function getCollaboratorRole(
  appointment: TAppointment,
  consultantId: string,
): string | null {
  if (appointment.appointmentType === "WEBINAR" && appointment.webinar) {
    const plan = appointment.webinar.webinarPlan;
    const collaborators = (plan as PlanWithCollaborators).collaborators;
    if (plan?.consultantProfileId === consultantId) {
      if (Array.isArray(collaborators) && collaborators.length > 0) {
        return "HOST";
      }
      return null; // Solo event
    }
    if (Array.isArray(collaborators)) {
      const collab = collaborators.find(
        (c) => c.consultantProfileId === consultantId,
      );
      if (collab) return collab.role;
    }
  }
  if (appointment.appointmentType === "CLASS" && appointment.class) {
    const plan = appointment.class.classPlan;
    const collaborators = (plan as PlanWithCollaborators).collaborators;
    if (plan?.consultantProfileId === consultantId) {
      if (Array.isArray(collaborators) && collaborators.length > 0) {
        return "HOST";
      }
      return null;
    }
    if (Array.isArray(collaborators)) {
      const collab = collaborators.find(
        (c) => c.consultantProfileId === consultantId,
      );
      if (collab) return collab.role;
    }
  }
  return null;
}

/** Format a collaborator role enum value to a human-readable label */
export function formatCollaboratorRole(role: string): string {
  const labels: Record<string, string> = {
    HOST: "Host",
    CO_HOST: "Co-Host",
    MODERATOR: "Moderator",
    GUEST_SPEAKER: "Guest Speaker",
    TECHNICAL_SUPPORT: "Tech Support",
    CO_INSTRUCTOR: "Co-Instructor",
    TEACHING_ASSISTANT: "TA",
    GUEST_LECTURER: "Guest Lecturer",
    CONTENT_CREATOR: "Content Creator",
  };
  return labels[role] || role;
}

/** Get the CSS class for a collaborator role badge */
export function getRoleBadgeStyle(role: string): string {
  if (role === "HOST") return "bg-gray-900 text-white";
  return "bg-purple-100 text-purple-800";
}

// Get the relevant name based on appointment type
// For consultations/subscriptions: returns the consultee (requester) name
// For webinars/classes: returns the consultant (host) name
export const getConsumeeName = (appointment: TAppointment): string => {
  if (!appointment) return "Unknown User";

  switch (appointment.appointmentType) {
    case "CONSULTATION":
      return (
        appointment.consultation?.requestedBy?.user?.name ?? "Unknown User"
      );
    case "SUBSCRIPTION":
      return (
        appointment.subscription?.requestedBy?.user?.name ?? "Unknown User"
      );
    case "WEBINAR":
      // For webinars, show the consultant (host) name
      return (
        appointment.webinar?.webinarPlan?.consultantProfile?.user?.name ??
        "Unknown Consultant"
      );
    case "CLASS":
      // For classes, show the consultant (instructor) name
      return (
        appointment.class?.classPlan?.consultantProfile?.user?.name ??
        "Unknown Consultant"
      );
    default:
      return "Unknown User";
  }
};

// Get the relevant image based on appointment type
// For consultations/subscriptions: returns the consultee (requester) image
// For webinars/classes: returns the consultant (host) image
export const getConsumeeImage = (appointment: TAppointment): string => {
  if (!appointment) return "/placeholder.svg";

  switch (appointment.appointmentType) {
    case "CONSULTATION":
      return (
        appointment.consultation?.requestedBy?.user?.image ??
        "/placeholder-user.jpg"
      );
    case "SUBSCRIPTION":
      return (
        appointment.subscription?.requestedBy?.user?.image ??
        "/placeholder-user.jpg"
      );
    case "WEBINAR":
      // For webinars, show the consultant (host) image
      return (
        appointment.webinar?.webinarPlan?.consultantProfile?.user?.image ??
        "/placeholder.svg"
      );
    case "CLASS":
      // For classes, show the consultant (instructor) image
      return (
        appointment.class?.classPlan?.consultantProfile?.user?.image ??
        "/placeholder.svg"
      );
    default:
      return "/placeholder.svg";
  }
};

// Get appointment type and plan
export const getAppointmentTypeAndPlan = (
  appointment: TAppointment,
): string => {
  if (!appointment?.appointmentType) return "Unknown Type";

  const type =
    appointment.appointmentType.charAt(0) +
    appointment.appointmentType.slice(1).toLowerCase();
  let plan = "Unknown Plan";

  switch (appointment.appointmentType) {
    case "CONSULTATION":
      plan =
        appointment.consultation?.consultationPlan?.title ?? "Unknown Plan";
      break;
    case "SUBSCRIPTION":
      plan =
        appointment.subscription?.subscriptionPlan?.title ?? "Unknown Plan";
      break;
    case "WEBINAR":
      plan = appointment.webinar?.webinarPlan?.title ?? "Unknown Plan";
      break;
    case "CLASS":
      plan = appointment.class?.classPlan?.title ?? "Unknown Plan";
      break;
  }

  return `${type} - ${plan}`;
};

// Get all slot times from appointment with proper type conversion
export const getSlotTimes = (appointment: TAppointment): Date[] => {
  if (!appointment?.slotsOfAppointment?.length) {
    return [];
  }

  return appointment.slotsOfAppointment
    .map((slot) => new Date(slot.startsAt))
    .filter((date) => !isNaN(date.getTime()));
};

/**
 * Calculates session progress metrics for a group of appointments
 * @param groupAppointments - Array of appointments in the group (e.g., subscription sessions)
 * @param referenceDate - Optional reference date for comparison (defaults to now)
 * @returns Session progress metrics including total, completed, remaining sessions and percentage
 */
export const calculateSessionProgress = (
  groupAppointments: TAppointment[],
  referenceDate: Date = new Date(),
): {
  totalSessions: number;
  completedSessions: number;
  remainingSessions: number;
  progressPercentage: number;
} => {
  // Exclude slot-less appointments (e.g. the zero-slot subscription checkout
  // placeholder that carries the signup Payment — preserved by allocation, never
  // deleted). A row with no slots is not a session, so counting it inflated
  // totalSessions/remaining by 1 ("11 remaining" for a 10-session sub). This
  // mirrors the completedSessions rule below, which already requires slots.
  const appointmentsWithSlots = groupAppointments.filter(
    (app) => getSlotTimes(app).length > 0,
  );

  const totalSessions = appointmentsWithSlots.length;
  const completedSessions = appointmentsWithSlots.filter((app) => {
    const slotTimes = getSlotTimes(app);
    return (
      slotTimes.length > 0 &&
      slotTimes.every((time) => new Date(time) < referenceDate)
    );
  }).length;
  const remainingSessions = totalSessions - completedSessions;
  const progressPercentage =
    totalSessions > 0 ? (completedSessions / totalSessions) * 100 : 0;

  return {
    totalSessions,
    completedSessions,
    remainingSessions,
    progressPercentage,
  };
};

// Get first slot time from appointment (for backwards compatibility)
export const getStartTime = (appointment: TAppointment): Date | null => {
  const times = getSlotTimes(appointment);
  return times.length > 0 ? times[0] : null;
};

// Check if appointment has any future slots
export const hasUpcomingSlots = (appointment: TAppointment): boolean => {
  const now = new Date();
  return getSlotTimes(appointment).some((time) => new Date(time) > now);
};

// Get the next upcoming slot time (first future slot), falling back to the earliest slot
export const getNextUpcomingSlotTime = (
  appointment: TAppointment,
): Date | null => {
  const now = new Date();
  const sortedTimes = getSlotTimes(appointment).sort(
    (a, b) => a.getTime() - b.getTime(),
  );
  return sortedTimes.find((time) => time > now) ?? sortedTimes[0] ?? null;
};

// Check if appointment has any slots today
export const hasTodaySlots = (appointment: TAppointment): boolean => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999,
  );

  return getSlotTimes(appointment).some((time) => {
    const date = new Date(time);
    return date >= todayStart && date <= todayEnd;
  });
};

// Format UTC time to local time
export const formatAppointmentTime = (utcTime: string): string => {
  // Create a date object in local time
  const localDate = new Date(utcTime);

  // Format the date in local time with browser's timezone
  return format(localDate, "EEE, MMM d, h:mm a");
};

// Get appointment status
export const getAppointmentStatus = (appointment: TAppointment): string => {
  const startTime = getStartTime(appointment);

  // Handle appointments with no slots
  if (!startTime) return "Not Scheduled";

  const now = new Date();

  // Check if appointment is marked as cancelled
  if (
    appointment.class?.status === "CANCELLED" ||
    appointment.webinar?.status === "CANCELLED"
  ) {
    return "Cancelled";
  }

  // Check if appointment is marked as completed
  if (
    appointment.class?.status === "COMPLETED" ||
    appointment.webinar?.status === "COMPLETED"
  ) {
    return "Completed";
  }

  // Check if a slot is currently in progress (not ended early)
  const currentSlot = appointment?.slotsOfAppointment?.find((slot) => {
    if (slot.isTentative) return false;
    if (
      slot.completionStatus === "CANCELLED" ||
      slot.completionStatus === "RESCHEDULED"
    )
      return false;
    if (slot.meetingSession?.endedAt) return false;
    const start = new Date(slot.startsAt).getTime();
    const end = slot.endsAt
      ? new Date(slot.endsAt).getTime()
      : start + 60 * 60 * 1000;
    return start <= now.getTime() && now.getTime() <= end;
  });
  if (currentSlot) return "In Progress";

  // Check if all slots are in the past
  const slotTimes = getSlotTimes(appointment);
  if (slotTimes.length > 0 && slotTimes.every((time) => new Date(time) < now)) {
    return "Completed";
  }

  // For appointments with both past and future slots, use the next upcoming slot
  const effectiveTime = getNextUpcomingSlotTime(appointment) ?? startTime;

  // Calculate time differences using local time
  const diffMs = effectiveTime.getTime() - now.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));

  // Use calendar-based day comparison for accurate "Today"/"Tomorrow" labels
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrowStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );
  const dayAfterTomorrowStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 2,
  );

  const appointmentDate = new Date(effectiveTime);

  // Upcoming appointments with more precise timing
  if (diffMinutes <= 5 && diffMinutes > 0) return "Meeting in 5 min";
  if (diffMinutes <= 15 && diffMinutes > 5) return "Starting soon";

  // Check if appointment is today (same calendar day)
  if (appointmentDate >= todayStart && appointmentDate < tomorrowStart) {
    return "Today";
  }

  // Check if appointment is tomorrow (next calendar day)
  if (
    appointmentDate >= tomorrowStart &&
    appointmentDate < dayAfterTomorrowStart
  ) {
    return "Tomorrow";
  }

  // Calculate day difference for appointments further out
  const diffDays = Math.floor(
    (appointmentDate.getTime() - todayStart.getTime()) / (1000 * 60 * 60 * 24),
  );

  if (diffDays < 7) return `In ${diffDays} days`;

  // For weekly intervals, show exact week number
  const exactWeeks = Math.ceil(diffDays / 7);
  return `In ${exactWeeks} ${exactWeeks === 1 ? "week" : "weeks"}`;
};

// Sort appointments by start time
export const sortAppointmentsByStartTime = (
  appointments: TAppointment[],
): TAppointment[] => {
  return [...appointments].sort((a, b) => {
    const aTime = getStartTime(a);
    const bTime = getStartTime(b);
    if (!aTime && !bTime) return 0;
    if (!aTime) return 1; // Put appointments without time at the end
    if (!bTime) return -1;
    return aTime.getTime() - bTime.getTime();
  });
};

// Filter today's appointments
export const getTodayAppointments = (
  appointments: TAppointment[],
): TAppointment[] => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999,
  );

  // First expand appointments with multiple slots (only for subscriptions and classes)
  const expandedAppointments = appointments.flatMap((appointment) => {
    const liveSlots = liveSlotsOf(appointment);
    if (liveSlots.length === 0) {
      return [appointment];
    }

    // Only expand subscriptions and classes by slot
    // Consultations and webinars keep all slots together as one event
    if (
      appointment.appointmentType === "SUBSCRIPTION" ||
      appointment.appointmentType === "CLASS"
    ) {
      return liveSlots.map((slot) => ({
        ...appointment,
        id: `${appointment.id}-${slot.id}`,
        slotsOfAppointment: [slot],
      }));
    }

    // Keep consultations and webinars as single appointments — but with only
    // their live rows, so a released reschedule slot cannot anchor "today".
    return [{ ...appointment, slotsOfAppointment: liveSlots }];
  });

  return expandedAppointments.filter((appointment) => {
    const slotTime = getStartTime(appointment);
    if (!slotTime) return false;

    const slotDate = new Date(slotTime);
    const isToday = slotDate >= todayStart && slotDate <= todayEnd;

    return isToday;
  });
};

// Filter upcoming appointments
export const getUpcomingAppointments = (
  appointments: TAppointment[],
): TAppointment[] => {
  const now = new Date();

  // Drop dead/tentative rows up front (B7) so neither the expansion below nor
  // the per-appointment checks can resurrect a released or unconfirmed slot.
  // An appointment whose rows ALL died (every session cancelled or
  // rescheduled away) drops out entirely — with zero live rows it has nothing
  // to show, and the raw-slot readers below would re-admit it (CodeRabbit
  // triage). Appointments that arrived with NO rows at all keep legacy
  // behavior (their liveness is decided by the checks below, not slots).
  const withLiveSlots = appointments.flatMap((appointment) => {
    const live = liveSlotsOf(appointment);
    if (live.length === 0 && (appointment.slotsOfAppointment ?? []).length > 0) {
      return [];
    }
    return [{ ...appointment, slotsOfAppointment: live }];
  });

  // First filter out completed appointments
  const filteredAppointments = withLiveSlots.filter((appointment) => {
    // For multi-slotted appointments (subscription and class)
    if (
      (appointment.appointmentType === "SUBSCRIPTION" &&
        appointment.subscription) ||
      (appointment.appointmentType === "CLASS" && appointment.class)
    ) {
      // Check if all slots are in the past
      const upcomingSlotTimes = getSlotTimes(appointment);
      const allSlotsCompleted =
        upcomingSlotTimes.length > 0 &&
        upcomingSlotTimes.every((time) => new Date(time) < now);
      // Only include if not all slots are completed
      return !allSlotsCompleted;
    }

    // For single-slotted appointments (consultation and webinar)
    if (hasUpcomingSlots(appointment)) {
      // For webinar appointments
      if (appointment.appointmentType === "WEBINAR" && appointment.webinar) {
        return appointment.webinar.status !== "COMPLETED";
      }

      // For consultation appointments
      return true;
    }

    return false;
  });

  return filteredAppointments;
};

// Group recurring appointments
export const groupRecurringAppointments = (
  appointments: TAppointment[],
): { [key: string]: TAppointment[] } => {
  const groups: { [key: string]: TAppointment[] } = {};

  // Group appointments by their type (subscription/class/single)
  appointments.forEach((appointment) => {
    let groupKey = "";

    if (
      appointment.appointmentType === "SUBSCRIPTION" &&
      appointment.subscription
    ) {
      groupKey = `subscription-${appointment.subscription.id}`;
    } else if (appointment.appointmentType === "CLASS" && appointment.class) {
      groupKey = `class-${appointment.class.id}`;
    } else {
      groupKey = `single-${appointment.id}`;
    }

    if (!groups[groupKey]) {
      groups[groupKey] = [];
    }

    groups[groupKey].push(appointment);
  });

  // Sort appointments within each group by start time
  Object.keys(groups).forEach((key) => {
    groups[key] = sortAppointmentsByStartTime(groups[key]);
  });

  return groups;
};

