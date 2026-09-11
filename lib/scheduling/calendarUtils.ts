import { TCustomSlot, TWeeklySlot } from "@/types/slots";
import {
  SlotOfAvailabilityCustom,
  SlotOfAvailabilityWeekly,
  DayOfWeek,
  ScheduleType,
  AppointmentsType,
} from "@prisma/client";
import { startOfWeek } from "date-fns";
import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";
import { minuteUtcToDate } from "@/utils/slotAllocation/slotTimeUtils";
import { formatDayKey, formatWeekKey } from "./allocationMessages";

// Core types for the unified calendar system
export interface TimeSlot {
  startTime: Date;
  endTime: Date;
  isAvailable: boolean;
  isBooked: boolean;
  isPartiallyBooked?: boolean;
  isConflicting?: boolean;
  originalSlot?: TWeeklySlot | TCustomSlot;
  appointmentDetails?: AppointmentDetail[];
}

export interface AppointmentDetail {
  id: string;
  type: string;
  title: string;
  with?: string;
}

export interface AppointmentSlot {
  id?: string;
  startsAt: string | Date;
  endsAt: string | Date;
  isTentative?: boolean;
  appointmentDetails?: AppointmentDetail;
}

export interface Appointment {
  id: string;
  appointmentType: AppointmentsType;
  slotsOfAppointment?: AppointmentSlot[];
  webinar?: { status: string; webinarPlan?: { title: string } };
  class?: { status: string; classPlan?: { title: string } };
  consultation?: {
    status: string;
    consultationPlan?: { title: string };
    requestedBy?: { user?: { name: string } };
  };
  subscription?: {
    status: string;
    subscriptionPlan?: { title: string };
    requestedBy?: { user?: { name: string } };
  };
}

export interface ConsultantData {
  scheduleType: ScheduleType;
  slotsOfAvailabilityWeekly: SlotOfAvailabilityWeekly[];
  slotsOfAvailabilityCustom: SlotOfAvailabilityCustom[];
  user?: {
    timezone?: string;
  };
}

export interface SlotStatus {
  isAvailable: boolean;
  isBooked: boolean;
  isPartiallyBooked: boolean;
  isConflicting: boolean;
  isDisabled: boolean;
  isInPast: boolean;
  overlappingAppointments: AppointmentDetail[];
  intervalStartUTCString: string;
  intervalEndUTCString: string;
}

// Day index mapping for weekday calculations
const DAY_INDEX: Record<DayOfWeek, number> = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

/**
 * Maps weekly availability slots to calendar time slots
 */
export function mapWeeklySlots(
  consultantData: ConsultantData,
  currentDate: Date,
  view: "week" | "month" = "week",
  intervalMinutes: number = 30, // Configurable interval duration
): TimeSlot[] {
  if (
    consultantData.scheduleType !== ScheduleType.WEEKLY ||
    !consultantData.slotsOfAvailabilityWeekly?.length
  ) {
    return [];
  }

  // Get the start and end dates based on view
  let startDate: Date, endDate: Date;
  if (view === "week") {
    startDate = startOfWeek(currentDate);
    endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6);
  } else {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    startDate = new Date(year, month, 1);
    endDate = new Date(year, month + 1, 0);
  }

  // Create slots for each weekly pattern within the date range
  const slots: TimeSlot[] = [];
  const iterDate = new Date(startDate);

  while (iterDate <= endDate) {
    const dayOfWeek = iterDate.getDay();
    const matchingSlots = consultantData.slotsOfAvailabilityWeekly.filter(
      (slot) => DAY_INDEX[slot.startDay] === dayOfWeek,
    );

    matchingSlots.forEach((slot) => {
      // startTimeUtc/endTimeUtc are Int (minutes since midnight UTC, 0-1439)
      const slotStartTime = minuteUtcToDate(slot.startTimeUtc, iterDate);
      const slotEndTime = minuteUtcToDate(slot.endTimeUtc, iterDate);

      // Handle slots that cross midnight
      if (slotEndTime <= slotStartTime) {
        slotEndTime.setDate(slotEndTime.getDate() + 1);
      }

      // Create slots with configurable intervals
      let currentHour = new Date(slotStartTime);
      while (currentHour < slotEndTime) {
        const nextInterval = new Date(currentHour);
        nextInterval.setMinutes(currentHour.getMinutes() + intervalMinutes);

        const endTimeForSlot =
          nextInterval > slotEndTime ? slotEndTime : nextInterval;

        slots.push({
          startTime: new Date(currentHour),
          endTime: new Date(endTimeForSlot),
          isAvailable: true,
          isBooked: false,
          originalSlot: slot,
        });

        currentHour = nextInterval;
      }
    });

    // FIXED: Create new date object to avoid mutations
    iterDate.setDate(iterDate.getDate() + 1);
  }

  return slots;
}

