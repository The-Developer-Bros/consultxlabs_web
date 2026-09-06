import React, { useMemo, useState } from "react";
import { DayOfWeek } from "@prisma/client";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { roundTime, timeToMinutes } from "../utils/time";
import { mergeConsecutiveSlotsForDisplay } from "../utils/mergeSlots";
import type { ProcessedSlot } from "../types";
import { SLOT_STATUS_TOKENS } from "@/lib/scheduling/slot-status-tokens";

type ProcessedSlotsByDay = Record<DayOfWeek, ProcessedSlot[]>;

interface WeeklyAvailabilityProps {
  slotsByDay: ProcessedSlotsByDay;
}

const VISIBLE_SLOT_COUNT = 5;

const DAY_NAMES: DayOfWeek[] = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
];

export function WeeklyAvailability({ slotsByDay }: WeeklyAvailabilityProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const mergedSlotsByDay = useMemo(() => {
    const result: Record<DayOfWeek, ProcessedSlot[]> = {} as Record<
      DayOfWeek,
      ProcessedSlot[]
    >;
    for (const day of DAY_NAMES) {
      const sorted = (slotsByDay[day] || []).slice().sort((a, b) => {
        return (
          timeToMinutes(roundTime(a.localStartTime)) -
          timeToMinutes(roundTime(b.localStartTime))
        );
      });
      result[day] = mergeConsecutiveSlotsForDisplay(sorted);
    }
    return result;
  }, [slotsByDay]);

  // Check if any day has more slots than the visible limit
  const totalHidden = useMemo(() => {
    return DAY_NAMES.reduce((sum, day) => {
      const excess = mergedSlotsByDay[day].length - VISIBLE_SLOT_COUNT;
      return sum + (excess > 0 ? excess : 0);
    }, 0);
  }, [mergedSlotsByDay]);

  // Get the date for booked slots in user timezone
  const getBookedSlotDate = (slot: ProcessedSlot) => {
    if (!slot.startsAt) return "";
    const date = new Date(slot.startsAt);
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  };

  return (
    <div>
      <div className="grid grid-cols-7 gap-2">
        {DAY_NAMES.map((day) => {
          const allSlots = mergedSlotsByDay[day];
          const visibleSlots = isExpanded
            ? allSlots
            : allSlots.slice(0, VISIBLE_SLOT_COUNT);

          return (
            <div key={day} className="space-y-2">
              <p className="text-center text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {day.slice(0, 3)}
              </p>

              {visibleSlots.length > 0 ? (
                visibleSlots.map((slot) => {
                  const bookingStatus = slot.bookingStatus || "available";
                  const isFullyBooked = bookingStatus === "fully-booked";
                  const isPartiallyBooked =
                    bookingStatus === "partially-booked";
                  const bookedDate =
                    isFullyBooked || isPartiallyBooked
                      ? getBookedSlotDate(slot)
                      : "";
                  const tone = isFullyBooked
                    ? SLOT_STATUS_TOKENS.fullyBooked.className
                    : isPartiallyBooked
                      ? SLOT_STATUS_TOKENS.partiallyBooked.className
                      : SLOT_STATUS_TOKENS.available.className;

                  return (
                    <div
                      key={slot.id}
                      className={`flex min-h-[4.5rem] w-full flex-col items-center justify-center gap-1 rounded-xl border px-2 py-2 text-center text-xs ${tone}`}
                    >
                      <span className="text-[11px] font-medium leading-tight">
                        {roundTime(slot.localStartTime)} –{" "}
                        {roundTime(slot.localEndTime)}
                      </span>
                      {isFullyBooked && (
                        <span className="text-[10px] font-semibold leading-tight opacity-90">
                          Booked
                          <br />
                          {bookedDate && `(${bookedDate})`}
                        </span>
                      )}
                      {isPartiallyBooked && (
                        <span className="text-[10px] font-semibold leading-tight opacity-90">
                          Partially
                          <br />
                          Booked {bookedDate && `(${bookedDate})`}
                        </span>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="flex min-h-[4.5rem] items-center justify-center rounded-xl border border-dashed border-border text-xs text-muted-foreground/70">
                  No slots
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Single expand/collapse button for the entire week */}
      {totalHidden > 0 && (
        <div className="mt-4 flex justify-center">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setIsExpanded((prev) => !prev)}
          >
            {isExpanded ? (
              <>
                <ChevronUp className="h-3.5 w-3.5" />
                Show less
              </>
            ) : (
              <>
                <ChevronDown className="h-3.5 w-3.5" />
                Show {totalHidden} more slots
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
