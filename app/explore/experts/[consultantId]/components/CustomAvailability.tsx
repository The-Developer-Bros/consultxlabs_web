import React, { useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { roundTime, timeToMinutes } from "../utils/time";
import { mergeConsecutiveSlotsForDisplay } from "../utils/mergeSlots";
import type { ProcessedSlot } from "../types";
import { SLOT_STATUS_TOKENS } from "@/lib/scheduling/slot-status-tokens";

interface DayWithSlots {
  date: Date;
  slots: ProcessedSlot[];
}

interface CustomAvailabilityProps {
  days: DayWithSlots[];
  onPrevWeek?: () => void;
  onNextWeek?: () => void;
}

const VISIBLE_SLOT_COUNT = 5;

export const CustomAvailability: React.FC<CustomAvailabilityProps> = ({
  days,
  onPrevWeek,
  onNextWeek,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // Sort and merge consecutive slots for each day
  const mergedDays = useMemo(() => {
    return days.map((day) => {
      const sorted = day.slots.slice().sort((a, b) => {
        return (
          timeToMinutes(a.localStartTime) - timeToMinutes(b.localStartTime)
        );
      });
      return {
        ...day,
        slots: mergeConsecutiveSlotsForDisplay(sorted),
      };
    });
  }, [days]);

  // Check if any day has more slots than the visible limit
  const totalHidden = useMemo(() => {
    return mergedDays.reduce((sum, day) => {
      const excess = day.slots.length - VISIBLE_SLOT_COUNT;
      return sum + (excess > 0 ? excess : 0);
    }, 0);
  }, [mergedDays]);

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
    <div className="bg-gradient-to-br from-white via-gray-50/50 to-white rounded-2xl shadow-xl border border-gray-200/50 p-8 backdrop-blur-sm relative">
      {/* Glossy overlay effect */}
      <div className="absolute inset-0 bg-gradient-to-r from-white/20 to-transparent rounded-2xl pointer-events-none" />

      <div className="relative">
        <h3 className="text-2xl font-bold mb-6 text-center text-gray-800 bg-gradient-to-r from-gray-700 to-gray-900 bg-clip-text text-transparent">
          Custom Availability
        </h3>

        {/* Navigation and grid content */}
        <div className="flex items-start gap-2">
          {/* Left arrow */}
          <button
            onClick={onPrevWeek}
            disabled={!onPrevWeek}
            className={`flex-shrink-0 mt-2 p-2 rounded-xl border shadow-sm transition-all ${
              onPrevWeek
                ? "bg-gradient-to-b from-gray-100 to-gray-200/80 border-gray-300/50 text-gray-700 hover:from-gray-200 hover:to-gray-300/80 cursor-pointer"
                : "bg-gray-50 border-gray-200/50 text-gray-300 cursor-not-allowed"
            }`}
            aria-label="Previous week"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>

          {/* Date headers and slots */}
          <div className="flex-1 min-w-0">
            {/* Date headers */}
            <div className="grid grid-cols-7 gap-4 mb-6">
              {mergedDays.map(({ date }) => (
                <div key={date.toISOString()} className="text-center">
                  <div className="bg-gradient-to-b from-gray-100 to-gray-200/80 px-3 py-2 rounded-xl border border-gray-300/50 shadow-sm">
                    <div className="text-sm font-semibold text-gray-800">
                      {date.toLocaleDateString(undefined, { weekday: "short" })}
                    </div>
                    <div className="text-xs text-gray-600 mt-1">
                      {date.toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Slots grid */}
            <div className="grid grid-cols-7 gap-4">
              {mergedDays.map(({ date, slots: daySlots }) => {
                const visibleSlots = isExpanded
                  ? daySlots
                  : daySlots.slice(0, VISIBLE_SLOT_COUNT);

                return (
                  <div key={date.toISOString()} className="space-y-2">
                    {visibleSlots.length > 0 ? (
                      visibleSlots.map((slot) => {
                        const bookingStatus = slot.bookingStatus || "available";
                        const isFullyBooked = bookingStatus === "fully-booked";
                        const isPartiallyBooked =
                          bookingStatus === "partially-booked";
                        const bookedDate =
                          isFullyBooked || isPartiallyBooked || slot.isAllocated
                            ? getBookedSlotDate(slot)
                            : "";

                        return (
                          <div
                            key={slot.id}
                            className={`
                              w-full min-h-[4.5rem] px-2 py-2 text-xs rounded-xl
                              border shadow-lg backdrop-blur-sm relative overflow-hidden
                              ${
                                isFullyBooked
                                  ? SLOT_STATUS_TOKENS.fullyBooked.className
                                  : isPartiallyBooked
                                    ? SLOT_STATUS_TOKENS.partiallyBooked.className
                                    : slot.isAllocated
                                      ? SLOT_STATUS_TOKENS.rescheduling.className
                                      : SLOT_STATUS_TOKENS.available.className
                              }
                            `}
                          >
                            {/* Glossy overlay for buttons */}
                            <div className="absolute inset-0 bg-gradient-to-r from-white/20 to-transparent rounded-xl pointer-events-none" />

                            <div className="relative flex flex-col items-center justify-center h-full space-y-1">
                              {/* Time range in one line */}
                              <div className="font-medium leading-tight text-center text-[11px]">
                                {roundTime(slot.localStartTime)} -{" "}
                                {roundTime(slot.localEndTime)}
                              </div>

                              {/* Status and date for booked/allocated slots */}
                              {isFullyBooked && (
                                <div className="text-[10px] font-semibold opacity-90 text-center leading-tight">
                                  Booked
                                  <br />
                                  {bookedDate && `(${bookedDate})`}
                                </div>
                              )}
                              {isPartiallyBooked && (
                                <div className="text-[10px] font-semibold opacity-90 text-center leading-tight">
                                  Partially
                                  <br />
                                  Booked {bookedDate && `(${bookedDate})`}
                                </div>
                              )}
                              {slot.isAllocated &&
                                !isFullyBooked &&
                                !isPartiallyBooked && (
                                  <div className="text-[10px] font-semibold opacity-90 text-center leading-tight">
                                    Request
                                    <br />
                                    Approval {bookedDate && `(${bookedDate})`}
                                  </div>
                                )}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="min-h-[4.5rem] flex items-center justify-center text-xs text-muted-foreground/70 bg-gradient-to-br from-gray-50 to-gray-100 rounded-xl border border-border shadow-sm">
                        No slots
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Single expand/collapse button for the entire week */}
            {totalHidden > 0 && (
              <div className="flex justify-center mt-4">
                <button
                  onClick={() => setIsExpanded((prev) => !prev)}
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-emerald-700 hover:text-emerald-900 bg-emerald-50 hover:bg-emerald-100 rounded-xl border border-emerald-200 transition-colors cursor-pointer shadow-sm"
                >
                  {isExpanded ? (
                    <>
                      <ChevronUp className="w-3.5 h-3.5" />
                      Show less
                    </>
                  ) : (
                    <>
                      <ChevronDown className="w-3.5 h-3.5" />
                      Show {totalHidden} more slots
                    </>
                  )}
                </button>
              </div>
            )}
          </div>

          {/* Right arrow */}
          <button
            onClick={onNextWeek}
            disabled={!onNextWeek}
            className={`flex-shrink-0 mt-2 p-2 rounded-xl border shadow-sm transition-all ${
              onNextWeek
                ? "bg-gradient-to-b from-gray-100 to-gray-200/80 border-gray-300/50 text-gray-700 hover:from-gray-200 hover:to-gray-300/80 cursor-pointer"
                : "bg-gray-50 border-gray-200/50 text-gray-300 cursor-not-allowed"
            }`}
            aria-label="Next week"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
};