/**
 * Maps custom availability slots to calendar time slots
 */
export function mapCustomSlots(
  consultantData: ConsultantData,
  intervalMinutes: number = 30, // Configurable interval duration
): TimeSlot[] {
  if (
    consultantData.scheduleType !== ScheduleType.CUSTOM ||
    !consultantData.slotsOfAvailabilityCustom?.length
  ) {
    return [];
  }

  const slots: TimeSlot[] = [];

  consultantData.slotsOfAvailabilityCustom.forEach((slot) => {
    const startTime = new Date(slot.startsAt);
    const endTime = new Date(slot.endsAt);

    // Create intervals with configurable duration for the custom slot
    let currentInterval = new Date(startTime);
    while (currentInterval < endTime) {
      const nextInterval = new Date(currentInterval);
      nextInterval.setMinutes(currentInterval.getMinutes() + intervalMinutes);

      const endTimeForSlot = nextInterval > endTime ? endTime : nextInterval;

      slots.push({
        startTime: new Date(currentInterval),
        endTime: new Date(endTimeForSlot),
        isAvailable: true,
        isBooked: false,
        originalSlot: slot,
      });

      currentInterval = nextInterval;
    }
  });

  return slots;
}

/**
 * Checks if two time slots overlap
 */
export function slotsOverlap(slot1: TimeSlot, slot2: AppointmentSlot): boolean {
  const slot1Start = slot1.startTime.getTime();
  const slot1End = slot1.endTime.getTime();
  const slot2Start = new Date(slot2.startsAt).getTime();
  const slot2End = new Date(slot2.endsAt).getTime();

  return slot1Start < slot2End && slot1End > slot2Start;
}

/**
 * Gets the status of a specific time slot
 */
export function getSlotStatus(
  interval: { hour: number; minute: number },
  date: Date,
  availableSlots: TimeSlot[],
  existingAppointments: Appointment[],
  intervalMinutes: number = 30, // Configurable interval duration
): SlotStatus {
  const slotStart = new Date(date);
  slotStart.setHours(interval.hour, interval.minute, 0, 0);
  const slotEnd = new Date(slotStart);
  slotEnd.setMinutes(slotStart.getMinutes() + intervalMinutes);

  const now = new Date();
  const isInPast = slotStart < now;

  // Check if this slot is available
  const isAvailable = availableSlots.some((availSlot) => {
    const availStart = availSlot.startTime.getTime();
    const availEnd = availSlot.endTime.getTime();
    return slotStart.getTime() >= availStart && slotEnd.getTime() <= availEnd;
  });

  // Check for overlapping appointments
  const overlappingAppointments: AppointmentDetail[] = [];
  let isBooked = false;
  let isPartiallyBooked = false;

  existingAppointments.forEach((appointment) => {
    appointment.slotsOfAppointment?.forEach((apptSlot) => {
      const apptStart = new Date(apptSlot.startsAt);
      const apptEnd = new Date(apptSlot.endsAt);

      // Check if slots overlap
      if (slotStart < apptEnd && slotEnd > apptStart) {
        let title = "Unknown Appointment";
        let withUser = "";

        if (appointment.appointmentType === AppointmentsType.CONSULTATION) {
          title =
            appointment.consultation?.consultationPlan?.title || "Consultation";
          withUser = appointment.consultation?.requestedBy?.user?.name || "";
        } else if (
          appointment.appointmentType === AppointmentsType.SUBSCRIPTION
        ) {
          title =
            appointment.subscription?.subscriptionPlan?.title || "Subscription";
          withUser = appointment.subscription?.requestedBy?.user?.name || "";
        } else if (appointment.appointmentType === AppointmentsType.WEBINAR) {
          title = appointment.webinar?.webinarPlan?.title || "Webinar";
        } else if (appointment.appointmentType === AppointmentsType.CLASS) {
          title = appointment.class?.classPlan?.title || "Class";
        }

        overlappingAppointments.push({
          id: appointment.id,
          type: appointment.appointmentType,
          title: withUser ? `${title} with ${withUser}` : title,
          with: withUser,
        });

        // Determine booking status
        // FIX: Previously only marked as booked on exact time match. A 30-min
        // interval fully within a 60-min appointment showed as "partially booked"
        // instead of "booked". Now checks if slot is fully contained in appointment.
        if (
          slotStart.getTime() >= apptStart.getTime() &&
          slotEnd.getTime() <= apptEnd.getTime()
        ) {
          isBooked = true;
        } else {
          isPartiallyBooked = true;
        }
      }
    });
  });

  const isConflicting = overlappingAppointments.length > 1;
  const isDisabled = !isAvailable || isBooked || isInPast;

  return {
    isAvailable,
    isBooked,
    isPartiallyBooked,
    isConflicting,
    isDisabled,
    isInPast,
    overlappingAppointments,
    intervalStartUTCString: slotStart.toISOString(),
    intervalEndUTCString: slotEnd.toISOString(),
  };
}

