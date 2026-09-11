import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { reportSentryError } from "@/lib/observability/report";
import {
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  addDays,
  getDaysInMonth,
} from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { AllocationService } from "@/lib/scheduling/allocationService";
import { createAvailabilityPoller } from "@/lib/scheduling/availabilityPolling";
import { INTERVALS } from "@/utils/timeSlotsMeta";

/**
 * CALENDAR DATA SYNCHRONIZATION REFACTOR
 * =====================================
 *
 * PROBLEM SOLVED:
 * - Three calendar views (Settings, Expert Profile, Planner) showed inconsistent booking status
 * - Manual calculation logic in UnifiedCalendar didn't match server-calculated status
 * - Date filtering issues caused "stray booked slots" from different time periods
 * - Mixed TypeScript interfaces caused confusion and bugs
 *
 * SOLUTION:
 * - Unified data source: All calendars now use server-calculated `bookingStatus`
 * - Enhanced TypeScript interfaces with clear separation of concerns
 * - Optimized slot status calculation using raw availability data
 * - Proper date filtering and timezone handling
 */

// Enhanced TypeScript interfaces - FIXED: Replaced 'any' types with proper interfaces
export interface UseCalendarDataOptions {
  consultantId: string;
  eventType?: "consultation" | "subscription" | "webinar" | "class";
  eventId?: string;
  autoLoad?: boolean;
  view: "week" | "month";
  currentDate: Date;
  mode: "view" | "select" | "allocate";
  /** The scheduling period. It bounds what is SELECTABLE, enforced by the
   * calendar's own range guard; the fetch window follows the visible
   * week/month, so a cell outside the period still shows what is really
   * there rather than reading as absent. */
  allowedStart?: Date;
  allowedEnd?: Date;
  /** #997 Phase 3 — subscription per-call slot count, sent to the event-slots
   * fetch so the server can bucket `weeklyConfirmedCallCounts` the same way
   * the interactive weekly-limit guard needs it. Ignored for other event types. */
  sessionDurationInHours?: number;
  /** The user whose calendar is being booked. Allocation counts their bookings
   * with ANY consultant as occupied, so passing it keeps the grid from showing
   * cells that allocation will reject. */
  consulteeUserId?: string;
  /**
   * Request the per-interval tooltip metadata (title/participant of an
   * overlapping appointment). Defaults FALSE — the route 403s the request for
   * anyone who is not the owning consultant, so a surface that asks for it
   * speculatively loses its whole calendar rather than losing a tooltip.
   */
  includeAppointmentDetails?: boolean;
}

export interface TimeSlot {
  startTime: Date;
  endTime: Date;
  isAvailable: boolean;
  isBooked: boolean;
}

/** Minimal plan info shape for event types used in appointment title/status extraction */
interface EventPlanInfo {
  title?: string;
}

interface AppointmentConsultation {
  status?: string;
  consultationPlan?: EventPlanInfo;
  requestedBy?: { user?: { name?: string } };
}

interface AppointmentSubscription {
  id?: string;
  status?: string;
  subscriptionPlan?: EventPlanInfo;
  requestedBy?: { user?: { name?: string } };
}

interface AppointmentWebinar {
  status?: string;
  webinarPlan?: EventPlanInfo;
}

interface AppointmentClass {
  status?: string;
  classPlan?: EventPlanInfo;
}

interface AppointmentSlotRaw {
  startsAt: string;
  endsAt: string;
  isTentative?: boolean;
  user?: Array<{ name?: string }>;
}

interface Appointment {
  id: string;
  appointmentType: string;
  slotsOfAppointment?: AppointmentSlotRaw[];
  consultation?: AppointmentConsultation;
  subscription?: AppointmentSubscription;
  webinar?: AppointmentWebinar;
  class?: AppointmentClass;
}

interface ConsultantData {
  id: string;
  name: string;
  // Add other consultant properties as needed
}

/**
 * RAW SLOT DATA - Server-calculated booking status
 * BEFORE: Used manual calculation with date filtering issues
 * AFTER: Uses server-calculated `bookingStatus` field for consistency
 */
