"use client";

import { ScheduleType } from "@prisma/client";
import { Alert, AlertDescription, AlertTitle } from "components/ui/alert";
import { Label } from "components/ui/label";
import { RadioGroup, RadioGroupItem } from "components/ui/radio-group";
import { Calendar, CalendarDays } from "lucide-react";
import { SlotValidationFeedback } from "@/components/schedule/SlotValidationFeedback";
import type { SlotsType } from "@/utils/schedule/types";
import {
  formatDayDisplay,
  getDaysInMonth,
  getFirstDayOfMonth,
  getLocalDateString,
} from "@/utils/dateTimeUtils";
import { DAYS_OF_WEEK, getMonthYearString } from "../settings";
import { AvailabilityGrid } from "./AvailabilityGrid";

interface AvailabilitySectionProps {
  scheduleType: ScheduleType;
  canSwitchSchedule: boolean;
  scheduleSwitchBlockedReason: string | null;
  onScheduleTypeChange: (value: string) => void;
  weeklySlots: SlotsType;
  customSlots: SlotsType;
  currentDate: Date;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onToggleCustomDate: (dateString: string, isSelected: boolean) => void;
  onAddSlot: (dayKey: string) => void;
  onUpdateSlot: (
    dayKey: string,
    index: number,
    field: "startTime" | "endTime",
    value: string,
  ) => void;
  onDeleteSlot: (dayKey: string, index: number) => void;
}

/**
 * Compact stand-in for the schedule type that is NOT selected. Editing is
 * per-type; rendering the inactive editor in full (even faded) doubled the
 * page height — with 40+ custom dates it produced screens of washed-out
 * rows that read as endless empty space.
 */
function InactiveScheduleNote({
  label,
  summary,
}: {
  label: string;
  summary: string;
}) {
  return (
    <div
      aria-live="polite"
      className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 text-sm text-zinc-500"
    >
      <p className="font-medium text-zinc-600">{label} is inactive</p>
      <p className="mt-1">
        {summary}. Select this schedule type above to view and edit.
      </p>
    </div>
  );
}

/**
 * Availability tab of the consultant settings form. Presentational only —
 * all slot state, validation, and the WEEKLY↔CUSTOM switch lock live in
 * SettingsTab so the combined settings PUT payload stays exactly as it was
 * before the monolith was decomposed.
 */