/**
 * Formats appointment slots for API submission
 */
export function formatSlotsForAPI(slots: TimeSlot[]): string[] {
  return slots.map((slot) => slot.startTime.toISOString());
}

/**
 * Calculate required 30-minute slots for different event types.
 * Delegates to SlotCalculationService as the single source of truth,
 * adapting the legacy parameter signature for backward compatibility.
 */
export function calculateRequiredSlots(
  eventType: "consultation" | "subscription" | "webinar" | "class",
  durationInMonths?: number,
  sessionsPerWeek?: number,
  durationInHours?: number,
  startDate?: Date,
  endDate?: Date,
  totalSessions?: number,
): number {
  return SlotCalculationService.calculateRequiredSlots(eventType, {
    durationInMonths,
    sessionsPerWeek,
    durationInHours,
    sessionDurationInHours: durationInHours,
    schedulingPeriodStartsAt: startDate,
    schedulingPeriodEndsAt: endDate,
    totalSessions,
  });
}

/**
 * Count the number of distinct Sunday-start weeks overlapping [start, end].
 * Delegates to SlotCalculationService.countWeeks as the single source of truth.
 */
export const countSundayWeeksInclusive = SlotCalculationService.countWeeks.bind(
  SlotCalculationService,
);

/**
 * Get the Sunday at 00:00:00 of the week that contains the given date.
 * Delegates to SlotCalculationService.startOfWeekSunday as the single source of truth.
 */
export const startOfWeekSunday = SlotCalculationService.startOfWeekSunday.bind(
  SlotCalculationService,
);

/**
 * Validates selected slots for a specific event type
 */
