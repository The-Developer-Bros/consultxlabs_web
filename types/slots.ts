import { DayOfWeek } from "@prisma/client";

export type TSlotTiming = {
  slotId: string;
  dateInISO: string;
  dayOfWeek: DayOfWeek;
  startsAt: string;
  endsAt: string;
  slotOfAvailabilityId: string;
  slotOfAppointmentId: string;
  localStartTime: string;
  localEndTime: string;
  isAllocated?: boolean;
  allocatedTo?: string;
  bookingStatus?: "available" | "partially-booked" | "fully-booked";
  type: "WEEKLY" | "CUSTOM"; // Make type required to distinguish slot source
};

export type TWeeklySlot = {
  id: string;
  startDay: DayOfWeek;
  startTimeUtc: number; // Minutes since midnight UTC (0-1439)
  endDay: DayOfWeek;
  endTimeUtc: number; // Minutes since midnight UTC (0-1439)
};

export type TCustomSlot = {
  id: string;
  startsAt: string | Date;
  endsAt: string | Date;
};