export function AvailabilitySection({
  scheduleType,
  canSwitchSchedule,
  scheduleSwitchBlockedReason,
  onScheduleTypeChange,
  weeklySlots,
  customSlots,
  currentDate,
  onPrevMonth,
  onNextMonth,
  onToggleCustomDate,
  onAddSlot,
  onUpdateSlot,
  onDeleteSlot,
}: AvailabilitySectionProps) {
  const renderCalendarDays = () => {
    const daysInMonth = getDaysInMonth(currentDate);
    const firstDayOfMonth = getFirstDayOfMonth(currentDate);
    const days = [];

    for (let i = 0; i < firstDayOfMonth; i++) {
      days.push(<div key={`empty-${i}`} className="p-2"></div>);
    }

    for (let i = 1; i <= daysInMonth; i++) {
      const date = new Date(
        currentDate.getFullYear(),
        currentDate.getMonth(),
        i,
      );
      const dateString = getLocalDateString(date);
      const isSelected = customSlots[dateString] !== undefined;

      days.push(
        <button
          key={`day-${i}`}
          type="button"
          className={`p-2 rounded-full hover:bg-zinc-200
        ${isSelected ? "bg-zinc-900 text-white" : ""}`}
          onClick={() => onToggleCustomDate(dateString, isSelected)}
        >
          {i}
        </button>,
      );
    }

    return days;
  };

  return (
    <div>
      <h2 className="text-2xl font-bold mb-3">Availability Settings</h2>
      <p className="text-sm text-zinc-600 mb-8">
        Configure your availability and scheduling preferences
      </p>

      <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
        <h3 className="font-medium text-blue-900 mb-2 flex items-center">
          <Calendar className="w-4 h-4 inline mr-1" />
          Schedule Type Filtering
        </h3>
        <p className="text-sm text-blue-700">
          <strong>Important:</strong> Consultees will only see slots from your
          selected schedule type. Choose &quot;Weekly Recurring&quot; for
          regular appointments or &quot;Custom Schedule&quot; for specific
          dates only.
        </p>
      </div>

      {!canSwitchSchedule && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>Schedule Type Locked</AlertTitle>
          <AlertDescription>
            {scheduleSwitchBlockedReason ||
              "You have active appointments that prevent schedule type changes."}{" "}
            Please complete or cancel all pending appointments before switching
            schedule types.
          </AlertDescription>
        </Alert>
      )}

      <RadioGroup
        value={scheduleType}
        onValueChange={onScheduleTypeChange}
        className="flex flex-col md:flex-row md:space-x-8 space-y-4 md:space-y-0"
      >
        {/* Weekly Schedule */}
        <div className="flex-1">
          <div className="flex items-center justify-between mb-4">
            <Label htmlFor="WEEKLY" className="font-medium flex items-center">
              <Calendar className="w-4 h-4 mr-1" />
              Weekly Recurring
              <span className="ml-2 text-xs text-zinc-500">
                (Shows recurring slots)
              </span>
            </Label>
            <RadioGroupItem id="WEEKLY" value={ScheduleType.WEEKLY} />
          </div>
          {/* Only the ACTIVE schedule type renders its full editor. The old
              opacity-40 treatment still rendered the inactive editor at full
              height — with a season of custom dates that meant screens of
              washed-out rows that read as endless empty space. */}
          {scheduleType === ScheduleType.WEEKLY ? (
            <div className="space-y-4">
              {DAYS_OF_WEEK.map((day) => (
                <AvailabilityGrid
                  key={day}
                  dayKey={day.toLowerCase()}
                  label={formatDayDisplay(day)}
                  slots={weeklySlots[day.toLowerCase()]}
                  onAddSlot={onAddSlot}
                  onUpdateSlot={onUpdateSlot}
                  onDeleteSlot={onDeleteSlot}
                />
              ))}
            </div>
          ) : (
            <InactiveScheduleNote
              label="Weekly Recurring"
              summary={`${Object.values(weeklySlots).reduce(
                (n, s) => n + (s?.length ?? 0),
                0,
              )} recurring slot(s) configured`}
            />
          )}
        </div>

        {/* Custom Schedule */}
        <div className="flex-1">
          <div className="flex items-center justify-between mb-4">
            <Label htmlFor="CUSTOM" className="font-medium flex items-center">
              <CalendarDays className="w-4 h-4 mr-1" />
              Custom Schedule
              <span className="ml-2 text-xs text-zinc-500">
                (Shows specific date slots)
              </span>
            </Label>
            <RadioGroupItem id="CUSTOM" value={ScheduleType.CUSTOM} />
          </div>
          {scheduleType !== ScheduleType.CUSTOM ? (
            <InactiveScheduleNote
              label="Custom Schedule"
              summary={`${Object.keys(customSlots).length} date(s) configured`}
            />
          ) : (
          <div className="space-y-4">
            <div className="calendar-container bg-card border p-4 rounded-lg">
              <div className="flex justify-between items-center mb-4">
                <button
                  type="button"
                  className="text-zinc-900 hover:bg-zinc-100 p-2 rounded-full"
                  onClick={onPrevMonth}
                  aria-label="Previous month"
                >
                  &larr;
                </button>
                <span className="font-medium">
                  {getMonthYearString(currentDate)}
                </span>
                <button
                  type="button"
                  className="text-zinc-900 hover:bg-zinc-100 p-2 rounded-full"
                  onClick={onNextMonth}
                  aria-label="Next month"
                >
                  &rarr;
                </button>
              </div>
              <div className="grid grid-cols-7 gap-1 text-center">
                {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
                  <div key={day} className="text-sm font-medium">
                    {day}
                  </div>
                ))}
                {renderCalendarDays()}
              </div>
            </div>

            {/* A season of custom dates can run 40+ entries — contain them in
                their own scroll region instead of stretching the page. */}
            {Object.keys(customSlots).length > 0 && (
              <p className="text-xs text-zinc-500">
                {Object.keys(customSlots).length} date(s) configured
              </p>
            )}
            <div className="max-h-[560px] overflow-y-auto pr-2 space-y-4">
              {Object.keys(customSlots)
                .sort((a, b) => a.localeCompare(b))
                .map((dateString) => {
                  // Parse YYYY-MM-DD as a LOCAL date — new Date("YYYY-MM-DD")
                  // is UTC midnight, which renders as the PREVIOUS day for
                  // users in timezones behind UTC.
                  const [year, month, day] = dateString.split("-").map(Number);
                  const date = new Date(year, month - 1, day);
                  return (
                    <AvailabilityGrid
                      key={dateString}
                      dayKey={dateString}
                      label={date.toLocaleDateString("en-US", {
                        weekday: "long",
                        month: "long",
                        day: "numeric",
                      })}
                      slots={customSlots[dateString]}
                      onAddSlot={onAddSlot}
                      onUpdateSlot={onUpdateSlot}
                      onDeleteSlot={onDeleteSlot}
                    />
                  );
                })}
            </div>
          </div>
          )}
        </div>
      </RadioGroup>

      {/* Slot Validation Feedback - shared component */}
      <SlotValidationFeedback
        slots={scheduleType === ScheduleType.WEEKLY ? weeklySlots : customSlots}
        className="mt-4"
      />
    </div>
  );
}