export function validateSelectedSlots(
  selectedSlots: TimeSlot[],
  eventType: "consultation" | "subscription" | "webinar" | "class",
  requiredSlots?: number,
  sessionDurationInHours?: number,
): { isValid: boolean; errorMessage?: string } {
  if (selectedSlots.length === 0) {
    return { isValid: false, errorMessage: "Please select at least one slot" };
  }

  switch (eventType) {
    case "consultation": {
      // FIXED: Validate consultation slots based on required duration
      const consultationRequiredSlots =
        requiredSlots ||
        calculateRequiredSlots(
          eventType,
          undefined,
          undefined,
          sessionDurationInHours,
        );

      if (selectedSlots.length !== consultationRequiredSlots) {
        return {
          isValid: false,
          errorMessage: `This Consultation requires exactly ${consultationRequiredSlots} slot${consultationRequiredSlots !== 1 ? "s" : ""} (${sessionDurationInHours || 1} hour${(sessionDurationInHours || 1) > 1 ? "s" : ""})`,
        };
      }

      // Same-UTC-day requirement first (before consecutive check) — matches
      // the server's same-day rule.
      if (selectedSlots.length > 1) {
        const firstSlotDay = SlotCalculationService.dayKey(
          selectedSlots[0].startTime,
        );
        const allSameDay = selectedSlots.every(
          (slot) =>
            SlotCalculationService.dayKey(slot.startTime) === firstSlotDay,
        );
        if (!allSameDay) {
          return {
            isValid: false,
            errorMessage:
              "Consultation is a one-day event - all slots must be on the same day",
          };
        }
      }

      // FIXED: Only check consecutiveness if all slots are on the same day
      if (
        selectedSlots.length > 1 &&
        !validateDayBasedConsecutiveSlots(selectedSlots)
      ) {
        return {
          isValid: false,
          errorMessage:
            "Consultation slots must be consecutive within the same day",
        };
      }
      break;
    }

    case "webinar": {
      // For webinars, calculate required slots based on session duration
      const webinarRequiredSlots =
        requiredSlots ||
        calculateRequiredSlots(
          eventType,
          undefined,
          undefined,
          sessionDurationInHours,
        );
      if (selectedSlots.length !== webinarRequiredSlots) {
        const durationText = sessionDurationInHours
          ? `${sessionDurationInHours} hour${sessionDurationInHours > 1 ? "s" : ""}`
          : "1 hour";
        return {
          isValid: false,
          errorMessage: `Webinar (${durationText}) requires exactly ${webinarRequiredSlots} consecutive slot${webinarRequiredSlots > 1 ? "s" : ""}`,
        };
      }

      // Validate that slots are consecutive for multi-slot webinars
      if (webinarRequiredSlots > 1) {
        const sortedSlots = [...selectedSlots].sort(
          (a, b) => a.startTime.getTime() - b.startTime.getTime(),
        );
        for (let i = 1; i < sortedSlots.length; i++) {
          const prevSlot = sortedSlots[i - 1];
          const currentSlot = sortedSlots[i];
          if (currentSlot.startTime.getTime() !== prevSlot.endTime.getTime()) {
            return {
              isValid: false,
              errorMessage: "Webinar slots must be consecutive",
            };
          }
        }
      }
      break;
    }

    case "subscription":
    case "class":
      if (requiredSlots && selectedSlots.length !== requiredSlots) {
        return {
          isValid: false,
          errorMessage: `${eventType === "subscription" ? "Subscription" : "Class"} requires exactly ${requiredSlots} slots`,
        };
      }
      break;

    default:
      return { isValid: false, errorMessage: "Invalid event type" };
  }

  // Check for slots in the past
  const now = new Date();
  const pastSlots = selectedSlots.filter((slot) => slot.startTime < now);
  if (pastSlots.length > 0) {
    return { isValid: false, errorMessage: "Cannot select slots in the past" };
  }

  return { isValid: true };
}

/**
 * Groups slots by UTC Sunday week for subscription/class validation — the
 * same bucketing the server validates with.
 */
export function groupSlotsByWeek(
  slots: TimeSlot[],
  schedulingTimezone?: string,
): Map<string, TimeSlot[]> {
  const slotsByWeek = new Map<string, TimeSlot[]>();

  slots.forEach((slot) => {
    const weekKey = SlotCalculationService.weekKey(
      slot.startTime,
      schedulingTimezone,
    );

    if (!slotsByWeek.has(weekKey)) {
      slotsByWeek.set(weekKey, []);
    }
    slotsByWeek.get(weekKey)!.push(slot);
  });

  return slotsByWeek;
}

/**
 * Validates slot distribution for subscriptions/classes
 */
export function validateSlotDistribution(
  slots: TimeSlot[],
  slotsPerWeek: number,
  schedulingTimezone?: string,
): { isValid: boolean; errorMessage?: string } {
  const slotsByWeek = groupSlotsByWeek(slots, schedulingTimezone);

  for (const [weekKey, weekSlots] of Array.from(slotsByWeek.entries())) {
    if (weekSlots.length > slotsPerWeek) {
      return {
        isValid: false,
        errorMessage: `Too many slots selected for the ${formatWeekKey(weekKey)} (max ${slotsPerWeek} allowed)`,
      };
    }
  }

  return { isValid: true };
}

/**
 * Gets appointment title from appointment data
 */
export function getAppointmentTitle(appointment: Appointment): string {
  switch (appointment.appointmentType) {
    case AppointmentsType.CONSULTATION:
      return (
        appointment.consultation?.consultationPlan?.title || "Consultation"
      );
    case AppointmentsType.SUBSCRIPTION:
      return (
        appointment.subscription?.subscriptionPlan?.title || "Subscription"
      );
    case AppointmentsType.WEBINAR:
      return appointment.webinar?.webinarPlan?.title || "Webinar";
    case AppointmentsType.CLASS:
      return appointment.class?.classPlan?.title || "Class";
    case AppointmentsType.TRIAL:
      return "Trial Session";
    default:
      return "Unknown Appointment";
  }
}

