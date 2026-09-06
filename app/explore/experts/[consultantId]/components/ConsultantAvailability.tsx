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

  const isWeekly = consultantDetails.scheduleType === "WEEKLY";

  return (
    <section className="rounded-2xl border border-border bg-card p-6 md:p-8">
      <div className="mb-5">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">
          Availability
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {isWeekly
            ? "A recurring weekly schedule, shown in your timezone. Pick a slot from the booking panel."
            : "Week-by-week availability, shown in your timezone. Use the arrows to move between weeks and pick a slot from the booking panel."}
        </p>
      </div>

      {isLoading ? (
        <div
          className="grid grid-cols-7 gap-2"
          role="status"
          aria-label="Loading availability"
        >
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="mx-auto h-3 w-8 animate-pulse rounded bg-muted" />
              <div className="h-[4.5rem] animate-pulse rounded-xl bg-muted" />
              <div className="h-[4.5rem] animate-pulse rounded-xl bg-muted" />
            </div>
          ))}
        </div>
      ) : isWeekly ? (
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
      <SlotStatusLegend keys={BUYER_LEGEND_KEYS} className="mt-5" />
    </section>
  );
}
