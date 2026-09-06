import React, { useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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

const NAV_BUTTON =
  "mt-6 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-card text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-card";

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
    <div className="flex items-start gap-2">
      <button
        type="button"
        onClick={onPrevWeek}
        disabled={!onPrevWeek}
        className={NAV_BUTTON}
        aria-label="Previous week"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>

      <div className="min-w-0 flex-1">
        <div className="mb-3 grid grid-cols-7 gap-2">
          {mergedDays.map(({ date }) => (
            <div key={date.toISOString()} className="text-center">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {date.toLocaleDateString(undefined, { weekday: "short" })}
              </p>
              <p className="mt-0.5 text-xs text-foreground">
                {date.toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-2">
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
                    const tone = isFullyBooked
                      ? SLOT_STATUS_TOKENS.fullyBooked.className
                      : isPartiallyBooked
                        ? SLOT_STATUS_TOKENS.partiallyBooked.className
                        : slot.isAllocated
                          ? SLOT_STATUS_TOKENS.rescheduling.className
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
                        {slot.isAllocated &&
                          !isFullyBooked &&
                          !isPartiallyBooked && (
                            <span className="text-[10px] font-semibold leading-tight opacity-90">
                              Request
                              <br />
                              Approval {bookedDate && `(${bookedDate})`}
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

      <button
        type="button"
        onClick={onNextWeek}
        disabled={!onNextWeek}
        className={NAV_BUTTON}
        aria-label="Next week"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
};