/**
 * Gets the user name for consultations/subscriptions
 */
export function getAppointmentUser(appointment: Appointment): string {
  if (appointment.appointmentType === AppointmentsType.CONSULTATION) {
    return appointment.consultation?.requestedBy?.user?.name || "";
  }
  if (appointment.appointmentType === AppointmentsType.SUBSCRIPTION) {
    return appointment.subscription?.requestedBy?.user?.name || "";
  }
  return "";
}

/**
 * FIXED: Validates that slots are consecutive within a single day.
 * This function checks if all slots are consecutive (end time of one slot = start time of next slot)
 * Uses tolerance for timezone/precision issues (within 1 second)
 */
export function validateDayBasedConsecutiveSlots(
  slots: TimeSlot[],
  schedulingTimezone?: string,
): boolean {
  if (slots.length <= 1) return true;

  const sortedSlots = [...slots].sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime(),
  );

  // Check that all slots are on the same scheduling-timezone day (server parity)
  const firstSlotDay = SlotCalculationService.dayKey(
    sortedSlots[0].startTime,
    schedulingTimezone,
  );
  const allSameDay = sortedSlots.every(
    (slot) =>
      SlotCalculationService.dayKey(slot.startTime, schedulingTimezone) ===
      firstSlotDay,
  );
  if (!allSameDay) {
    return false;
  }

  // Check consecutiveness with tolerance for timezone/precision issues
  const toleranceMs = 1000; // 1 second tolerance
  for (let i = 1; i < sortedSlots.length; i++) {
    const prevSlot = sortedSlots[i - 1];
    const currentSlot = sortedSlots[i];

    const timeDiff = Math.abs(
      currentSlot.startTime.getTime() - prevSlot.endTime.getTime(),
    );

    if (timeDiff > toleranceMs) {
      return false;
    }
  }

  return true;
}

/**
 * Calculates call progress for subscriptions
 * Returns a clean, organized string showing progress with visual hierarchy
 */
export function calculateCallProgress(
  slots: TimeSlot[],
  sessionDurationInHours?: number,
  maxTotalCalls?: number,
  schedulingTimezone?: string,
): string {
  if (slots.length === 0) {
    return "No slots selected";
  }

  const slotsPerCall = Math.ceil((sessionDurationInHours || 1) / 0.5);
  const completedCalls = Math.floor(slots.length / slotsPerCall);
  const incompleteCallSlots = slots.length % slotsPerCall;

  // Group by scheduling-timezone day
  const slotsByDay = new Map<string, TimeSlot[]>();
  slots.forEach((slot) => {
    const dayKey = SlotCalculationService.dayKey(
      slot.startTime,
      schedulingTimezone,
    );
    if (!slotsByDay.has(dayKey)) {
      slotsByDay.set(dayKey, []);
    }
    slotsByDay.get(dayKey)!.push(slot);
  });

  const incompleteDays = Array.from(slotsByDay.entries()).filter(
    ([_, daySlots]) => daySlots.length > 0 && daySlots.length < slotsPerCall,
  );

  // Build clean, multi-line progress text
  const lines: string[] = [];

  // Line 1: Main progress
  if (maxTotalCalls) {
    lines.push(`✅ ${completedCalls}/${maxTotalCalls} calls scheduled`);
  } else {
    lines.push(
      `✅ ${completedCalls} call${completedCalls !== 1 ? "s" : ""} scheduled`,
    );
  }

  // Line 2: Incomplete call warning (if applicable)
  if (incompleteCallSlots > 0 && incompleteDays.length > 0) {
    const [incompleteDay, incompleteDaySlots] = incompleteDays[0];
    const needed = slotsPerCall - incompleteDaySlots.length;
    const date = formatDayKey(incompleteDay);
    const duration = sessionDurationInHours || 1;
    const durationText = duration === 1 ? "1 hour" : `${duration} hours`;

    lines.push(
      `⚠️ ${date}: Add ${needed} more slot${needed !== 1 ? "s" : ""} to complete ${durationText} call`,
    );
  }

  return lines.join(" | ");
}
