"use client";

import * as Sentry from "@sentry/nextjs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DAYS, INTERVALS } from "@/utils/timeSlotsMeta";
import { TWENTY_FOUR_HOURS_IN_MS } from "@/utils/slotAllocation/slotTimeUtils";
import { isRecurringEventType } from "@/utils/slotAllocation/types";
import {
  format,
  addDays,
  startOfWeek,
  endOfWeek,
  isSameDay,
  addWeeks,
  subWeeks,
  addMonths,
  subMonths,
} from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  Clock,
  Users,
  Zap,
  RotateCcw,
} from "lucide-react";
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  TimeSlot,
  AppointmentDetail,
  calculateRequiredSlots,
  calculateCallProgress,
  countSundayWeeksInclusive,
  validateDayBasedConsecutiveSlots,
} from "@/lib/scheduling/calendarUtils";
import { CalendarGridSkeleton } from "@/components/scheduling/CalendarSkeletons";
import { useCalendarData } from "@/hooks/scheduling/useCalendarData";
import { useEventSlotAllocation } from "@/hooks/scheduling/useSlotAllocation";
import type { AllocationResponse } from "@/lib/scheduling/allocationService";
import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";
import {
  outsideSchedulingWindow,
  weeklyLimitReached,
  pastSlotBlocked,
  pastSessionBlocked,
  sessionTooSoon,
  sessionBeingRescheduled,
  slotUnavailable,
  notEnoughConsecutive,
  schedulingWeekBucket,
} from "@/lib/scheduling/allocationMessages";
import { useToast } from "@/hooks/use-toast";
import {
  SLOT_STATUS_TOKENS,
  resolveSlotStatusKey,
  slotCellClassName,
} from "@/lib/scheduling/slot-status-tokens";
import {
  focusGridPosition,
  focusScrollRow,
  focusTargetRow,
  gridTimeZone,
  type SlotPickerFocus,
} from "@/lib/scheduling/slot-picker-focus";

/**
 * Small pure helpers for clarity and reuse. These do not cause side effects.
 */
function getSlotsPerCall(sessionDurationInHours?: number): number {
  return Math.ceil((sessionDurationInHours || 1) / 0.5); // 30-min increments
}

/** Minutes as a phrase a buyer would use — never a slot count (ADR B1). */
function formatDurationLabel(minutes: number): string {
  if (minutes % 60 !== 0) return `${minutes} min`;
  const hours = minutes / 60;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

// The time gutter must be a FIXED first column, not 1/8 of the row. As an
// equal-8 grid the gutter kept its w-14 while its CELL shrank with the
// container, so in a narrow modal the label overflowed onto Sunday and
// rendered as "19:30Available". minmax(0,1fr) also stops long cell text
// blowing the day columns out.
const GRID_COLS =
  "grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] md:grid-cols-[5rem_repeat(7,minmax(0,1fr))]";

/** Returns true if a UTC date is outside the [allowedStart, allowedEnd] bounds. */
function isOutsideAllowedRange(
  dateUtc: Date,
  allowedStart?: Date,
  allowedEnd?: Date,
): boolean {
  if (allowedStart && dateUtc < allowedStart) return true;
  if (allowedEnd && dateUtc > allowedEnd) return true;
  return false;
}

/** Returns true if a date (day-level) is within the allowed scheduling period. */
function isDateInSchedulingPeriod(
  date: Date,
  allowedStart?: Date,
  allowedEnd?: Date,
): boolean {
  if (!allowedStart && !allowedEnd) return false;

  // Compare at day level (ignore time)
  const dateOnly = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  const startOnly = allowedStart
    ? new Date(
        allowedStart.getFullYear(),
        allowedStart.getMonth(),
        allowedStart.getDate(),
      )
    : null;
  const endOnly = allowedEnd
    ? new Date(
        allowedEnd.getFullYear(),
        allowedEnd.getMonth(),
        allowedEnd.getDate(),
      )
    : null;

  if (startOnly && dateOnly < startOnly) return false;
  if (endOnly && dateOnly > endOnly) return false;
  return true;
}

/** Formats the allowed [start, end] range for user-facing messages. */
function formatAllowedRange(allowedStart?: Date, allowedEnd?: Date): string {
  const startText = allowedStart
    ? format(allowedStart, "MMM d, yyyy 'at' h:mm a")
    : "-";
  const endText = allowedEnd
    ? format(allowedEnd, "MMM d, yyyy 'at' h:mm a")
    : "-";
  return `${startText} – ${endText}`;
}

/**
 * Compares two TimeSlot arrays by content (not reference).
 * Used to prevent unnecessary state updates that cause infinite loops.
 */
function areSlotsEqual(slots1: TimeSlot[], slots2: TimeSlot[]): boolean {
  if (slots1.length !== slots2.length) return false;

  // Sort both arrays by startTime for consistent comparison
  const sorted1 = [...slots1].sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime(),
  );
  const sorted2 = [...slots2].sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime(),
  );

  return sorted1.every(
    (slot, index) =>
      slot.startTime.getTime() === sorted2[index].startTime.getTime(),
  );
}

/**
 * Counts completed calls from the user's current selection for a specific week.
 * A completed call is exactly `slotsPerCall` consecutive 30-min slots on the same day.
 */
function countCompletedSelectedCallsForWeek(
  selectedSlots: TimeSlot[],
  slotsPerCall: number,
  targetWeekKey: string,
  schedulingTimezone?: string,
): number {
  if (!selectedSlots?.length) return 0;

  // Group selected slots by scheduling-timezone day within the target week
  const byDay = new Map<string, TimeSlot[]>();
  for (const s of selectedSlots) {
    const start = s.startTime;
    if (
      SlotCalculationService.weekKey(start, schedulingTimezone) !==
      targetWeekKey
    )
      continue;
    const key = SlotCalculationService.dayKey(start, schedulingTimezone);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(s);
  }

  let completed = 0;
  byDay.forEach((daySlots) => {
    if (daySlots.length !== slotsPerCall) return;
    if (validateDayBasedConsecutiveSlots(daySlots, schedulingTimezone))
      completed += 1;
  });
  return completed;
}

/**
 * Subscription footer: Clear, action-oriented progress text
 * Removes confusing "past completed" concept and technical jargon
 */
