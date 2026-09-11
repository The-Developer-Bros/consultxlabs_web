import { AppointmentsType } from "@prisma/client";

// Base interface for any time slot (availability or appointment)
interface TimeSlotMeta {
  startTime: Date | string; // Can be Date object or ISO string
  endTime: Date | string; // Can be Date object or ISO string
  // Add any other common properties if needed
}

// Interface for appointment slots that require more details (e.g., for tooltips)
interface DetailedTimeSlotMeta extends TimeSlotMeta {
  appointmentDetails?: {
    id: string;
    type: AppointmentsType;
    title: string;
  };
}

// Generic overlapping check
export const isOverlapping = <T extends TimeSlotMeta>(
  intervalStart: Date,
  intervalEnd: Date,
  slotList: T[] = [],
): boolean => {
  return slotList.some((slot) => {
    // Normalize start/end times to Date objects for comparison
    const slotStart =
      slot.startTime instanceof Date
        ? slot.startTime
        : new Date(slot.startTime);
    const slotEnd =
      slot.endTime instanceof Date ? slot.endTime : new Date(slot.endTime);
    // Standard overlap condition: (StartA < EndB) and (StartB < EndA)
    return intervalStart < slotEnd && slotStart < intervalEnd;
  });
};

// Helper to find all overlapping appointment slots (returns detailed info)
const findOverlappingAppointments = (
  intervalStart: Date,
  intervalEnd: Date,
  appointmentSlots: DetailedTimeSlotMeta[] = [],
): DetailedTimeSlotMeta[] => {
  return appointmentSlots.filter((slot) => {
    const slotStart =
      slot.startTime instanceof Date
        ? slot.startTime
        : new Date(slot.startTime);
    const slotEnd =
      slot.endTime instanceof Date ? slot.endTime : new Date(slot.endTime);
    return intervalStart < slotEnd && slotStart < intervalEnd;
  });
};

// --- Unified Slot Status Calculation Logic ---

interface SlotStatusResult {
  isAvailable: boolean; // Is the interval within general availability?
  isBooked: boolean; // Is there *any* booking overlap? (for tooltip/logic)
  isBookedForDisplay: boolean; // Is the interval *fully* covered by bookings? (for grey 'Booked' style)
  isPartiallyBooked: boolean; // Is the interval available but *partially* covered by bookings? (for yellow style)
  isDisabled: boolean; // Should the slot interaction be disabled? (Booked, unavailable, or past)
  isInPast: boolean; // Is the interval end time before now?
  intervalStartUTCString: string; // The UTC start time string for this interval cell
  intervalEndUTCString: string; // The UTC end time string for this interval cell
  localStartTime: Date; // The local start time Date object for this interval cell
  localEndTime: Date; // The local end time Date object for this interval cell
  overlappingAppointments: DetailedTimeSlotMeta[]; // List of appointments overlapping this interval
}

/**
 * Calculates the status of a specific 30-minute time interval cell.
 * @param interval - The { hour, minute } representing the start of the local interval.
 * @param date - The base Date (usually start of the day in local timezone) for the interval.
 * @param availableSlots - List of available time slots (TimeSlotMeta).
 * @param existingAppointments - List of booked appointment slots (DetailedTimeSlotMeta).
 * @returns SlotStatusResult - Detailed status of the interval.
 */