export interface RawSlotData {
  slotId: string;
  startsAt: string;
  endsAt: string;
  bookingStatus: "available" | "partially-booked" | "fully-booked"; // KEY: Server-calculated status
  type: "WEEKLY" | "CUSTOM";
  dayOfWeek?: string;
  localStartTime?: string;
  localEndTime?: string;
  /** #997 Phase 2 — server-precomputed tooltip metadata for this interval
   * (title/participant of any overlapping appointment). Only present because
   * fetchAvailabilitySlots requests `includeAppointmentDetails`. */
  overlappingAppointments?: Array<{
    id: string;
    type: string;
    title: string;
    with?: string;
  }>;
}

/**
 * SLOT STATUS RESULT - Enhanced with clear status flags
 * BEFORE: Confusing mix of isBooked, isConflicting, etc.
 * AFTER: Clear separation: isBookedForDisplay (gray), isPartiallyBooked (yellow)
 */
interface SlotStatusResult {
  isAvailable: boolean;
  isBooked: boolean; // For backwards compatibility
  isBookedForDisplay: boolean; // Fully booked (gray) - FIXED: Clear naming
  isPartiallyBooked: boolean; // Partially booked (yellow) - FIXED: Clear naming
  isDisabled: boolean;
  isInPast: boolean;
  intervalStartUTCString: string;
  intervalEndUTCString: string;
  localStartTime: Date;
  localEndTime: Date;
  overlappingAppointments: Array<{
    id: string;
    type: string;
    title: string;
    with?: string;
  }>;
}

interface CalendarData {
  consultantDetails: ConsultantData | null;
  availableSlots: TimeSlot[];
  rawAvailabilitySlots: {
    weekly: RawSlotData[];
    custom: RawSlotData[];
  };
  eventSlots: TimeSlot[];
  // This event's OWN tentative slots (being rescheduled) — rendered as a distinct
  // "Rescheduling" state, separate from confirmed eventSlots and foreign bookings.
  eventTentativeSlots: TimeSlot[];
  // #997 Phase 3 — confirmed (non-tentative) call counts for THIS event,
  // bucketed by scheduling-timezone week key (ADR B9). Server-computed
  // alongside eventSlots; replaces re-deriving this from a separate
  // whole-window appointment fetch on every slot click.
  weeklyConfirmedCallCounts: Record<string, number>;
  loading: boolean;
  error: string | null;
}

export interface UseCalendarDataReturn extends CalendarData {
  refetch: () => Promise<void>;
  refetchConsultant: () => Promise<void>;
  refetchAvailability: () => Promise<void>;
  refetchEventSlots: () => Promise<void>;
  getSlotStatusForInterval: (
    interval: { hour: number; minute: number },
    date: Date,
  ) => SlotStatusResult;
  slotStatusMap: Map<string, SlotStatusResult>;
}

/**
 * Enhanced calendar data hook with proper TypeScript interfaces and optimized data processing
 *
 * KEY IMPROVEMENTS:
 * 1. Uses server-calculated booking status instead of manual calculation
 * 2. Proper date filtering for appointments
 * 3. Enhanced TypeScript coverage
 * 4. Individual refetch functions for granular control
 * 5. Optimized performance with useCallback and useMemo
 */