function computeSubscriptionFooter(
  params: Readonly<{
    selectedSlots: TimeSlot[];
    allowedStart?: Date;
    allowedEnd?: Date;
    sessionsPerWeek?: number;
    sessionDurationInHours?: number;
    totalSessions?: number;
    pastCompletedSessions?: number;
  }>,
): string | null {
  const {
    selectedSlots,
    allowedStart,
    allowedEnd,
    sessionsPerWeek,
    sessionDurationInHours,
    totalSessions,
    pastCompletedSessions = 0,
  } = params;

  // Use totalSessions from plan (authoritative) to avoid calendar-week edge cases
  let maxTotalCalls: number;
  if (totalSessions && totalSessions > 0) {
    maxTotalCalls = totalSessions;
  } else {
    if (!allowedStart || !allowedEnd || !sessionsPerWeek) return null;
    const weeks = countSundayWeeksInclusive(allowedStart, allowedEnd);
    maxTotalCalls = weeks * sessionsPerWeek;
  }
  const slotsPerCall = getSlotsPerCall(sessionDurationInHours);
  const scheduled = Math.floor(selectedSlots.length / slotsPerCall);
  const totalScheduled = scheduled + pastCompletedSessions;
  const remaining = maxTotalCalls - totalScheduled;

  const duration = sessionDurationInHours || 1;
  const durationText = duration === 1 ? "1 hour" : `${duration} hours`;

  // Clear, user-friendly text based on progress
  if (pastCompletedSessions > 0 && scheduled === 0) {
    return `${pastCompletedSessions} past session${pastCompletedSessions !== 1 ? "s" : ""} completed | Schedule ${remaining} more (${durationText} each)`;
  } else if (pastCompletedSessions > 0 && remaining > 0) {
    return `✅ ${totalScheduled} of ${maxTotalCalls} (${pastCompletedSessions} past + ${scheduled} new) | ⏳ ${remaining} remaining`;
  } else if (scheduled === 0) {
    return `📅 Choose times for ${maxTotalCalls} sessions (${durationText} each)`;
  } else if (remaining > 0) {
    return `✅ ${scheduled} of ${maxTotalCalls} sessions scheduled • ${remaining} more to go`;
  } else {
    return `✅ All ${maxTotalCalls} sessions scheduled!`;
  }
}

/** Counts total completed class sessions across all selected slots. */
function countCompletedSelectedClasses(
  selectedSlots: TimeSlot[],
  slotsPerSession: number,
  schedulingTimezone?: string,
): number {
  if (!selectedSlots?.length) return 0;
  // Group by scheduling-timezone day and count full consecutive runs
  const byDay = new Map<string, TimeSlot[]>();
  for (const s of selectedSlots) {
    const key = SlotCalculationService.dayKey(s.startTime, schedulingTimezone);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(s);
  }
  let sessions = 0;
  byDay.forEach((daySlots) => {
    const sorted = [...daySlots].sort(
      (a, b) => a.startTime.getTime() - b.startTime.getTime(),
    );
    let run = 0;
    let lastEnd: number | null = null;
    for (const slot of sorted) {
      if (lastEnd !== null && slot.startTime.getTime() !== lastEnd) {
        sessions += Math.floor(run / slotsPerSession);
        run = 0;
      }
      run += 1;
      lastEnd = slot.endTime.getTime();
    }
    sessions += Math.floor(run / slotsPerSession);
  });
  return sessions;
}

/**
 * Class footer: Clear progress without technical jargon
 * Shows user-facing duration (hours) not implementation details (slots)
 */
function computeClassFooter(params: {
  selectedSlots: TimeSlot[];
  sessionDurationInHours?: number;
  totalSessions?: number;
  pastCompletedSessions?: number;
  schedulingTimezone?: string;
}): string {
  const {
    selectedSlots,
    sessionDurationInHours,
    totalSessions,
    pastCompletedSessions = 0,
    schedulingTimezone,
  } = params;
  const slotsPerSession = Math.ceil((sessionDurationInHours || 1) / 0.5);
  const scheduled = countCompletedSelectedClasses(
    selectedSlots,
    slotsPerSession,
    schedulingTimezone,
  );
  const totalScheduled = scheduled + pastCompletedSessions;

  const duration = sessionDurationInHours || 1;
  const durationText = duration === 1 ? "1 hour" : `${duration} hours`;

  if (typeof totalSessions === "number" && totalSessions > 0) {
    const remaining = totalSessions - totalScheduled;

    if (pastCompletedSessions > 0 && scheduled === 0) {
      return `${pastCompletedSessions} past session${pastCompletedSessions !== 1 ? "s" : ""} completed | Schedule ${remaining} more (${durationText} each)`;
    } else if (remaining > 0) {
      return pastCompletedSessions > 0
        ? `✅ ${totalScheduled} of ${totalSessions} (${pastCompletedSessions} past + ${scheduled} new) | ⏳ ${remaining} remaining`
        : `✅ ${scheduled} scheduled | ⏳ ${remaining} remaining (${durationText} each)`;
    } else {
      return `✅ All ${totalSessions} sessions scheduled`;
    }
  }

  // Fallback when total not known
  return `Sessions scheduled: ${totalScheduled}`;
}

export interface UnifiedCalendarProps {
  consultantId: string;
  eventType: "consultation" | "subscription" | "webinar" | "class";
  eventId?: string;
  durationInMonths?: number;
  durationInHours?: number; // For consultations/webinars
  sessionsPerWeek?: number;
  sessionDurationInHours?: number; // For subscriptions/classes - individual session duration
  /** The consultee this event belongs to. Passed to the availability fetch so
   * the grid hides times where THEY are already booked with another
   * consultant — allocation rejects those, so showing them green is a lie. */
  consulteeUserId?: string;
  mode: "view" | "select" | "allocate";
  onSlotsSelected?: (slots: TimeSlot[]) => void;
  onAllocationComplete?: (result: AllocationResponse) => void;
  /** Called when the server reports the event was already allocated in
   * another session (409) — host should close the dialog and refetch. */
  onAllocationConflict?: () => void;
  /** Reject allocations if the event already has confirmed slots (fresh
   * PENDING allocations only; reschedule hosts must not set this). */
  initialAllocation?: boolean;
  /** #1012 — tentative count captured when the allocate dialog opened. */
  expectedTentativeSlotCount?: number;
  onClose?: () => void;
  showAllocationButtons?: boolean;
  preSelectedSlots?: TimeSlot[];
  requestedSlots?: TimeSlot[];
  className?: string;
  // Optional hard boundaries to restrict interactive selection
  allowedStart?: Date;
  allowedEnd?: Date;
  totalSessions?: number; // Authoritative session count from plan (overrides weeks × sessionsPerWeek)
  /** Event's scheduling timezone — defines the limit day/week buckets
   * (ADR B9). Defaults to Asia/Kolkata in the shared helpers. */
  schedulingTimezone?: string;
  /**
   * Where to be looking on open (#1073). Applied ONCE, on first render of the
   * week grid: it chooses the starting week and scroll position and then
   * never touches either again.
   */
  focus?: SlotPickerFocus;
  /**
   * When true, SafeUnifiedCalendar shows the consultant legend (Selected /
   * Being moved / This booking). Defaults from mode === "allocate"; reschedule
   * propose surfaces set this explicitly while staying in select mode.
   */
  showConsultantLegend?: boolean;
}

