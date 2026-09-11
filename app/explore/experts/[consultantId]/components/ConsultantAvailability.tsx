import { useCallback, useEffect, useMemo, useState } from "react";
import { DayOfWeek } from "@prisma/client";
import { TSlotTiming } from "@/types/slots";
import { WeeklyAvailability } from "./WeeklyAvailability";
import { CustomAvailability } from "./CustomAvailability";
import { SlotStatusLegend } from "@/components/scheduling/SlotStatusLegend";
import { BUYER_LEGEND_KEYS } from "@/lib/scheduling/slot-status-tokens";
import { addDays, startOfDay, endOfDay } from "date-fns";
import { toZonedTime, formatInTimeZone } from "date-fns-tz";
import type { ConsultantDetailData, ProcessedSlot } from "../types";

interface ConsultantAvailabilityProps {
  consultantDetails: ConsultantDetailData;
  timezone: string;
}

type ProcessedSlotsByDay = Record<DayOfWeek, ProcessedSlot[]>;

type DayWithSlots = {
  date: Date;
  slots: ProcessedSlot[];
};

export function ConsultantAvailability({
  consultantDetails,
  timezone,
}: ConsultantAvailabilityProps) {
  const [availabilityData, setAvailabilityData] = useState<
    Record<
      string,
      (TSlotTiming & {
        isAllocated: boolean;
        bookingStatus: "available" | "partially-booked" | "fully-booked";
      })[]
    >
  >({});
  const [isLoading, setIsLoading] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);

  const handlePrevWeek = useCallback(() => {
    setWeekOffset((w) => Math.max(0, w - 1));
  }, []);

  const handleNextWeek = useCallback(() => {
    setWeekOffset((w) => w + 1);
  }, []);

  // Fetch unified availability data with allocation status
  useEffect(() => {
    const fetchAvailabilityData = async () => {
      if (!consultantDetails?.id || !timezone) return;

      setIsLoading(true);
      try {
        // Fetch slots for the 7-day window based on weekOffset
        const today = new Date();
        const windowStart = addDays(today, weekOffset * 7);
        const startDateInUtc = startOfDay(windowStart);
        const endDateInUtc = endOfDay(addDays(windowStart, 6));

        const response = await fetch(
          `/api/slots/availability-with-allocation/${consultantDetails.id}?startDateInUtc=${startDateInUtc.toISOString()}&endDateInUtc=${endDateInUtc.toISOString()}&timezone=${encodeURIComponent(timezone)}`,
        );

        if (!response.ok) {
          throw new Error("Failed to fetch availability data");
        }

        const { data } = await response.json();
        setAvailabilityData(data);
      } catch (error) {
        console.error("Error fetching availability data:", error);
        setAvailabilityData({});
      } finally {
        setIsLoading(false);
      }
    };

    fetchAvailabilityData();
  }, [consultantDetails?.id, timezone, weekOffset]);

  // Process data for WeeklyAvailability component (group by day of week)
  const processedWeeklySlots = useMemo((): ProcessedSlotsByDay => {
    const slotsByDay: ProcessedSlotsByDay = {
      MONDAY: [],
      TUESDAY: [],
      WEDNESDAY: [],
      THURSDAY: [],
      FRIDAY: [],
      SATURDAY: [],
      SUNDAY: [],
    };

    if (consultantDetails.scheduleType === "WEEKLY") {
      Object.entries(availabilityData).forEach(([_dateStr, slots]) => {
        slots
          .filter((slot) => slot.type === "WEEKLY")
          .forEach((slot) => {
            slotsByDay[slot.dayOfWeek].push({
              id: slot.slotId,
              localStartTime: slot.localStartTime,
              localEndTime: slot.localEndTime,
              originalSlot: {
                id: slot.slotOfAvailabilityId,
                startsAt: slot.startsAt,
                endsAt: slot.endsAt,
              },
              isAllocated: slot.isAllocated,
              bookingStatus: slot.bookingStatus || "available",
              startsAt: slot.startsAt,
              endsAt: slot.endsAt,
              type: "WEEKLY",
            } as ProcessedSlot);
          });
      });
    }

    return slotsByDay;
  }, [availabilityData, consultantDetails.scheduleType]);

  // Process data for CustomAvailability component (group by date)
  // Note: Allow custom slots for all schedule types to support one-off availability
  const processedCustomSlots = useMemo((): DayWithSlots[] => {
    const today = new Date();
    const windowStart = addDays(today, weekOffset * 7);
    const days: DayWithSlots[] = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(startOfDay(toZonedTime(windowStart, timezone)), i);
      const dateKey = formatInTimeZone(date, timezone, "yyyy-MM-dd");

      const slots: ProcessedSlot[] = (availabilityData[dateKey] || [])
        .filter((slot) => slot.type === "CUSTOM")
        .map((slot) => ({
          id: slot.slotId,
          localStartTime: slot.localStartTime,
          localEndTime: slot.localEndTime,
          originalSlot: {
            id: slot.slotOfAvailabilityId,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
          },
          isAllocated: slot.isAllocated,
          bookingStatus: slot.bookingStatus || "available",
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          type: "CUSTOM",
        }));

      return { date, slots };
    });

    return days;
  }, [availabilityData, timezone, weekOffset]);

  if (isLoading) {
    return (
      <div className="bg-gradient-to-br from-white via-gray-50/50 to-white rounded-2xl shadow-xl border border-gray-200/50 p-8 backdrop-blur-sm relative">
        <div className="absolute inset-0 bg-gradient-to-r from-white/20 to-transparent rounded-2xl pointer-events-none" />
        <div className="relative">
          <h3 className="text-xl font-bold mb-4 bg-gradient-to-r from-gray-700 to-gray-900 bg-clip-text text-transparent">
            Consultant Availability
          </h3>
          <div className="flex items-center justify-center py-8">
            <div className="text-muted-foreground flex items-center space-x-2">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-muted-foreground"></div>
              <span>Loading availability...</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h3 className="text-2xl font-bold mb-3 bg-gradient-to-r from-gray-700 to-gray-900 bg-clip-text text-transparent">
          Consultant Availability
        </h3>
        <p className="text-sm text-muted-foreground bg-gradient-to-br from-gray-50 to-white px-4 py-2 rounded-xl border border-border shadow-sm inline-block">
          {consultantDetails.scheduleType === "WEEKLY"
            ? "Weekly schedule. Use the 'Book Now' button to schedule a meeting."
            : "Custom schedule. Use the arrows to navigate weeks. Use the 'Book Now' button to schedule a meeting."}
        </p>
      </div>

      {consultantDetails.scheduleType === "WEEKLY" ? (
        <WeeklyAvailability slotsByDay={processedWeeklySlots} />
      ) : (
        <CustomAvailability
          days={processedCustomSlots}
          onPrevWeek={weekOffset > 0 ? handlePrevWeek : undefined}
          onNextWeek={handleNextWeek}
        />
      )}

      {/* This grid is a read-only overview — booking happens in the pricing
          panel — so the colours need explaining even more than the interactive
          ones do. */}
      <SlotStatusLegend keys={BUYER_LEGEND_KEYS} className="mt-4" />
    </div>
  );
}