export function useCalendarData(
  options: UseCalendarDataOptions,
): UseCalendarDataReturn {
  const {
    consultantId,
    eventType,
    eventId,
    autoLoad = true,
    view,
    currentDate,
    sessionDurationInHours,
    consulteeUserId,
    includeAppointmentDetails = false,
  } = options;
  const { toast } = useToast();

  // State management - ENHANCED: Better TypeScript coverage
  const [consultantDetails, setConsultantDetails] =
    useState<ConsultantData | null>(null);
  const [rawAvailabilitySlots, setRawAvailabilitySlots] = useState<{
    weekly: RawSlotData[];
    custom: RawSlotData[];
  }>({ weekly: [], custom: [] });
  const [eventSlots, setEventSlots] = useState<TimeSlot[]>([]);
  // The current event's OWN tentative slots (being rescheduled). Tracked
  // separately from eventSlots (confirmed) so the calendar can render them as a
  // distinct "Rescheduling" state instead of mislabeling them as foreign "Booked".
  const [eventTentativeSlots, setEventTentativeSlots] = useState<TimeSlot[]>([]);
  // #997 Phase 3 — see CalendarData.weeklyConfirmedCallCounts.
  const [weeklyConfirmedCallCounts, setWeeklyConfirmedCallCounts] = useState<
    Record<string, number>
  >({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Flicker fix — a fetch for week N can resolve after the user has already
  // navigated to week N+1 (no AbortController here). Only the response
  // matching the MOST RECENTLY issued request may commit state; a stale one
  // is silently dropped instead of repainting the wrong week.
  const availabilityRequestIdRef = useRef(0);
  // #1164 — when the last availability fetch was ISSUED (nav or poll), read
  // by the poll timer to schedule the next tick and by the return-to-tab
  // listeners to decide between refetch-now and re-arm.
  const availabilityFetchedAtRef = useRef(Number.NaN);
  // The availability fetch currently in flight, or null. A poll must not start
  // one while a NAVIGATION fetch is still running: the poll bumps the request
  // id, and the navigation's own `finally` is id-guarded, so it would skip its
  // `setLoading(false)` while the background request — which never touches
  // `loading` — leaves the grid on the skeleton for good. Above 60s of
  // response time that is the whole first load. The poll waits for it instead.
  const availabilityInFlightRef = useRef<Promise<void> | null>(null);
  // #1319 PR 9 — the last availability response's ETag, echoed back as
  // If-None-Match so an unchanged poll costs the server one indexed read and
  // this hook one early return. Not keyed by window: the tag itself encodes
  // the window and the viewer, so a tag from another week simply misses and
  // the route answers 200.
  const availabilityEtagRef = useRef<string | null>(null);

  // PERFORMANCE: Computed available slots from raw data using useMemo
  const availableSlots = useMemo((): TimeSlot[] => {
    const allRawSlots = [
      ...(rawAvailabilitySlots.weekly || []),
      ...(rawAvailabilitySlots.custom || []),
    ];

    return allRawSlots.map((slot: RawSlotData) => ({
      startTime: new Date(slot.startsAt),
      endTime: new Date(slot.endsAt),
      isAvailable:
        slot.bookingStatus === "available" ||
        slot.bookingStatus === "partially-booked",
      isBooked: slot.bookingStatus === "fully-booked",
    }));
  }, [rawAvailabilitySlots]);

  // PERFORMANCE: Data fetching functions with useCallback optimization
  const fetchConsultantDetails = useCallback(async (): Promise<void> => {
    if (!consultantId) return;

    try {
      const data = await AllocationService.fetchConsultantData(consultantId);
      setConsultantDetails(data);
    } catch (error) {
      console.error("Error fetching consultant details:", error);
      // Not captured here — AllocationService.fetchConsultantData already
      // reports this exact error (with httpStatus-based expected
      // classification) before rethrowing; a second capture here would only
      // add a worse, always-unexpected duplicate.
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Failed to fetch consultant data";
      setError(errorMessage);
      toast({
        variant: "destructive",
        title: "Error",
        description: errorMessage,
      });
    }
  }, [consultantId, toast]);

  // FIXED: Proper date range filtering for availability slots
  const fetchAvailabilitySlots = useCallback(async (
    options?: {
      /** A poll nobody asked for: report failure silently (see the catch). */
      background?: boolean;
      /** Skip the browser HTTP cache — the caller just changed the data. */
      fresh?: boolean;
    },
  ): Promise<void> => {
    if (!consultantId) return;

    const requestId = ++availabilityRequestIdRef.current;
    availabilityFetchedAtRef.current = Date.now();

    // Published so the poll can WAIT on this request instead of racing it.
    // Resolve-only, so a waiter's `finally` can never see a rejection.
    let settleInFlight: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      settleInFlight = resolve;
    });
    availabilityInFlightRef.current = inFlight;

    try {
      // The window is the VISIBLE range, never the scheduling period — at
      // either end. Starting at the view's own start is what lets a pre-period
      // week show the consultant's real availability behind an "Outside Period"
      // label instead of blank cells; the same argument governs the end, and
      // used not to. Clamping to `allowedEnd` left every cell past it with no
      // server row, and the route's slots-in-window filter drops the
      // APPOINTMENTS in that range too, so booked cells disappeared exactly
      // like available ones. One week further on the range inverted, the
      // server returned nothing, and the whole grid blanked.
      //
      // `allowedStart`/`allowedEnd` govern SELECTABILITY — the range guard in
      // `handleSlotClick` and the "Outside Period" label already enforce it —
      // and must never govern visibility. Capping an allocate request at one
      // week instead of the remainder of the period is also a direct win on
      // the endpoint #997 measured in tens of seconds.
      const startDate =
        view === "week" ? startOfWeek(currentDate) : startOfMonth(currentDate);
      const endDate =
        view === "week" ? endOfWeek(currentDate) : endOfMonth(currentDate);

      // #997 Phase 2 — the server-computed tooltip/orphan-slot detail. The
      // route re-verifies ownership regardless of this flag, and 403s rather
      // than downgrading, so only a surface that KNOWS it is the owning
      // consultant may ask for it.
      const data = await AllocationService.fetchAvailabilitySlots(
        consultantId,
        startDate,
        endDate,
        undefined,
        includeAppointmentDetails,
        consulteeUserId,
        options?.fresh,
        availabilityEtagRef.current,
      );

      // A newer request was issued (user moved on) while this one was in
      // flight — its result is stale, discard rather than repaint.
      if (requestId !== availabilityRequestIdRef.current) return;

      // #1319 PR 9 — 304: nothing this grid depends on moved. Keep the state
      // (and the tag) exactly as they are; calling setState with a fresh but
      // equal object would re-render every calendar cell for nothing.
      if (data?.notModified) return;

      // A shape the route cannot legitimately return. Emptying the grid on it
      // is the failure this change exists to remove: an empty grid is a valid
      // answer for a quiet week, so the consultant cannot tell it apart from a
      // broken response. Surface it instead.
      if (!data || typeof data !== "object") {
        setError("Could not read the availability response. Please try again.");
        return;
      }

      // Defensive: Ensure arrays exist and are valid
      const validatedData = {
        weekly: Array.isArray(data.weekly)
          ? data.weekly.filter((slot: RawSlotData) => {
              if (!slot || !slot.startsAt || !slot.endsAt) {
                console.warn(
                  "⚠️ fetchAvailabilitySlots: Filtering out invalid weekly slot",
                );
                return false;
              }
              return true;
            })
          : [],
        custom: Array.isArray(data.custom)
          ? data.custom.filter((slot: RawSlotData) => {
              if (!slot || !slot.startsAt || !slot.endsAt) {
                console.warn(
                  "⚠️ fetchAvailabilitySlots: Filtering out invalid custom slot",
                );
                return false;
              }
              return true;
            })
          : [],
      };

      // Stamped only once the body validated — a tag paired with a payload we
      // rejected would 304 the next poll into keeping the rejected state.
      availabilityEtagRef.current = data.etag ?? null;
      setRawAvailabilitySlots(validatedData);
    } catch (error) {
      // A stale request's failure must not clobber the error state of
      // whatever the user has since navigated to.
      if (requestId !== availabilityRequestIdRef.current) return;

      console.error("Error fetching availability slots:", error);
      // Not captured here — AllocationService.fetchAvailabilitySlots already
      // reports this exact error (see fetchConsultantDetails above).
      const errorMessage =
        error instanceof Error ? error.message : "Failed to fetch availability";
      // #1164 — a background poll failed: the grid still shows the last good
      // answer and the next tick retries, so neither the banner nor a toast is
      // the user's problem. A flaky minute would otherwise toast every 60s.
      if (options?.background) return;
      setError(errorMessage);
      toast({
        variant: "destructive",
        title: "Error",
        description: errorMessage,
      });
    } finally {
      // Clear only if no LATER request has taken the ref over — that one owns
      // it until it settles itself.
      if (availabilityInFlightRef.current === inFlight) {
        availabilityInFlightRef.current = null;
      }
      settleInFlight();
    }
  }, [
    consultantId,
    toast,
    view,
    currentDate,
    consulteeUserId,
    includeAppointmentDetails,
  ]);

  const fetchEventSlots = useCallback(async (): Promise<void> => {
    // Fetch event slots for ALL event types (subscription, consultation, webinar, class)
    // This allows the calendar to show "This Event" (black) instead of "Booked" (gray)
    // for slots belonging to the current event being viewed
    if (!eventType || !eventId) {
      setEventSlots([]);
      setEventTentativeSlots([]);
      setWeeklyConfirmedCallCounts({});
      return;
    }

    try {
      // #997 Phase 3 — pass slotsPerCall (subscriptions only) so the server
      // can also return weeklyConfirmedCallCounts alongside this event's slots.
      const slotsPerCall =
        eventType === "subscription"
          ? Math.ceil((sessionDurationInHours || 1) / 0.5)
          : undefined;
      const { data, weeklyConfirmedCallCounts: weeklyCounts } =
        await AllocationService.fetchEventSlots(
          eventType,
          eventId,
          consultantId,
          slotsPerCall,
        );
      setWeeklyConfirmedCallCounts(weeklyCounts);

      if (data && Array.isArray(data) && data.length > 0) {
        // Filter out cancelled/rejected appointments from event slots
        const activeData = data.filter((appt: Appointment) => {
          if (appt.consultation?.status) {
            if (
              ["REJECTED", "CANCELLED", "EXPIRED"].includes(
                appt.consultation.status,
              )
            )
              return false;
          }
          if (appt.subscription?.status) {
            if (
              ["REJECTED", "CANCELLED", "EXPIRED"].includes(
                appt.subscription.status,
              )
            )
              return false;
          }
          if (appt.webinar?.status === "CANCELLED") return false;
          if (appt.class?.status === "CANCELLED") return false;
          return true;
        });

        // Process ALL appointments, not just the first one, expanding each
        // appointment slot into 30-min display intervals.
        //
        // Confirmed slots → eventSlots ("This Event", black). Tentative slots
        // (the OLD slots being replaced during a reschedule) are tracked
        // SEPARATELY in eventTentativeSlots so the calendar can render them as a
        // distinct "Rescheduling" state. Previously tentative slots were simply
        // dropped here, so they fell through to the foreign-booking "Booked"
        // (gray) style — misleading, since they belong to THIS event.
        const confirmedSlots: TimeSlot[] = [];
        const tentativeSlots: TimeSlot[] = [];
        for (const appointment of activeData) {
          for (const slot of (appointment.slotsOfAppointment ||
            []) as AppointmentSlotRaw[]) {
            const start = new Date(slot.startsAt);
            const end = new Date(slot.endsAt);
            const durationMinutes =
              (end.getTime() - start.getTime()) / (1000 * 60);
            const numIntervals = Math.round(durationMinutes / 30);
            const target = slot.isTentative ? tentativeSlots : confirmedSlots;

            for (let i = 0; i < numIntervals; i++) {
              const intervalStart = new Date(
                start.getTime() + i * 30 * 60 * 1000,
              );
              const intervalEnd = new Date(
                intervalStart.getTime() + 30 * 60 * 1000,
              );
              target.push({
                startTime: intervalStart,
                endTime: intervalEnd,
                isAvailable: true,
                isBooked: true, // Event slots are considered booked/allocated
              });
            }
          }
        }
        setEventSlots(confirmedSlots);
        setEventTentativeSlots(tentativeSlots);
      } else {
        setEventSlots([]);
        setEventTentativeSlots([]);
      }
    } catch (error) {
      console.error("Error fetching event slots:", error);
      // Silent degrade to empty (no toast/setError, unlike the two siblings
      // above) — the calendar just shows no "This Event" slots, which reads
      // as "nothing booked yet" rather than "the fetch broke". Not captured
      // here either — AllocationService.fetchEventSlots already reports it.
      setEventSlots([]);
      setEventTentativeSlots([]);
      setWeeklyConfirmedCallCounts({});
    }
  }, [eventType, eventId, consultantId, sessionDurationInHours]);

  /**
   * PERFORMANCE: Compute visible dates for the current view so the slotStatusMap
   * can precompute statuses for every cell in a single pass.
   */
  const visibleDates = useMemo((): Date[] => {
    const dates: Date[] = [];
    if (view === "week") {
      const weekStart = startOfWeek(currentDate);
      for (let i = 0; i < 7; i++) {
        dates.push(addDays(weekStart, i));
      }
    } else {
      const monthStart = startOfMonth(currentDate);
      const daysInMonth = getDaysInMonth(currentDate);
      for (let i = 0; i < daysInMonth; i++) {
        dates.push(addDays(monthStart, i));
      }
    }
    return dates;
  }, [currentDate, view]);

  /**
   * #997 Phase 2 — the server (availability-with-allocation, requested with
   * includeAppointmentDetails) already returns bookingStatus AND
   * overlappingAppointments per 30-min interval. Index it ONCE by UTC ISO
   * start so every cell below is an O(1) lookup instead of the old
   * O(cells × (availabilitySlots + appointments)) cross-reference join.
   */
  const serverGridByISO = useMemo(() => {
    const map = new Map<string, RawSlotData>();
    const allRaw = [
      ...(rawAvailabilitySlots.weekly || []),
      ...(rawAvailabilitySlots.custom || []),
    ];
    for (const slot of allRaw) {
      map.set(new Date(slot.startsAt).toISOString(), slot);
    }
    return map;
  }, [rawAvailabilitySlots]);

  /**
   * Derives the cell's display status from ONE server grid lookup. The
   * server already resolved bookingStatus (incl. the "appointment with no
   * backing availability row" edge case via a synthesized fully-booked
   * entry, #997 Phase 2) — only past/disabled stay client-computed since
   * they depend on wall-clock "now", not on server-fetched data.
   */
  const deriveStatusFromServerGrid = useCallback(
    (localStart: Date, localEnd: Date, now: number): SlotStatusResult => {
      const serverSlot = serverGridByISO.get(localStart.toISOString());

      let isAvailable = false;
      let isBookedForDisplay = false;
      let isPartiallyBooked = false;
      let overlappingAppointments: SlotStatusResult["overlappingAppointments"] =
        [];

      if (serverSlot) {
        isAvailable = serverSlot.bookingStatus === "available";
        isBookedForDisplay = serverSlot.bookingStatus === "fully-booked";
        isPartiallyBooked = serverSlot.bookingStatus === "partially-booked";
        overlappingAppointments = serverSlot.overlappingAppointments || [];
      }

      const endMs = localEnd.getTime();
      const isInPast = endMs < now;
      const isDisabled = !isAvailable || isBookedForDisplay || isInPast;

      return {
        isAvailable,
        isBooked: isBookedForDisplay || isPartiallyBooked,
        isBookedForDisplay,
        isPartiallyBooked,
        isDisabled,
        isInPast,
        intervalStartUTCString: localStart.toISOString(),
        intervalEndUTCString: localEnd.toISOString(),
        localStartTime: localStart,
        localEndTime: localEnd,
        overlappingAppointments,
      };
    },
    [serverGridByISO],
  );

  /**
   * PERFORMANCE: Precompute slot status for every visible cell.
   * Converts 336 × O(W+C+A×S) → 1 index build + 336 × O(1) Map lookups.
   * Key format: `${year}-${month}-${day}-${hour}-${minute}`
   */
  const slotStatusMap = useMemo((): Map<string, SlotStatusResult> => {
    const map = new Map<string, SlotStatusResult>();
    const now = Date.now();

    for (const date of visibleDates) {
      const y = date.getFullYear();
      const m = date.getMonth();
      const d = date.getDate();

      for (const interval of INTERVALS) {
        const key = `${y}-${m}-${d}-${interval.hour}-${interval.minute}`;

        // Calculate interval boundaries in local time
        const localStart = new Date(
          y,
          m,
          d,
          interval.hour,
          interval.minute,
          0,
          0,
        );
        const localEnd = new Date(localStart.getTime() + 30 * 60 * 1000);

        map.set(key, deriveStatusFromServerGrid(localStart, localEnd, now));
      }
    }

    return map;
  }, [visibleDates, deriveStatusFromServerGrid]);

  /**
   * SLOT STATUS LOOKUP — O(1) via precomputed Map.
   * Falls back to inline computation for cells not in the visible range
   * (e.g. month view overflow days).
   */
  const getSlotStatusForInterval = useCallback(
    (
      interval: { hour: number; minute: number },
      date: Date,
    ): SlotStatusResult => {
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${interval.hour}-${interval.minute}`;
      const cached = slotStatusMap.get(key);
      if (cached) return cached;

      // Fallback for cells outside the precomputed visible range
      const localIntervalStartDate = new Date(date);
      localIntervalStartDate.setHours(interval.hour, interval.minute, 0, 0);
      const localIntervalEndDate = new Date(
        localIntervalStartDate.getTime() + 30 * 60 * 1000,
      );

      return deriveStatusFromServerGrid(
        localIntervalStartDate,
        localIntervalEndDate,
        Date.now(),
      );
    },
    [slotStatusMap, deriveStatusFromServerGrid],
  );

  // PERFORMANCE: Fetch all data function with parallel API calls
  const fetchAllData = useCallback(async (): Promise<void> => {
    if (!consultantId) return;

    setLoading(true);
    setError(null);

    try {
      // OPTIMIZATION: Parallel data fetching for better performance
      await Promise.all([
        fetchConsultantDetails(),
        fetchAvailabilitySlots(),
        fetchEventSlots(),
      ]);
    } catch (error) {
      console.error("Error fetching calendar data:", error);
      // Believed unreachable: the three awaited fetchers each self-catch and
      // never reject, so Promise.all here shouldn't throw. Capturing anyway
      // (not tagged expected) — if this ever fires, that invariant broke.
      reportSentryError(error, {
        subsystem: "client",
        tags: { feature: "scheduling-calendar" },
      });
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Failed to fetch calendar data";
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [consultantId, fetchConsultantDetails, fetchAvailabilitySlots, fetchEventSlots]);

  // PERFORMANCE: Split into two effects so date-independent fetches don't re-fire on week navigation.

  // Effect 1 — Date-independent: runs on dialog open only (consultantDetails + eventSlots)
  useEffect(() => {
    if (autoLoad && consultantId) {
      Promise.all([fetchConsultantDetails(), fetchEventSlots()]).catch(
        (error) => {
          console.error("Error fetching date-independent data:", error);
          // Believed unreachable — see fetchAllData's identical comment.
          reportSentryError(error, {
            subsystem: "client",
            tags: { feature: "scheduling-calendar" },
          });
          setError(
            error instanceof Error
              ? error.message
              : "Failed to fetch calendar data",
          );
        },
      );
    }
  }, [autoLoad, consultantId, fetchConsultantDetails, fetchEventSlots]);

  // Effect 2 — Date-dependent: runs on dialog open + week/month navigation
  const weeklySlotCount = rawAvailabilitySlots.weekly.length;
  useEffect(() => {
    if (autoLoad && consultantId) {
      // Only show loading spinner on initial load, not on background refetches
      const isInitialLoad =
        !consultantDetails && weeklySlotCount === 0;
      if (isInitialLoad) {
        setLoading(true);
      }
      setError(null);

      const pending = fetchAvailabilitySlots();
      // Read AFTER the call: the id is bumped synchronously, before the first
      // await, so this is that call's own id. Without it a stale reply's
      // `finally` clears the spinner a newer request is still waiting on —
      // the success and error paths are already guarded this way.
      const requestId = availabilityRequestIdRef.current;

      pending
        .catch((error) => {
          console.error("Error fetching date-dependent data:", error);
          // Believed unreachable — see fetchAllData's identical comment.
          reportSentryError(error, {
            subsystem: "client",
            tags: { feature: "scheduling-calendar" },
          });
          setError(
            error instanceof Error
              ? error.message
              : "Failed to fetch calendar data",
          );
        })
        .finally(() => {
          if (requestId !== availabilityRequestIdRef.current) return;
          setLoading(false);
        });
    }
    // consultantDetails/weeklySlotCount deliberately excluded: both are SET
    // BY this effect's own fetch, so listing them re-fires it every time the
    // fetch it just ran completes — a self-triggering refetch loop on every
    // week navigation (read via closure for isInitialLoad, not as triggers).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoad, consultantId, fetchAvailabilitySlots]);

  // Effect 3 — #1164 background freshness. The grid never refreshed after
  // open, so a slot booked elsewhere stayed green until the user navigated.
  // Poll the date-dependent availability (~60s), paused while the tab is
  // hidden, with an immediate refetch on a stale return (visibility/focus).
  // Polling, not push: the grid is a hint and allocation re-validates
  // server-side (see lib/scheduling/availabilityPolling.ts). A poll landing
  // after a navigation is discarded by the availabilityRequestIdRef guard in
  // fetchAvailabilitySlots, exactly like any other stale response.
  useEffect(() => {
    if (!autoLoad || !consultantId) return;
    if (typeof document === "undefined") return;

    // Timers + the two decisions live in lib/scheduling/availabilityPolling so
    // the loop can be driven by fake timers. Focus and visibilitychange BOTH
    // fire on a tab return; whichever runs first refetches and stamps
    // availabilityFetchedAtRef, so the second sees sub-floor staleness and only
    // re-arms (see shouldRefetchOnReturn).
    const poller = createAvailabilityPoller({
      // Read, not captured: the literal `true` this replaced made the gate a
      // dead branch that could never say no.
      isEnabled: () => Boolean(autoLoad && consultantId),
      visibilityState: () => document.visibilityState,
      msSinceLastFetch: () => Date.now() - availabilityFetchedAtRef.current,
      inFlight: () => availabilityInFlightRef.current,
      fetch: () => fetchAvailabilitySlots({ background: true }),
    });

    const onReturn = () => poller.onReturn();
    const onVisibilityChange = () => poller.onVisibilityChange();

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onReturn);
    poller.arm();

    return () => {
      poller.dispose();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onReturn);
    };
  }, [autoLoad, consultantId, fetchAvailabilitySlots]);

  // ENHANCEMENT: Individual refetch functions for granular control
  const refetchConsultant = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      await fetchConsultantDetails();
    } finally {
      setLoading(false);
    }
  }, [fetchConsultantDetails]);

  const refetchAvailability = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      // The explicit refetch is what runs after an allocation, so it must not
      // be answered from the 30s browser cache the route now permits (#1164).
      await fetchAvailabilitySlots({ fresh: true });
    } finally {
      setLoading(false);
    }
  }, [fetchAvailabilitySlots]);

  const refetchEventSlots = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      await fetchEventSlots();
    } finally {
      setLoading(false);
    }
  }, [fetchEventSlots]);

  return {
    // Data
    consultantDetails,
    availableSlots,
    rawAvailabilitySlots,
    eventSlots,
    eventTentativeSlots,
    weeklyConfirmedCallCounts,
    loading,
    error,

    // Actions - ENHANCEMENT: Granular refetch control
    refetch: fetchAllData,
    refetchConsultant,
    refetchAvailability,
    refetchEventSlots,
    getSlotStatusForInterval, // KEY: Unified slot status calculation
    slotStatusMap, // PERFORMANCE: Precomputed status map for O(1) lookups
  };
}