export function UnifiedCalendar({
  consultantId,
  eventType,
  durationInHours,
  sessionDurationInHours,
  eventId,
  durationInMonths,
  sessionsPerWeek,
  consulteeUserId,
  mode = "view",
  onSlotsSelected,
  onAllocationComplete,
  onAllocationConflict,
  initialAllocation,
  expectedTentativeSlotCount,
  onClose,
  showAllocationButtons = false,
  preSelectedSlots = [],
  requestedSlots = [],
  className = "",
  allowedStart,
  allowedEnd,
  totalSessions,
  schedulingTimezone,
  focus,
}: UnifiedCalendarProps) {
  const { toast } = useToast();
  // State
  const [currentDate, setCurrentDate] = useState(() => {
    if (!focus) return new Date();
    // Noon on the target's calendar date AS THE GRID READS IT: weekDates are
    // derived from this with local date-fns, so a target near a midnight
    // boundary lands a week out if the date is read in any other zone.
    const { year, month, day } = focusGridPosition(focus.at, gridTimeZone());
    return new Date(year, month - 1, day, 12);
  });
  const [view, setView] = useState<"week" | "month">("week");
  const [browserTimezone, setBrowserTimezone] = useState("UTC");
  const [configWarning, setConfigWarning] = useState<string | null>(null);

  // Initialize timezone
  useEffect(() => {
    setBrowserTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  // Use calendar data hook
  const {
    consultantDetails,
    availableSlots,
    eventSlots,
    eventTentativeSlots = [],
    weeklyConfirmedCallCounts,
    loading,
    error,
    refetch,
    refetchEventSlots,
    refetchAvailability,
    getSlotStatusForInterval,
  } = useCalendarData({
    consultantId,
    eventType,
    eventId,
    currentDate,
    view,
    mode,
    allowedStart,
    allowedEnd,
    sessionDurationInHours,
    consulteeUserId,
    // Follows `mode` rather than being its own prop: "allocate" is the
    // consultant's own surface, the only one that renders the overlap
    // tooltips, and the only one the route authorizes for them. A consultee
    // picker is always "select", so it cannot forget to opt out and 403 its
    // entire calendar over a tooltip it never draws.
    includeAppointmentDetails: mode === "allocate",
  });

  // Wrap onAllocationComplete to refetch data before calling parent callback
  const handleAllocationSuccess = useCallback(
    async (result: AllocationResponse) => {
      try {
        // Refetch event slots (weeklyConfirmedCallCounts) and availability
        // (server-computed status grid/tooltips, #997 Phase 2) so newly
        // allocated slots appear correctly.
        await Promise.all([refetchEventSlots(), refetchAvailability()]);
      } catch (error) {
        Sentry.captureException(
          error instanceof Error ? error : new Error(String(error)),
          { tags: { subsystem: "client" } },
        );
        console.error(
          "Error refetching calendar data after allocation:",
          error,
        );
      }

      // Call parent callback
      onAllocationComplete?.(result);
    },
    [refetchEventSlots, refetchAvailability, onAllocationComplete],
  );

  // Count past confirmed event slots for in-progress recurring events
  const pastEventSlotCount = useMemo(() => {
    const now = new Date();
    return eventSlots.filter((s) => s.endTime <= now).length;
  }, [eventSlots]);

  // Slot allocation hook
  const {
    selectedSlots,
    setSelectedSlots,
    isAllocating,
    allocationError,
    isValid,
    validationErrors,
    requiredSlots,
    toggleSlot,
    clearSlots,
    isSlotSelected,
    manualAllocate,
    autoAllocate,
    allocateRequestedSlots,
    partialOffer,
    dismissPartialOffer,
    slotLimits,
  } = useEventSlotAllocation({
    eventType,
    eventId: eventId || "",
    consultantId,
    durationInMonths,
    durationInHours,
    sessionsPerWeek,
    sessionDurationInHours,
    startDate: allowedStart,
    endDate: allowedEnd,
    // Provide dynamic maxTotalCalls so validation/toasts show the real limit.
    // Prefer totalSessions from plan (authoritative) over calendar-week calculation.
    maxTotalCalls: isRecurringEventType(eventType)
      ? totalSessions && totalSessions > 0
        ? totalSessions
        : allowedStart && allowedEnd && sessionsPerWeek
          ? countSundayWeeksInclusive(allowedStart, allowedEnd) *
            (sessionsPerWeek || 1)
          : undefined
      : undefined,
    pastConfirmedSlotCount: isRecurringEventType(eventType)
      ? pastEventSlotCount
      : undefined,
    weeklyConfirmedCallCounts,
    initialAllocation,
    expectedTentativeSlotCount,
    schedulingTimezone,
    onSuccess: handleAllocationSuccess,
    onConflict: onAllocationConflict,
  });

  // Radix keeps AlertDialogContent mounted for its exit animation, and both
  // answers clear `partialOffer` before that finishes — so reading the counts
  // straight off it blanked the title to "Only of sessions fit" on the way out.
  // Hold the last offer for the render; `open` still tracks the live value.
  const lastPartialOffer = useRef(partialOffer);
  if (partialOffer) lastPartialOffer.current = partialOffer;
  const offer = partialOffer ?? lastPartialOffer.current;

  // PERFORMANCE: Pre-compute a Set of event slot timestamps (rounded to seconds)
  // for O(1) lookups. Replaces O(n) .some() scan that ran 336× per render.
  const eventSlotsSet = useMemo(
    () =>
      new Set(eventSlots.map((s) => Math.round(s.startTime.getTime() / 1000))),
    [eventSlots],
  );

  // This event's OWN tentative slots (being rescheduled). Rendered as a distinct
  // "Rescheduling" state — NOT the foreign "Booked" gray they used to fall into.
  const eventTentativeSlotsSet = useMemo(
    () =>
      new Set(
        eventTentativeSlots.map((s) =>
          Math.round(s.startTime.getTime() / 1000),
        ),
      ),
    [eventTentativeSlots],
  );

  // Initialize pre-selected slots
  // Compare by content to prevent infinite loops from parent re-renders creating new array references
  useEffect(() => {
    if (
      preSelectedSlots.length > 0 &&
      !areSlotsEqual(selectedSlots, preSelectedSlots)
    ) {
      setSelectedSlots(preSelectedSlots);
    }
  }, [preSelectedSlots, selectedSlots, setSelectedSlots]);

  // Call onSlotsSelected when the SELECTION changes — not when the parent
  // re-renders.
  //
  // The callback is held in a ref and kept out of the dependency array on
  // purpose. SlotPicker passes an inline arrow, so depending on
  // it meant a new identity every render: effect fires, parent setState,
  // re-render, new identity, fire again, forever — React error #185. Nothing
  // caught it because "select" is the consultee picker's mode and the picker
  // never mounted while consultantProfileId was resolving to null.
  //
  // A ref rather than asking callers to useCallback: a component that
  // infinite-loops when handed an inline arrow is a trap, and the sibling
  // preSelectedSlots effect above already had to defend against the same
  // class of bug by comparing contents.
  const onSlotsSelectedRef = useRef(onSlotsSelected);
  useEffect(() => {
    onSlotsSelectedRef.current = onSlotsSelected;
  });

  useEffect(() => {
    if (mode === "select") {
      onSlotsSelectedRef.current?.(selectedSlots);
    }
  }, [selectedSlots, mode]);

  // Set warning banner if duration configuration is missing
  useEffect(() => {
    if (eventType === "consultation" || eventType === "webinar") {
      if (!durationInHours || durationInHours <= 0) {
        setConfigWarning(
          `${eventType === "consultation" ? "Consultation" : "Webinar"} duration not configured. Using 1-hour default.`,
        );
      } else {
        setConfigWarning(null);
      }
    } else if (isRecurringEventType(eventType)) {
      if (!sessionDurationInHours || sessionDurationInHours <= 0) {
        setConfigWarning(
          `${eventType === "subscription" ? "Session" : "Class"} duration not configured. Using 1-hour default.`,
        );
      } else {
        setConfigWarning(null);
      }
    }
  }, [eventType, durationInHours, sessionDurationInHours]);

  // Week view dates. Deliberately LOCAL time: the grid renders in the
  // consultant's timezone. Limit BUCKETING is UTC (SlotCalculationService) —
  // do not "unify" these; display and bucketing are different concerns.
  const weekDates = useMemo(() => {
    const startDate = startOfWeek(currentDate);
    return [...Array(7)].map((_, i) => addDays(startDate, i));
  }, [currentDate]);

  // A callback ref in STATE, not a plain ref: the week grid does not exist
  // until `consultantDetails` has arrived, and a ref mutating cannot wake an
  // effect. Keyed off the element, the effect runs when the grid appears —
  // whichever of the two independent fetches wins the race, and again if the
  // user visits month view before the grid has ever been focused.
  const [weekGridEl, setWeekGridEl] = useState<HTMLDivElement | null>(null);
  // Once per open. A ref rather than effect deps: re-running this would drag
  // the grid back while the consultant is reading somewhere else, and the
  // callback-identity loop this component already hit (React #185, see
  // onSlotsSelectedRef) is what a deps-driven "focus" would become.
  const focusAppliedRef = useRef(false);

  useEffect(() => {
    if (!focus || focusAppliedRef.current || !weekGridEl) return;
    // The element's mere existence is the real guard: it renders only past
    // the `loading`/`error`/`consultantDetails` gates below, and `loading` is
    // held true from mount until the availability fetch settles — so by the
    // time there is a grid, `availableSlots` is final. (`loading` alone would
    // NOT do: it starts false, before anything is fetched.)
    if (weekGridEl.children.length === 0) return;
    // The user got here first. Leave them where they are, permanently.
    if (weekGridEl.scrollTop > 0) {
      focusAppliedRef.current = true;
      return;
    }

    const targetRow = focusTargetRow(focus, availableSlots, gridTimeZone());
    const row = weekGridEl.children[focusScrollRow(targetRow)];
    if (!(row instanceof HTMLElement)) return;

    focusAppliedRef.current = true;
    // Measured, not rowIndex × height: the row heights are a Tailwind detail
    // this component should not be re-deriving.
    weekGridEl.scrollTop +=
      row.getBoundingClientRect().top - weekGridEl.getBoundingClientRect().top;
  }, [focus, weekGridEl, availableSlots]);

  /**
   * Builds an auto-expanded group of consecutive slots starting from a clicked slot.
   * Strategy: forward → backward → mixed → fallback to single slot.
   */
  const buildAutoExpandGroup = useCallback(
    (clickedSlot: TimeSlot, clickedDate: Date): TimeSlot[] => {
      const targetSize = slotLimits.slotsPerSession;

      // No expansion needed for single-slot sessions
      if (!targetSize || targetSize <= 1) return [clickedSlot];

      const clickedLocalStart = new Date(clickedSlot.startTime);

      // Check if a candidate slot at a given offset is eligible for auto-expansion
      const getEligibleSlot = (offsetSteps: number): TimeSlot | null => {
        const offsetMs = offsetSteps * 30 * 60 * 1000;
        const targetTime = new Date(clickedLocalStart.getTime() + offsetMs);

        // Same-day constraint in the event's scheduling timezone — a session
        // must not straddle the limit-bucket day boundary (ADR B9).
        if (
          SlotCalculationService.dayKey(targetTime, schedulingTimezone) !==
          SlotCalculationService.dayKey(clickedLocalStart, schedulingTimezone)
        )
          return null;

        const interval = {
          hour: targetTime.getHours(),
          minute: targetTime.getMinutes(),
        };
        const status = getSlotStatusForInterval(interval, clickedDate);

        // Must be available, not booked, not in past
        if (!status.isAvailable || status.isBookedForDisplay || status.isInPast)
          return null;

        // Must not be already selected
        const candidateStartMs = new Date(
          status.intervalStartUTCString,
        ).getTime();
        if (
          selectedSlots.some((s) => s.startTime.getTime() === candidateStartMs)
        )
          return null;

        // Must be within allowed range
        if (allowedStart || allowedEnd) {
          const intervalStart = new Date(status.intervalStartUTCString);
          if (allowedStart && intervalStart < allowedStart) return null;
          if (allowedEnd && intervalStart >= allowedEnd) return null;
        }

        return {
          startTime: new Date(status.intervalStartUTCString),
          endTime: new Date(status.intervalEndUTCString),
          isAvailable: status.isAvailable,
          isBooked: status.isBooked,
        };
      };

      // Try forward expansion: clicked + N-1 forward slots
      const forwardGroup: TimeSlot[] = [clickedSlot];
      for (let step = 1; step < targetSize; step++) {
        const eligible = getEligibleSlot(step);
        if (!eligible) break;
        forwardGroup.push(eligible);
      }
      if (forwardGroup.length === targetSize) return forwardGroup;

      // Try backward expansion: N-1 backward slots + clicked
      const backwardGroup: TimeSlot[] = [clickedSlot];
      for (let step = 1; step < targetSize; step++) {
        const eligible = getEligibleSlot(-step);
        if (!eligible) break;
        backwardGroup.unshift(eligible);
      }
      if (backwardGroup.length === targetSize) return backwardGroup;

      // Try mixed: use forward slots + fill remaining from backward
      if (forwardGroup.length > 1 || backwardGroup.length > 1) {
        const mixedGroup: TimeSlot[] = [...forwardGroup];
        for (let step = 1; mixedGroup.length < targetSize; step++) {
          const eligible = getEligibleSlot(-step);
          if (!eligible) break;
          mixedGroup.unshift(eligible);
        }
        if (mixedGroup.length === targetSize) return mixedGroup;
      }

      // Fallback: single slot (degrades to manual selection)
      return [clickedSlot];
    },
    [
      slotLimits.slotsPerSession,
      getSlotStatusForInterval,
      selectedSlots,
      allowedStart,
      allowedEnd,
      schedulingTimezone,
    ],
  );

  // Handle slot click
  const handleSlotClick = useCallback(
    (interval: { hour: number; minute: number }, date: Date) => {
      if (mode === "view") return;

      const status = getSlotStatusForInterval(interval, date);

      const slot: TimeSlot = {
        startTime: new Date(status.intervalStartUTCString),
        endTime: new Date(status.intervalEndUTCString),
        isAvailable: status.isAvailable,
        isBooked: status.isBooked,
      };

      // Check if this slot belongs to the current event — O(1) via Set lookup
      const isCurrentEventSlot = eventSlotsSet.has(
        Math.round(slot.startTime.getTime() / 1000),
      );
      // This event's own slot currently being rescheduled (tentative).
      const isCurrentEventTentative = eventTentativeSlotsSet.has(
        Math.round(slot.startTime.getTime() / 1000),
      );

      // First-line guard: allow click but block selection with feedback if outside allowed range
      if (allowedStart || allowedEnd) {
        const intervalStart = new Date(status.intervalStartUTCString);
        if (isOutsideAllowedRange(intervalStart, allowedStart, allowedEnd)) {
          toast(
            outsideSchedulingWindow(
              formatAllowedRange(allowedStart, allowedEnd),
            ),
          );
          return;
        }
      }
      // Weekly limit guard for subscriptions: fire on FIRST slot of a new day.
      // Bucketed by the event's scheduling-timezone week (ADR B9) — the SAME
      // definition the server validates with.
      if (
        eventType === "subscription" &&
        eventId &&
        sessionsPerWeek &&
        sessionDurationInHours
      ) {
        const intervalStart = new Date(status.intervalStartUTCString);
        const targetDayKey = SlotCalculationService.dayKey(
          intervalStart,
          schedulingTimezone,
        );
        const isStartingNewDay = !selectedSlots.some(
          (s) =>
            SlotCalculationService.dayKey(s.startTime, schedulingTimezone) ===
            targetDayKey,
        );

        if (isStartingNewDay) {
          const targetWeekKey = SlotCalculationService.weekKey(
            intervalStart,
            schedulingTimezone,
          );
          const slotsPerCall = getSlotsPerCall(sessionDurationInHours);
          // #997 Phase 3 — server-precomputed confirmed-call count for this
          // week (bucketed with the SAME SlotCalculationService.weekKey the
          // server validator uses), fetched alongside eventSlots. Replaces
          // re-deriving this from a separate whole-window appointment fetch
          // on every slot click.
          const completedCalls = weeklyConfirmedCallCounts[targetWeekKey] || 0;

          // Also include already selected complete calls in this same week
          const selectedCompleted = countCompletedSelectedCallsForWeek(
            selectedSlots,
            slotsPerCall,
            targetWeekKey,
            schedulingTimezone,
          );
          const totalCompletedThisWeek = completedCalls + selectedCompleted;

          // sessionsPerWeek is guaranteed truthy by the enclosing guard
          if (totalCompletedThisWeek >= sessionsPerWeek) {
            toast(
              weeklyLimitReached(
                sessionsPerWeek,
                schedulingWeekBucket(intervalStart, schedulingTimezone),
              ),
            );
            return;
          }
        }
      }

      // Past "This Event" slots: allow deselection, block re-selection
      if (isCurrentEventSlot && status.isInPast) {
        const isCurrentlySelected = selectedSlots.some(
          (s) => s.startTime.getTime() === slot.startTime.getTime(),
        );
        if (isCurrentlySelected) {
          toggleSlot(slot);
          return;
        }
        toast(pastSessionBlocked());
        return;
      }

      // Imminent "This Event" slots (<24h away): block deselection
      if (isCurrentEventSlot && !status.isInPast) {
        const now = new Date();
        const imminentCutoff = new Date(
          now.getTime() + TWENTY_FOUR_HOURS_IN_MS,
        );
        if (slot.startTime < imminentCutoff) {
          toast(sessionTooSoon());
          return;
        }
      }

      // Block selection of unavailable, booked, or past non-event slots
      if (status.isInPast) {
        toast(pastSlotBlocked());
        return;
      }

      // This event's own tentative slot (being rescheduled) — NOT a foreign
      // booking. Don't show "already booked"; guide the consultant to pick a new
      // time. The old slot is freed when the re-allocation completes.
      if (isCurrentEventTentative) {
        toast(sessionBeingRescheduled());
        return;
      }

      // Allow current event slots to be toggled for rescheduling
      if (
        !isCurrentEventSlot &&
        (!status.isAvailable || status.isBookedForDisplay)
      ) {
        toast(slotUnavailable(Boolean(status.isBookedForDisplay)));
        return;
      }

      if (mode === "select" || mode === "allocate") {
        const isCurrentlySelected = selectedSlots.some(
          (s) => s.startTime.getTime() === slot.startTime.getTime(),
        );

        if (isCurrentlySelected) {
          // Deselect: hook's REMOVE path handles consecutive group detection
          toggleSlot(slot);
        } else {
          // Add: build auto-expanded consecutive group
          const expandedGroup = buildAutoExpandGroup(slot, date);

          // Block selection if we can't find enough consecutive slots for a complete session
          const requiredSlots = slotLimits.slotsPerSession;
          if (requiredSlots > 1 && expandedGroup.length < requiredSlots) {
            toast(notEnoughConsecutive(requiredSlots, expandedGroup.length));
            return;
          }

          toggleSlot(slot, expandedGroup);
        }
      }
    },
    [
      mode,
      getSlotStatusForInterval,
      toggleSlot,
      buildAutoExpandGroup,
      slotLimits,
      // Dependencies used inside the callback
      eventType,
      eventId,
      sessionsPerWeek,
      sessionDurationInHours,
      schedulingTimezone,
      allowedStart,
      allowedEnd,
      selectedSlots,
      weeklyConfirmedCallCounts,
      eventSlotsSet,
      eventTentativeSlotsSet,
      toast,
    ],
  );

  // Render time cell
  const renderTimeCell = useCallback(
    (interval: { hour: number; minute: number }, date: Date) => {
      const status = getSlotStatusForInterval(interval, date);

      const slot: TimeSlot = {
        startTime: new Date(status.intervalStartUTCString),
        endTime: new Date(status.intervalEndUTCString),
        isAvailable: status.isAvailable,
        isBooked: status.isBooked,
      };

      const isCurrentlySelected = isSlotSelected(slot);

      // Check if this slot belongs to the current event — O(1) via Set lookup
      const isCurrentEventSlot = eventSlotsSet.has(
        Math.round(slot.startTime.getTime() / 1000),
      );
      // This event's own slot being rescheduled (tentative) — distinct state.
      const isCurrentEventTentative = eventTentativeSlotsSet.has(
        Math.round(slot.startTime.getTime() / 1000),
      );

      // Check if slot is outside allowed period for subscriptions/classes
      const intervalStart = new Date(status.intervalStartUTCString);
      const intervalEnd = new Date(status.intervalEndUTCString);
      const isOutsideAllowedRange =
        (allowedStart && intervalEnd <= allowedStart) ||
        (allowedEnd && intervalStart >= allowedEnd);

      // Fast-exit: a cell with nothing published, nothing booked and already
      // past is never interactive, so it renders as a plain block instead of a
      // button. It paints from the same `unavailable` token as every other
      // dead cell — it used to be its own gray-100/gray-200 pair, which is how
      // past days and future days ended up disagreeing about what "nothing
      // here" looks like (#1064).
      if (!status.isAvailable && !status.isBooked && status.isInPast) {
        return (
          <div className={slotCellClassName("unavailable", { faded: true })} />
        );
      }

      const statusKey = resolveSlotStatusKey({
        isSelected: isCurrentlySelected,
        isThisEventSlot: isCurrentEventSlot,
        isRescheduling: isCurrentEventTentative,
        isBookedForDisplay: status.isBookedForDisplay,
        isPartiallyBooked: status.isPartiallyBooked,
        isAvailable: status.isAvailable,
        isInPast: status.isInPast,
      });
      // ONE token, appended once, on top of a base string that carries no
      // border-COLOUR. Every branch below adds cursor/opacity only — a second
      // border-color utility on this element is structurally impossible now,
      // which is what the reverted attempt got wrong (#1064).
      let cellClassName = slotCellClassName(statusKey);

      let buttonText = "";
      const showTooltip =
        ((status.isBookedForDisplay || status.isPartiallyBooked) &&
          status.overlappingAppointments.length > 0) ||
        isCurrentEventSlot;

      if (isCurrentlySelected) {
        cellClassName += " cursor-pointer";
        buttonText = SLOT_STATUS_TOKENS.selected.label;
      } else if (isCurrentEventSlot) {
        cellClassName += " cursor-pointer";
        cellClassName += status.isInPast ? " opacity-60" : "";
        buttonText = status.isInPast
          ? "Past session"
          : SLOT_STATUS_TOKENS.thisEvent.label;
      } else if (isCurrentEventTentative) {
        // THIS event's slot being rescheduled — distinct from the "Booked"
        // state used for foreign appointments below.
        cellClassName += " cursor-pointer";
        cellClassName += status.isInPast ? " opacity-50" : "";
        buttonText = SLOT_STATUS_TOKENS.rescheduling.label;
      } else if (status.isBookedForDisplay) {
        cellClassName += " cursor-pointer";
        cellClassName += status.isInPast ? " opacity-50" : "";
        buttonText = SLOT_STATUS_TOKENS.fullyBooked.label;
      } else if (status.isPartiallyBooked) {
        cellClassName += " cursor-pointer";
        cellClassName += status.isInPast ? " opacity-50" : "";
        buttonText = SLOT_STATUS_TOKENS.partiallyBooked.label;
      } else if (status.isAvailable) {
        if (status.isInPast) {
          // A past slot is NOT available, whatever the consultant published.
          // It used to render green and say "Available", differing from a real
          // opening only by opacity — so a picker opened on the current week
          // offered times that had already happened. Still clickable, because
          // the toast explains why; it just no longer claims to be bookable.
          cellClassName += " cursor-pointer";
          buttonText = isOutsideAllowedRange ? "Outside Period" : "Past";
        } else {
          cellClassName += " cursor-pointer";
          if (eventType === "consultation") {
            cellClassName += " hover:shadow-md";
          }
          buttonText = isOutsideAllowedRange
            ? "Outside Period"
            : SLOT_STATUS_TOKENS.available.label;
        }
      } else {
        // Genuinely unpublished interval — never carried button text, before
        // or after this change; only the colour source moved.
        cellClassName += " cursor-not-allowed";
        cellClassName += status.isInPast ? " opacity-70" : "";
      }

      // Only disable in view mode or if no availability at all (gray slots)
      const isButtonDisabled =
        mode === "view" || (!status.isAvailable && !status.isBooked);

      const buttonElement = (
        <button
          type="button"
          className={cellClassName}
          onClick={() => handleSlotClick(interval, date)}
          disabled={isButtonDisabled}
        >
          {buttonText}
        </button>
      );

      if (showTooltip) {
        return (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>{buttonElement}</TooltipTrigger>
              <TooltipContent
                className="max-w-xs text-xs"
                side="top"
                align="center"
              >
                <div className="flex flex-col gap-1">
                  {isCurrentEventSlot ? (
                    // Show current event details
                    <div>
                      <p className="font-semibold">This Event&apos;s Slot</p>
                      <p className="text-muted-foreground">
                        {eventType === "consultation"
                          ? "Consultation"
                          : eventType === "subscription"
                            ? "Subscription"
                            : eventType === "webinar"
                              ? "Webinar"
                              : "Class"}
                      </p>
                      <p className="text-muted-foreground text-[10px] mt-1">
                        {status.isInPast
                          ? "Past session (completed)"
                          : "Click to reschedule"}
                      </p>
                    </div>
                  ) : (
                    // Show overlapping appointments
                    status.overlappingAppointments.map(
                      (appSlot: AppointmentDetail, index: number) => (
                        <div
                          key={`${appSlot.id}-${index}`}
                          className="border-b border-border last:border-b-0 pb-1 mb-1 last:pb-0 last:mb-0"
                        >
                          <p className="font-semibold">{appSlot.title}</p>
                          <p className="text-muted-foreground">
                            {appSlot.type}
                          </p>
                          {appSlot.with && (
                            <p className="text-muted-foreground">
                              with {appSlot.with}
                            </p>
                          )}
                        </div>
                      ),
                    )
                  )}
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );
      }

      return buttonElement;
    },
    [
      getSlotStatusForInterval,
      isSlotSelected,
      handleSlotClick,
      mode,
      allowedStart,
      allowedEnd,
      eventType,
      eventSlotsSet,
      eventTentativeSlotsSet,
    ],
  );

  // Render month view
  const renderMonthView = useCallback(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDayOfMonth = new Date(year, month, 1).getDay();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const countAvailableSlotsForDay = (date: Date): number => {
      let count = 0;
      for (const interval of INTERVALS) {
        const status = getSlotStatusForInterval(interval, date);
        if (status.isAvailable && !status.isInPast) {
          count++;
        }
      }
      return count;
    };

    return (
      <div className="grid grid-cols-7 gap-1 flex-1 min-h-0 overflow-y-auto">
        {DAYS.map((day) => (
          <div key={day} className="text-center font-bold p-2">
            {day.slice(0, 3)}
          </div>
        ))}
        {Array.from({ length: firstDayOfMonth }, (_, i) => (
          <div
            key={`empty-start-${i}`}
            className="min-h-[100px] border bg-gray-50/50"
          />
        ))}
        {Array.from(
          { length: new Date(year, month + 1, 0).getDate() },
          (_, i) => {
            const date = new Date(year, month, i + 1);
            const isCurrentDay = isSameDay(date, now);
            const isPastDay = date < today;
            const availableCount = isPastDay
              ? 0
              : countAvailableSlotsForDay(date);

            return (
              <div
                key={date.toISOString()}
                className={`min-h-[100px] border p-1 flex flex-col ${
                  isCurrentDay ? "ring-2 ring-primary" : ""
                } ${isPastDay ? "bg-gray-100 text-gray-400" : "bg-white"}`}
              >
                <div
                  className={`font-bold mb-1 text-xs ${
                    isCurrentDay ? "text-primary" : ""
                  } ${isPastDay ? "" : "text-gray-700"}`}
                >
                  {i + 1}
                </div>
                <div className="flex-grow flex items-center justify-center">
                  {!isPastDay && availableCount > 0 && (
                    <Badge variant="outline" className="text-[10px] p-1">
                      {availableCount} slots
                    </Badge>
                  )}
                  {!isPastDay && availableCount === 0 && (
                    <span className="text-xs text-muted-foreground">
                      No Slots
                    </span>
                  )}
                </div>
              </div>
            );
          },
        )}
      </div>
    );
  }, [currentDate, getSlotStatusForInterval]);

  // Loading state — keep week-grid anatomy to avoid spinner → calendar CLS
  if (loading) {
    return <CalendarGridSkeleton className={className} />;
  }

  // Error state
  if (error) {
    return (
      <div className={`bg-red-50 p-4 rounded-md text-red-700 ${className}`}>
        <p>Error loading calendar: {error}</p>
        <Button variant="outline" size="sm" onClick={refetch} className="mt-2">
          <RotateCcw className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  // No consultant data
  if (!consultantDetails) {
    return (
      <div className={`text-center p-8 text-muted-foreground ${className}`}>
        <Calendar className="h-12 w-12 mx-auto mb-4 opacity-50" />
        <p>No calendar data available</p>
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-4 min-h-0 ${className}`}>
      {/* Warning Banner */}
      {configWarning && (
        <div className="shrink-0 rounded-md bg-yellow-50 border border-yellow-200 px-4 py-3">
          <div className="flex items-start">
            <span className="text-yellow-600 mr-2">⚠️</span>
            <div className="flex-1">
              <p className="text-sm font-medium text-yellow-800">
                Using Default Value
              </p>
              <p className="text-sm text-yellow-700">{configWarning}</p>
            </div>
          </div>
        </div>
      )}

      {/* Scheduling Period Info Banner */}
      {allowedStart && allowedEnd && (
        <div className="shrink-0 rounded-md bg-blue-50 border border-blue-200 px-4 py-3">
          <div className="flex items-start">
            <Calendar className="h-5 w-5 text-blue-600 mr-2 flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-blue-800">
                Scheduling Period
              </p>
              <p className="text-sm text-blue-700">
                {formatAllowedRange(allowedStart, allowedEnd)}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 sm:gap-4">
        <div className="flex gap-2">
          <Button
            variant={view === "week" ? "default" : "outline"}
            size="sm"
            onClick={() => setView("week")}
          >
            Week
          </Button>
          <Button
            variant={view === "month" ? "default" : "outline"}
            size="sm"
            onClick={() => setView("month")}
          >
            Month
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setCurrentDate(
                view === "week"
                  ? subWeeks(currentDate, 1)
                  : subMonths(currentDate, 1),
              )
            }
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 text-center text-sm font-bold sm:min-w-[150px] sm:text-lg">
            {view === "week"
              ? `${format(startOfWeek(currentDate), "MMM d")} - ${format(endOfWeek(currentDate), "MMM d, yyyy")}`
              : format(currentDate, "MMMM yyyy")}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setCurrentDate(
                view === "week"
                  ? addWeeks(currentDate, 1)
                  : addMonths(currentDate, 1),
              )
            }
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        {showAllocationButtons && mode === "allocate" ? (
          <Button
            variant="outline"
            size="sm"
            onClick={clearSlots}
            disabled={isAllocating || selectedSlots.length === 0}
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Clear Selection
          </Button>
        ) : (
          <div className="hidden w-20 sm:block"></div>
        )}
      </div>

      {/* Calendar View */}
      {view === "week" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Week header */}
          <div
            className={`shrink-0 ${GRID_COLS} gap-0.5 md:gap-1 bg-background z-20 pb-1`}
          >
            <div></div>
            {weekDates.map((date, index) => {
              const isToday = isSameDay(date, new Date());
              const isInPeriod = isDateInSchedulingPeriod(
                date,
                allowedStart,
                allowedEnd,
              );
              return (
                <div
                  key={DAYS[index]}
                  className={`text-center p-1 md:p-2 ${
                    isInPeriod ? "bg-blue-50 border-x-2 border-blue-200" : ""
                  }`}
                >
                  <div
                    className={`font-bold text-xs md:text-base ${
                      isToday ? "text-primary" : ""
                    }`}
                  >
                    {DAYS[index].slice(0, 3)}
                  </div>
                  <div className="text-xs md:text-sm text-muted-foreground">
                    {format(date, "d")}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Week grid */}
          <div
            ref={setWeekGridEl}
            className="flex-1 overflow-y-auto scrollbar-thin min-h-0"
          >
            {INTERVALS.map((interval) => (
              <div
                key={`interval-row-${interval.hour}-${interval.minute}`}
                className={`${GRID_COLS} gap-0.5 md:gap-1`}
              >
                <div className="min-w-0">
                  <div className="h-8 text-right pr-1 md:pr-2 pt-0.5 text-[10px] md:text-sm flex items-start justify-end whitespace-nowrap tabular-nums">
                    {new Date(
                      1970,
                      0,
                      1,
                      interval.hour,
                      interval.minute,
                    ).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </div>
                </div>
                {weekDates.map((date) => (
                  <div key={date.toISOString()} className="col-span-1">
                    {renderTimeCell(interval, date)}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : (
        renderMonthView()
      )}

      {/* Footer */}
      <div className="shrink-0 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex flex-wrap items-center gap-2 sm:gap-4">
          <div className="text-sm">
            {(() => {
              try {
                if (eventType === "subscription") {
                  const slotsPerCall = getSlotsPerCall(sessionDurationInHours);
                  const computed = computeSubscriptionFooter({
                    selectedSlots,
                    allowedStart,
                    allowedEnd,
                    sessionsPerWeek,
                    sessionDurationInHours,
                    totalSessions,
                    pastCompletedSessions:
                      pastEventSlotCount > 0
                        ? Math.floor(pastEventSlotCount / slotsPerCall)
                        : 0,
                  });
                  if (computed) return computed;
                  // Fallback to existing text if boundaries not provided
                  return calculateCallProgress(
                    selectedSlots,
                    sessionDurationInHours,
                    slotLimits.maxSlots,
                    schedulingTimezone,
                  );
                } else if (eventType === "class") {
                  const slotsPerSession = Math.ceil(
                    (sessionDurationInHours || 1) / 0.5,
                  );
                  return computeClassFooter({
                    selectedSlots,
                    sessionDurationInHours,
                    totalSessions: slotLimits.totalSessions,
                    pastCompletedSessions:
                      pastEventSlotCount > 0
                        ? Math.floor(pastEventSlotCount / slotsPerSession)
                        : 0,
                    schedulingTimezone,
                  });
                }

                const duration =
                  eventType === "consultation" || eventType === "webinar"
                    ? durationInHours
                    : sessionDurationInHours;

                const requiredSlotsForThisEvent = calculateRequiredSlots(
                  eventType,
                  durationInMonths,
                  sessionsPerWeek,
                  duration,
                );

                // Never "N slots": the 30-minute atom (ADR B1) is our
                // bookkeeping unit, not something a buyer should have to
                // translate. A one-hour consultation is ONE session, and
                // "2 required slots" reads as two appointments.
                const totalMinutes = requiredSlotsForThisEvent * 30;
                const chosenMinutes = selectedSlots.length * 30;
                if (chosenMinutes === 0)
                  return `Select a ${formatDurationLabel(totalMinutes)} time`;
                if (chosenMinutes >= totalMinutes)
                  return `${formatDurationLabel(totalMinutes)} selected`;
                return `${formatDurationLabel(chosenMinutes)} of ${formatDurationLabel(totalMinutes)} selected`;
              } catch (error) {
                Sentry.captureException(
                  error instanceof Error ? error : new Error(String(error)),
                  { tags: { subsystem: "client" } },
                );
                console.error("Error calculating footer stats:", error);
                if (error instanceof Error) {
                  return error.message;
                }
                return `Selected: ${selectedSlots.length} slots`;
              }
            })()}
          </div>
          {/* Only show weekly limit for subscriptions - other event types don't need secondary info */}
          {eventType === "subscription" && (
            <div className="text-xs text-muted-foreground">
              Max {sessionsPerWeek || 1} session
              {(sessionsPerWeek || 1) > 1 ? "s" : ""} per week
            </div>
          )}
          {allocationError && (
            <div className="text-sm text-red-600">{allocationError}</div>
          )}
        </div>

        <div className="text-sm text-muted-foreground">
          {/* #1076 — the day/week caps bucket on the EVENT's scheduling
              timezone, not the viewer's. When they differ, say so here
              instead of letting the viewer assume their own midnight. Only
              cap-bearing surfaces thread the prop; others keep the old line. */}
          {schedulingTimezone && schedulingTimezone !== browserTimezone
            ? `Times shown in ${browserTimezone} · Limits counted in ${schedulingTimezone}`
            : `Timezone: ${browserTimezone}`}
        </div>
      </div>

      {/* Allocation Buttons - Bottom */}
      {showAllocationButtons && mode === "allocate" && (
        <div className="mt-2 flex shrink-0 flex-wrap justify-end gap-2">
          {onClose && (
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={isAllocating}
            >
              Cancel
            </Button>
          )}

          <Button
            variant="default"
            size="sm"
            onClick={() => autoAllocate(availableSlots)}
            disabled={isAllocating}
          >
            <Zap className="h-4 w-4 mr-2" />
            Auto Allocate
          </Button>

          {requestedSlots.length > 0 && (
            <Button
              variant="default"
              size="sm"
              onClick={() => allocateRequestedSlots(requestedSlots)}
              disabled={isAllocating}
            >
              <Clock className="h-4 w-4 mr-2" />
              Use Requested Times
            </Button>
          )}

          <Button
            variant="default"
            size="sm"
            onClick={() => manualAllocate()}
            disabled={
              isAllocating ||
              !isValid ||
              selectedSlots.length === 0 ||
              selectedSlots.length !== requiredSlots
            }
            title={
              !isValid
                ? `Invalid selection: ${validationErrors.join(", ")}`
                : selectedSlots.length === 0
                  ? "Please select slots first"
                  : selectedSlots.length !== requiredSlots
                    ? `Need ${requiredSlots} slots, but ${selectedSlots.length} selected`
                    : "Allocate the selected slots"
            }
          >
            <Users className="h-4 w-4 mr-2" />
            {isAllocating ? "Allocating..." : "Allocate Manual Slots"}
          </Button>
        </div>
      )}

      {/* #1206 — auto-allocation found room for only part of the plan. The
          consultant decides between placing those sessions now and leaving the
          request unallocated until more availability exists; nothing is
          scheduled without this answer. */}
      <AlertDialog
        open={!!partialOffer}
        onOpenChange={(open) => {
          if (!open) dismissPartialOffer();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Only {offer?.placeableSessions} of {offer?.requiredSessions}{" "}
              sessions fit
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your published availability in this scheduling period can hold{" "}
              {offer?.placeableSessions} session
              {offer?.placeableSessions === 1 ? "" : "s"}. Schedule those now
              and leave the remaining{" "}
              {(offer?.requiredSessions ?? 0) - (offer?.placeableSessions ?? 0)}{" "}
              pending? The consultee is told how many are booked, and you can
              allocate the rest once you open up more time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isAllocating}>
              Not now
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isAllocating}
              onClick={(event) => {
                // The dialog must stay under the hook's control: closing it
                // here would drop the in-flight state the retry reports into.
                event.preventDefault();
                void autoAllocate(availableSlots, { allowPartial: true });
              }}
            >
              Schedule {offer?.placeableSessions} now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