export const getSlotStatus = (
  interval: { hour: number; minute: number },
  date: Date,
  availableSlots: TimeSlotMeta[] = [],
  existingAppointments: DetailedTimeSlotMeta[] = [],
): SlotStatusResult => {
  // 1. Calculate local start/end for the 30-min cell
  const localIntervalStartDate = new Date(date);
  localIntervalStartDate.setHours(interval.hour, interval.minute, 0, 0);
  const localIntervalEndDate = new Date(localIntervalStartDate);
  localIntervalEndDate.setMinutes(localIntervalStartDate.getMinutes() + 30);

  // 2. Convert local cell times to UTC Date objects for comparison
  const intervalStartDateUTC = new Date(localIntervalStartDate.toISOString());
  const intervalEndDateUTC = new Date(localIntervalEndDate.toISOString());
  const intervalStartUTCString = intervalStartDateUTC.toISOString();
  const intervalEndUTCString = intervalEndDateUTC.toISOString();

  // 3. Check against availability and appointments using UTC times
  const isWithinAvailability = isOverlapping(
    intervalStartDateUTC,
    intervalEndDateUTC,
    availableSlots,
  );

  const overlappingAppointments = findOverlappingAppointments(
    intervalStartDateUTC,
    intervalEndDateUTC,
    existingAppointments,
  );

  const isActuallyBooked = overlappingAppointments.length > 0;

  // 4. Calculate booked duration *within* this specific 30-min interval
  let bookedDurationWithinInterval = 0;
  if (isActuallyBooked) {
    overlappingAppointments.forEach((appSlot) => {
      // Ensure we're comparing Date objects
      const appStart =
        appSlot.startTime instanceof Date
          ? appSlot.startTime
          : new Date(appSlot.startTime);
      const appEnd =
        appSlot.endTime instanceof Date
          ? appSlot.endTime
          : new Date(appSlot.endTime);

      const intersectionStart = Math.max(
        intervalStartDateUTC.getTime(),
        appStart.getTime(),
      );
      const intersectionEnd = Math.min(
        intervalEndDateUTC.getTime(),
        appEnd.getTime(),
      );

      if (intersectionEnd > intersectionStart) {
        bookedDurationWithinInterval += intersectionEnd - intersectionStart;
      }
    });
  }

  // 5. Determine booking display status based on duration
  // Interval duration in milliseconds
  const intervalDurationMs = 30 * 60 * 1000;
  // Use a small tolerance (1ms) for floating point safety, check >=
  const isFullyBooked = bookedDurationWithinInterval >= intervalDurationMs - 1;

  // 6. Check if the interval is in the past (using local time)
  const now = new Date();
  const isInPast = localIntervalEndDate < now;

  // 7. Define final states
  const isAvailableForSelection = isWithinAvailability && !isActuallyBooked;
  const isPartiallyBookedForDisplay =
    /* isWithinAvailability && */ isActuallyBooked && !isFullyBooked;
  const isBookedForDisplay = isActuallyBooked && isFullyBooked; // Use this for the main 'Booked' style

  // Slot is disabled if not available OR fully booked OR in the past
  // Note: We allow interaction with partially booked slots in EventTimingsCalendar for tooltip,
  // but TimingsCalendar might disable them. Let the component decide based on these states.
  // The core disability is based on availability, full booking, or being in the past.
  const isDisabledBasedOnState =
    !isWithinAvailability || isBookedForDisplay || isInPast;

  return {
    isAvailable: isAvailableForSelection,
    isBooked: isActuallyBooked, // Keep this to indicate *any* booking overlap
    isBookedForDisplay: isBookedForDisplay,
    isPartiallyBooked: isPartiallyBookedForDisplay, // Renamed for clarity
    isDisabled: isDisabledBasedOnState, // Base disabled state
    isInPast,
    intervalStartUTCString,
    intervalEndUTCString,
    localStartTime: localIntervalStartDate,
    localEndTime: localIntervalEndDate,
    overlappingAppointments,
  };
};

// Constants can also be shared if needed
export const INTERVALS_PER_HOUR = 2;
export const TOTAL_INTERVALS = 24 * INTERVALS_PER_HOUR;
export const INTERVALS = Array.from({ length: TOTAL_INTERVALS }, (_, i) => {
  const hour = Math.floor(i / INTERVALS_PER_HOUR);
  const minute = (i % INTERVALS_PER_HOUR) * (60 / INTERVALS_PER_HOUR);
  return { hour, minute };
});

export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
