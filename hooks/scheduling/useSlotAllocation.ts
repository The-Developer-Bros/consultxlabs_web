import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import * as Sentry from "@sentry/nextjs";
import { useToast } from "@/components/ui/use-toast";
import {
  TimeSlot,
  calculateRequiredSlots,
} from "@/lib/scheduling/calendarUtils";
import {
  AllocationAlgorithms,
  AllocationOptions,
  AllocationResult,
} from "@/lib/scheduling/allocationAlgorithms";
import { AllocationService } from "@/lib/scheduling/allocationService";
import { isRecurringEventType } from "@/utils/slotAllocation/types";
import {
  ValidationResult,
  EventConstraints,
  SlotLimits,
  getEventConstraints,
  getSlotLimits,
  validateEventSlots,
  groupSlotsByDay,
  countCompleteCallsInMap,
  isCompleteCall,
  countSessionsForDay,
  findConsecutiveGroupContaining,
  dayKey,
  weekKey,
} from "@/lib/scheduling/slotSelectionValidation";
import {
  AllocationToast,
  weeklyLimitReached,
  dailyLimitReached,
  oneSessionPerDay,
  sessionLimitReached,
  allSessionsSelected,
  completeSessionFirst,
  consecutiveRequired,
  invalidSelection,
  sessionAdded,
  keepGoing,
  timingsSaved,
  autoScheduled,
  partiallyScheduled,
  allocationFailed,
  allocationFailedWithCode,
  allocatedElsewhere,
  requestChangedElsewhere,
  isPreservedAllocationMessage,
  schedulingDayBucket,
  schedulingWeekBucket,
} from "@/lib/scheduling/allocationMessages";

/**
 * EVENT SLOT ALLOCATION HOOK
 * ==========================
 *
 * Unified interface for managing slot allocation across all event types.
 * Selection/validation rules live in utils/slotSelectionValidation (pure,
 * unit-tested, scheduling-timezone-bucketed to match the server, ADR B9); user-facing strings live
 * in utils/allocationMessages. This hook owns React state, toast queueing,
 * and the three allocation entry points (manual / auto / requested).
 */

export type { ValidationResult, EventConstraints, SlotLimits };

/**
 * Configuration options for the useEventSlotAllocation hook
 */
export interface UseEventSlotAllocationOptions {
  /** Event type - determines validation rules and constraints */
  eventType: "subscription" | "class" | "webinar" | "consultation";

  /** Unique identifier for the event */
  eventId: string;

  /** Consultant ID for availability checking */
  consultantId: string;

  /** Duration in months for subscriptions/classes (overall plan duration) */
  durationInMonths?: number;

  /** Duration in hours for consultations/webinars (single session duration) */
  durationInHours?: number;

  /** Session duration in hours for subscriptions (each individual session) */
  sessionDurationInHours?: number;

  /** Number of calls per week for subscriptions/classes */
  sessionsPerWeek?: number;

  /** Maximum hours per day for classes (default: 4) */
  maxHoursPerDay?: number;

  /** Maximum sessions per day for classes */
  maxSessionsPerDay?: number;

  /** Maximum calls per day for subscriptions (default: 1) */
  maxCallsPerDay?: number;

  /** Fixed total number of calls for subscriptions */
  maxTotalCalls?: number;

  /** Whether slots must be consecutive (required for webinars) */
  requireConsecutive?: boolean;

  /** Plan ID for fetching detailed plan information */
  planId?: string;

  /** Request status for filtering and validation */
  status?: "PENDING" | "APPROVED" | "REJECTED";

  /** Allocation method preference */
  allocationType?: "AUTO" | "MANUAL" | "REQUESTED";

  /** Consultant's schedule type (WEEKLY or CUSTOM) */
  scheduleType?: "WEEKLY" | "CUSTOM";

  /** Earliest allowed slot date */
  startDate?: Date;

  /** Latest allowed slot date */
  endDate?: Date;

  /** Number of confirmed past event slots (for in-progress recurring events) */
  pastConfirmedSlotCount?: number;

  /**
   * #997 Phase 3 — server-bucketed confirmed calls per scheduling-timezone
   * week key. Used so the interactive weekly-limit guard does not re-derive
   * aggregates from a whole-window appointment fetch on every click.
   */
  weeklyConfirmedCallCounts?: Record<string, number>;

  /** Preferred time slots (if any) */
  preferredTimeSlots?: TimeSlot[];

  /** Timezone for slot calculations */
  timezone?: string;

  /** Timezone defining the limit day/week buckets (ADR B9): the event's
   * schedulingTimezone. Defaults to Asia/Kolkata in the shared helpers. */
  schedulingTimezone?: string;

  /** Whether to allow weekend slots */
  allowWeekends?: boolean;

  /** Whether to allow evening slots */
  allowEvenings?: boolean;

  /** Whether to check for conflicts with existing appointments */
  checkConflicts?: boolean;

  /** Allow overriding conflicts */
  allowOverride?: boolean;

  /** Ask the server to 409 if the event already has confirmed slots.
   * Set by the requests dialog (fresh PENDING allocations); reschedule
   * flows must NOT set it — they legitimately re-allocate. */
  initialAllocation?: boolean;

  /** #1012 — reschedule stale-tab precondition (tentative count at dialog open). */
  expectedTentativeSlotCount?: number;

  /** Enable caching of availability data */
  enableCaching?: boolean;

  /** Success callback with allocation result */
  onSuccess?: (result: AllocationResult) => void;

  /** Error callback with error message */
  onError?: (error: string) => void;

  /** Called when the server reports the event was already allocated (409),
   * e.g. from another tab — the host should close the dialog and refetch. */
  onConflict?: () => void;

  /** Validation change callback */
  onValidationChange?: (isValid: boolean, result: ValidationResult) => void;

  /** Slot selection change callback */
  onSlotsChange?: (slots: TimeSlot[]) => void;
}

/**
 * Return interface for the useEventSlotAllocation hook
 */
export interface UseEventSlotAllocationReturn {
  /** Currently selected slots */
  selectedSlots: TimeSlot[];

  /** Set selected slots directly */
  setSelectedSlots: (slots: TimeSlot[]) => void;

  /** Whether allocation is in progress */
  isAllocating: boolean;

  /** Current allocation error message */
  allocationError: string | null;

  /** Whether current selection is valid */
  isValid: boolean;

  /** Detailed validation result */
  validationResult: ValidationResult;

  /** Number of slots required for this event */
  requiredSlots: number;

  /** Whether allocation can proceed */
  canAllocate: boolean;

  /** Current validation errors */
  validationErrors: string[];

  /** Current validation warnings */
  validationWarnings: string[];

  /** Event-specific constraints */
  eventConstraints: EventConstraints;

  /** Slot allocation limits */
  slotLimits: SlotLimits;

  /** Toggle slot selection with event-specific validation. Pass autoExpandedGroup to add/remove multiple consecutive slots at once. */
  toggleSlot: (slot: TimeSlot, autoExpandedGroup?: TimeSlot[]) => void;

  /** Clear all selected slots */
  clearSlots: () => void;

  /** Check if a slot is currently selected */
  isSlotSelected: (slot: TimeSlot) => boolean;

  /** Pre-computed Set of selected slot timestamps for O(1) lookups */
  selectedSlotsSet: Set<number>;

  /** Add multiple slots with validation */
  addSlots: (slots: TimeSlot[]) => void;

  /** Remove specific slots */
  removeSlots: (slots: TimeSlot[]) => void;

  /** Allocate using manually selected slots */
  manualAllocate: () => Promise<void>;

  /** Auto-allocate using available slots */
  autoAllocate: (
    availableSlots: TimeSlot[],
    options?: { allowPartial?: boolean },
  ) => Promise<void>;

  /**
   * #1206 — set when auto-allocation refused for want of availability but
   * COULD place some of the sessions. The host renders the confirm step; a
   * second `autoAllocate(slots, { allowPartial: true })` accepts it.
   */
  partialOffer: PartialAllocationOffer | null;

  /** Decline the partial placement and go back to an unallocated request. */
  dismissPartialOffer: () => void;

  /** Allocate using the consultee's requested slots (server "requested" mode) */
  allocateRequestedSlots: (requestedSlots: TimeSlot[]) => Promise<void>;

  /** Validate current slot selection */
  validateSlots: () => ValidationResult;

  /** Validate specific slots without selecting them */
  validateSlotsPreview: (slots: TimeSlot[]) => ValidationResult;

  /** Get event-specific constraints */
  getEventConstraints: () => EventConstraints;

  /** Get slot allocation limits */
  getSlotLimits: () => SlotLimits;

  /** Check if adding a slot would be valid */
  canAddSlot: (slot: TimeSlot) => boolean;
}

/**
 * #1206 — how much of the plan the server said it could place, in whole
 * sessions. `placeableSessions` is always > 0 here: a shortage that can place
 * nothing is a plain failure, not an offer.
 */
export interface PartialAllocationOffer {
  placeableSessions: number;
  requiredSessions: number;
}

// ============================================================================
// PURE HELPERS (exported for unit tests)
// ============================================================================

/**
 * Append a toast to the pending queue, dropping a consecutive duplicate
 * (also absorbs StrictMode double-invoked updaters).
 */
export function enqueueToast(
  queue: AllocationToast[],
  message: AllocationToast,
): AllocationToast[] {
  const last = queue[queue.length - 1];
  if (
    last?.title === message.title &&
    last?.description === message.description &&
    last?.variant === message.variant
  ) {
    return queue;
  }
  return [...queue, message];
}

export interface AllocationAttemptKey {
  fingerprint: string;
  key: string;
}

/**
 * Stable fingerprint of an allocation attempt. A retry of the SAME payload
 * keeps the same Idempotency-Key (the server replays the original batch);
 * any change to mode or slots gets a fresh key.
 */
export function computeAttemptFingerprint(
  mode: "manual" | "auto" | "requested",
  eventId: string,
  slots: TimeSlot[],
): string {
  const slotPart = slots
    .map((s) => s.startTime.toISOString())
    // Explicit code-unit compare — deterministic for ISO-8601 strings on
    // every runtime locale.
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join(",");
  return `${mode}|${eventId}|${slotPart}`;
}

let attemptKeyCounter = 0;

function generateIdempotencyKey(): string {
  // Feature-detect via optional access: lib.dom types every Crypto member as
  // present, so `"x" in crypto` narrowing collapses the else branch to never.
  const cryptoObj = typeof crypto !== "undefined" ? crypto : undefined;
  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID();
  }
  if (cryptoObj?.getRandomValues) {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // Ancient-runtime fallback: uniqueness (not secrecy) is all the key needs.
  attemptKeyCounter += 1;
  return `${Date.now()}-${attemptKeyCounter}`;
}

/**
 * Reuse the previous key when the fingerprint is unchanged (retry), otherwise
 * mint a new one.
 */
export function resolveAttemptKey(
  previous: AllocationAttemptKey | null,
  fingerprint: string,
): AllocationAttemptKey {
  if (previous?.fingerprint === fingerprint) {
    return previous;
  }
  return { fingerprint, key: generateIdempotencyKey() };
}

// ============================================================================
// MAIN HOOK IMPLEMENTATION
// ============================================================================

export function useEventSlotAllocation(
  options: UseEventSlotAllocationOptions,
): UseEventSlotAllocationReturn {
  const {
    eventType,
    eventId,
    consultantId: _consultantId,
    onSuccess,
    onError,
    onConflict,
    onValidationChange,
    onSlotsChange,
  } = options;

  const { toast } = useToast();

  // ==========================================
  // STATE MANAGEMENT
  // ==========================================

  const [selectedSlots, setSelectedSlots] = useState<TimeSlot[]>([]);
  const [isAllocating, setIsAllocating] = useState(false);
  const [allocationError, setAllocationError] = useState<string | null>(null);
  const [pendingToasts, setPendingToasts] = useState<AllocationToast[]>([]);
  const [partialOffer, setPartialOffer] =
    useState<PartialAllocationOffer | null>(null);
  const attemptKeyRef = useRef<AllocationAttemptKey | null>(null);
  const dismissPartialOffer = useCallback(() => setPartialOffer(null), []);

  /**
   * Toasts cannot fire inside a state updater, so they are queued and flushed
   * by an effect. The setTimeout keeps the updater pure; the queue (not a
   * single slot) means same-tick messages no longer clobber each other.
   */
  const queueToast = useCallback((message: AllocationToast) => {
    setTimeout(() => {
      setPendingToasts((queue) => enqueueToast(queue, message));
    }, 0);
  }, []);

  // ==========================================
  // COMPUTED VALUES
  // ==========================================

  // Event-specific constraints
  const eventConstraints = useMemo(
    () => getEventConstraints(eventType, options),
    [eventType, options],
  );

  // Slot allocation limits
  const slotLimits = useMemo(
    () => getSlotLimits(eventType, options),
    [eventType, options],
  );

  // Required slots calculation
  const requiredSlots = useMemo(() => {
    let rawRequired: number;

    // For subscriptions and classes, maxTotalCalls is set to the plan's totalSessions (authoritative).
    // Derive requiredSlots from it to stay consistent with backend validation.
    if (isRecurringEventType(eventType) && options.maxTotalCalls) {
      const slotsPerSession = Math.ceil(
        (options.sessionDurationInHours || 1) / 0.5,
      );
      rawRequired = options.maxTotalCalls * slotsPerSession;
    } else {
      // Use the appropriate duration field based on event type
      const duration =
        eventType === "consultation" || eventType === "webinar"
          ? options.durationInHours
          : options.sessionDurationInHours;

      rawRequired = calculateRequiredSlots(
        eventType,
        options.durationInMonths,
        options.sessionsPerWeek,
        duration,
        options.startDate,
        options.endDate,
      );
    }

    // For in-progress classes/subscriptions, subtract past confirmed slots so
    // the consultant only needs to select FUTURE slots.
    const pastCount = options.pastConfirmedSlotCount || 0;
    if (isRecurringEventType(eventType) && pastCount > 0) {
      return Math.max(0, rawRequired - pastCount);
    }

    return rawRequired;
  }, [
    eventType,
    options.maxTotalCalls,
    options.durationInMonths,
    options.sessionsPerWeek,
    options.durationInHours,
    options.sessionDurationInHours,
    options.startDate,
    options.endDate,
    options.pastConfirmedSlotCount,
  ]);

  // Current validation result
  const validationResult = useMemo(
    () =>
      validateEventSlots(
        selectedSlots,
        eventType,
        eventConstraints,
        slotLimits,
        options,
      ),
    [selectedSlots, eventType, eventConstraints, slotLimits, options],
  );

  // Whether current selection is valid
  const isValid = validationResult.isValid;

  // Whether allocation can proceed
  const canAllocate = isValid && selectedSlots.length === requiredSlots;

  // Validation errors and warnings
  const validationErrors = validationResult.errors;
  const validationWarnings = validationResult.warnings;

  // ==========================================
  // EFFECT HOOKS
  // ==========================================

  // Notify parent of validation changes
  useEffect(() => {
    if (onValidationChange) {
      onValidationChange(isValid, validationResult);
    }
  }, [isValid, validationResult, onValidationChange]);

  // Notify parent of slot changes
  useEffect(() => {
    if (onSlotsChange) {
      onSlotsChange(selectedSlots);
    }
  }, [selectedSlots, onSlotsChange]);

  // Clear allocation error when slots change
  useEffect(() => {
    if (allocationError) {
      setAllocationError(null);
    }
  }, [selectedSlots, allocationError]);

  // Flush queued toast notifications in order
  useEffect(() => {
    if (pendingToasts.length > 0) {
      pendingToasts.forEach((message) => toast(message));
      setPendingToasts([]);
    }
  }, [pendingToasts, toast]);

  // ==========================================
  // ALLOCATION FAILURE HANDLING
  // ==========================================

  /** Common failure path: 409 means another tab/session already allocated —
   * UNLESS the message says a SLOT was taken (#1132): that request is still
   * allocatable with different times, so the server's own message renders
   * as itself and the dialog stays open (no onConflict tear-down). */
  const handleAllocationFailure = useCallback(
    (result: AllocationResult, fallback: string) => {
      const errorMessage = result.error || fallback;
      setAllocationError(errorMessage);
      const isStaleReschedule =
        result.httpStatus === 409 &&
        /reschedule state changed in another session/i.test(errorMessage);
      if (
        result.httpStatus === 409 &&
        !isPreservedAllocationMessage(errorMessage) &&
        !isStaleReschedule
      ) {
        toast(allocatedElsewhere());
        onConflict?.();
      } else if (isStaleReschedule) {
        // #1012 — the tentative count changed in another tab (a reschedule
        // finished/started there). The dialog must close + refresh because
        // the page's view of the booking is stale.
        toast(requestChangedElsewhere());
        onConflict?.();
      } else if (
        result.httpStatus === 409 &&
        isPreservedAllocationMessage(errorMessage)
      ) {
        // Slot conflict — the dialog stays open, the server's own message
        // renders as itself (#1132).
        toast(allocationFailed(errorMessage));
      } else {
        // PR 2c resilience — cause-specific toast from the structured code
        // (NO_AVAILABILITY → "No availability published", PERIOD_ENDED →
        // "The scheduling period has ended", SLOT_SHORTAGE → "Not enough
        // free slots"). Falls back to the generic copy for unknown codes.
        toast(allocationFailedWithCode(errorMessage, result.errorCode));
      }
      onError?.(errorMessage);
    },
    [toast, onConflict, onError],
  );

  // ==========================================
  // SLOT MANAGEMENT FUNCTIONS
  // ==========================================

  /**
   * Toggle slot selection with event-specific validation
   */
  const toggleSlot = useCallback(
    (slot: TimeSlot, autoExpandedGroup?: TimeSlot[]) => {
      setSelectedSlots((current) => {
        // Safety check to ensure current is always an array
        const currentSlots = current || [];

        const isSelected = currentSlots.some(
          (s) => s.startTime.getTime() === slot.startTime.getTime(),
        );

        if (isSelected) {
          // Remove the entire consecutive group containing this slot
          const removalDayKey = dayKey(
            slot.startTime,
            options.schedulingTimezone,
          );
          const daySlots = currentSlots
            .filter(
              (s) =>
                dayKey(s.startTime, options.schedulingTimezone) ===
                removalDayKey,
            )
            .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

          const group = findConsecutiveGroupContaining(slot, daySlots);
          const removeTimestamps = new Set(
            group.map((s) => s.startTime.getTime()),
          );
          return currentSlots.filter(
            (s) => !removeTimestamps.has(s.startTime.getTime()),
          );
        } else {
          // Add slot(s) with event-specific limits
          const slotsToAdd =
            autoExpandedGroup && autoExpandedGroup.length > 0
              ? autoExpandedGroup
              : [slot];
          const newSelection = [...currentSlots, ...slotsToAdd];

          // Subscription: weekly-limit and complete-call guards
          if (eventType === "subscription") {
            const slotsPerCall = slotLimits.slotsPerSession;
            const sessionsPerWeek = options.sessionsPerWeek || 1;

            // Determine week/day for the slot being added
            const targetWeekKey = weekKey(
              slot.startTime,
              options.schedulingTimezone,
            );
            const targetDayKey = dayKey(
              slot.startTime,
              options.schedulingTimezone,
            );

            // Build state BEFORE adding this slot
            const currentWeekSlots = currentSlots.filter(
              (s) =>
                weekKey(s.startTime, options.schedulingTimezone) ===
                targetWeekKey,
            );

            // Group by day for the current week (pre-add)
            const preSlotsByDay = groupSlotsByDay(
              currentWeekSlots,
              options.schedulingTimezone,
            );

            // Count complete calls already in this week (pre-add), plus
            // server-confirmed calls for the same week key (#997 Phase 3).
            let completeCallsThisWeek =
              options.weeklyConfirmedCallCounts?.[targetWeekKey] || 0;
            preSlotsByDay.forEach((daySlots) => {
              if (isCompleteCall(daySlots, slotsPerCall))
                completeCallsThisWeek++;
            });

            const preDaySlots = preSlotsByDay.get(targetDayKey) || [];

            // If starting a NEW day and weekly limit already reached → block immediately
            if (
              preDaySlots.length === 0 &&
              completeCallsThisWeek >= sessionsPerWeek
            ) {
              queueToast(
                weeklyLimitReached(
                  sessionsPerWeek,
                  schedulingWeekBucket(
                    slot.startTime,
                    options.schedulingTimezone,
                  ),
                ),
              );
              return currentSlots;
            }

            // If continuing the same day, block if completing this call would exceed weekly limit
            if (
              preDaySlots.length > 0 &&
              isCompleteCall([...preDaySlots, slot], slotsPerCall) &&
              completeCallsThisWeek >= sessionsPerWeek
            ) {
              queueToast(
                weeklyLimitReached(
                  sessionsPerWeek,
                  schedulingWeekBucket(
                    slot.startTime,
                    options.schedulingTimezone,
                  ),
                ),
              );
              return currentSlots;
            }

            // Count total complete calls across ALL weeks for newSelection (post-add)
            const totalCompleteCalls = countCompleteCallsInMap(
              groupSlotsByDay(newSelection, options.schedulingTimezone),
              slotsPerCall,
            );

            const maxTotalCalls = slotLimits.maxSlots;

            // If this slot would complete a call, check total limits
            const slotsByDayPost = groupSlotsByDay(
              newSelection,
              options.schedulingTimezone,
            );
            const potentialDaySlots = [
              ...(slotsByDayPost.get(targetDayKey) || []),
            ];

            if (isCompleteCall(potentialDaySlots, slotsPerCall)) {
              // Count total complete calls *after* this slot is added; if it
              // exceeds the max, this completion is the problem.
              if (totalCompleteCalls > maxTotalCalls) {
                queueToast(sessionLimitReached(maxTotalCalls));
                return currentSlots;
              }
            }
          } else if (eventType === "class") {
            // Class-specific interactive guards
            const slotsPerSession = slotLimits.slotsPerSession;
            const targetDayKey = dayKey(
              slot.startTime,
              options.schedulingTimezone,
            );

            // Group current selection by day (pre-add)
            const preByDay = groupSlotsByDay(
              currentSlots,
              options.schedulingTimezone,
            );

            // Detect any in-progress class (day not multiple of slotsPerSession)
            const incompleteDays = Array.from(preByDay.entries())
              .filter(([, daySlots]) => daySlots.length % slotsPerSession !== 0)
              .map(([key]) => key);

            if (
              incompleteDays.length > 0 &&
              !incompleteDays.includes(targetDayKey)
            ) {
              queueToast(completeSessionFirst());
              return currentSlots;
            }

            // If adding on the incomplete day, ensure consecutiveness
            if (incompleteDays.includes(targetDayKey)) {
              const daySlots = preByDay.get(targetDayKey) || [];
              const sorted = [...daySlots].sort(
                (a, b) => a.startTime.getTime() - b.startTime.getTime(),
              );
              if (sorted.length > 0) {
                const firstSlot = sorted[0];
                const lastSlot = sorted[sorted.length - 1];
                const isConsecutiveBefore =
                  slot.endTime.getTime() === firstSlot.startTime.getTime();
                const isConsecutiveAfter =
                  slot.startTime.getTime() === lastSlot.endTime.getTime();
                if (!isConsecutiveBefore && !isConsecutiveAfter) {
                  queueToast(consecutiveRequired());
                  return currentSlots;
                }
              }
            }

            // Enforce max classes per day when starting a new class on that day
            const daySlots = preByDay.get(targetDayKey) || [];
            const maxSessionsPerDay = options.maxSessionsPerDay || 2;
            const { sessions } = countSessionsForDay(daySlots, slotsPerSession);
            const isStartingNewSessionOnDay =
              daySlots.length % slotsPerSession === 0;
            if (isStartingNewSessionOnDay && sessions >= maxSessionsPerDay) {
              queueToast(
                dailyLimitReached(
                  maxSessionsPerDay,
                  schedulingDayBucket(
                    slot.startTime,
                    options.schedulingTimezone,
                  ),
                ),
              );
              return currentSlots;
            }
          } else if (
            newSelection.length >
            slotLimits.maxSlots - (options.pastConfirmedSlotCount || 0)
          ) {
            // Validate against slot limits for other event types (adjusted for past slots)
            queueToast(allSessionsSelected());
            return currentSlots;
          }

          // Event-specific validation for interactive selection
          const validation = validateEventSlots(
            newSelection,
            eventType,
            eventConstraints,
            slotLimits,
            options,
          );

          // Only show error for serious validation issues, not warnings
          if (!validation.isValid && validation.errors.length > 0) {
            const isMinSlotIssue = validation.errors.some(
              (error) =>
                error.includes("slots required") ||
                error.includes("Need") ||
                error.includes("more slots"),
            );

            if (!isMinSlotIssue) {
              queueToast(invalidSelection(validation.errors[0]));
              return currentSlots;
            }
          }

          // Subscription: per-day consecutiveness and progress feedback
          if (eventType === "subscription" && options.sessionDurationInHours) {
            const slotsPerCall = slotLimits.slotsPerSession;
            const sessionsPerWeek = options.sessionsPerWeek || 1;
            const maxTotalCalls = slotLimits.maxSlots;

            const slotsByDay = groupSlotsByDay(
              newSelection,
              options.schedulingTimezone,
            );

            // Confirmed calls per week WITHOUT the new slot.
            // Seed from `weeklyConfirmedCallCounts` (server truth for sessions
            // already allocated this week) — the earlier weekly-limit block
            // already does; this sibling block used to count only `currentSlots`
            // and under-reported progress toasts on partially confirmed weeks.
            const existingSlotsByDay = groupSlotsByDay(
              currentSlots,
              options.schedulingTimezone,
            );
            const existingWeeklyConfirmedCallCounts = new Map<string, number>(
              Object.entries(options.weeklyConfirmedCallCounts ?? {}),
            );
            existingSlotsByDay.forEach((daySlots) => {
              if (
                daySlots.length === slotsPerCall &&
                isCompleteCall(daySlots, slotsPerCall)
              ) {
                const wk = weekKey(
                  daySlots[0].startTime,
                  options.schedulingTimezone,
                );
                existingWeeklyConfirmedCallCounts.set(
                  wk,
                  (existingWeeklyConfirmedCallCounts.get(wk) || 0) + 1,
                );
              }
            });

            const targetWeekKey = weekKey(
              slot.startTime,
              options.schedulingTimezone,
            );
            const targetDayKey = dayKey(
              slot.startTime,
              options.schedulingTimezone,
            );

            // Get current day slots plus the new slot
            const dayWithNewSlot = [...(slotsByDay.get(targetDayKey) || [])];

            // Block if adding this slot COMPLETES a call and the week is already at its sessionsPerWeek limit
            const existingCallsThisWeek =
              existingWeeklyConfirmedCallCounts.get(targetWeekKey) || 0;
            if (
              dayWithNewSlot.length === slotsPerCall &&
              isCompleteCall(dayWithNewSlot, slotsPerCall) &&
              existingCallsThisWeek >= sessionsPerWeek
            ) {
              queueToast(
                weeklyLimitReached(
                  sessionsPerWeek,
                  schedulingWeekBucket(
                    slot.startTime,
                    options.schedulingTimezone,
                  ),
                ),
              );
              return currentSlots;
            }

            // Check daily call limit BEFORE adding the new slot
            const currentDaySlots = currentSlots.filter(
              (selectedSlot) =>
                dayKey(selectedSlot.startTime, options.schedulingTimezone) ===
                targetDayKey,
            );

            // Check if adding this slot would exceed the per-call limit
            if (currentDaySlots.length >= slotsPerCall) {
              queueToast(
                oneSessionPerDay(
                  schedulingDayBucket(
                    slot.startTime,
                    options.schedulingTimezone,
                  ),
                ),
              );
              return currentSlots;
            }

            // If we have existing slots for this day, check if the new slot would be consecutive
            if (currentDaySlots.length > 0) {
              const sortedDaySlots = [...currentDaySlots].sort(
                (a, b) => a.startTime.getTime() - b.startTime.getTime(),
              );

              const lastSlot = sortedDaySlots[sortedDaySlots.length - 1];
              const firstSlot = sortedDaySlots[0];

              // New slot should be either immediately before the first slot or after the last slot
              const isConsecutiveBefore =
                slot.endTime.getTime() === firstSlot.startTime.getTime();
              const isConsecutiveAfter =
                slot.startTime.getTime() === lastSlot.endTime.getTime();

              if (!isConsecutiveBefore && !isConsecutiveAfter) {
                queueToast(consecutiveRequired());
                return currentSlots;
              }
            }

            // Show progress feedback
            const completedCalls = Math.floor(
              newSelection.length / slotsPerCall,
            );
            const currentCallProgress = newSelection.length % slotsPerCall;

            if (currentCallProgress === 0 && newSelection.length > 0) {
              queueToast(sessionAdded(completedCalls, maxTotalCalls));
            } else {
              queueToast(
                keepGoing(
                  slotsPerCall - currentCallProgress,
                  completedCalls + 1,
                ),
              );
            }
          }

          const sortedSelection = [...newSelection];
          sortedSelection.sort(
            (a, b) => a.startTime.getTime() - b.startTime.getTime(),
          );
          return sortedSelection;
        }
      });
    },
    [eventType, eventConstraints, slotLimits, options, queueToast],
  );

  /**
   * Clear all selected slots
   */
  const clearSlots = useCallback(() => {
    setSelectedSlots([]);
    setAllocationError(null);
  }, []);

  /**
   * PERFORMANCE: Pre-compute a Set of selected slot timestamps for O(1) lookups.
   */
  const selectedSlotsSet = useMemo(
    () => new Set(selectedSlots.map((s) => s.startTime.getTime())),
    [selectedSlots],
  );

  /**
   * Check if a slot is currently selected — O(1) via Set lookup
   */
  const isSlotSelected = useCallback(
    (slot: TimeSlot) => {
      return selectedSlotsSet.has(slot.startTime.getTime());
    },
    [selectedSlotsSet],
  );

  /**
   * Add multiple slots with validation
   */
  const addSlots = useCallback(
    (slots: TimeSlot[]) => {
      const newSelection = [...selectedSlots, ...slots];
      const validation = validateEventSlots(
        newSelection,
        eventType,
        eventConstraints,
        slotLimits,
        options,
      );

      if (validation.isValid) {
        const sortedNewSelection = [...newSelection];
        sortedNewSelection.sort(
          (a, b) => a.startTime.getTime() - b.startTime.getTime(),
        );
        setSelectedSlots(sortedNewSelection);
      } else {
        queueToast(
          invalidSelection(validation.errors[0] || "Invalid slot selection"),
        );
      }
    },
    [
      selectedSlots,
      eventType,
      eventConstraints,
      slotLimits,
      options,
      queueToast,
    ],
  );

  /**
   * Remove specific slots
   */
  const removeSlots = useCallback((slotsToRemove: TimeSlot[]) => {
    const removeTimestamps = new Set(
      slotsToRemove.map((slot) => slot.startTime.getTime()),
    );

    setSelectedSlots((current) =>
      current.filter((slot) => !removeTimestamps.has(slot.startTime.getTime())),
    );
  }, []);

  // ==========================================
  // ALLOCATION METHODS
  // ==========================================

  /**
   * Allocate using manually selected slots
   */
  const manualAllocate = useCallback(async () => {
    if (!isValid) {
      const errorMessage = validationErrors[0] || "Invalid slot selection";
      setAllocationError(errorMessage);
      onError?.(errorMessage);
      return;
    }

    setIsAllocating(true);
    setAllocationError(null);

    try {
      const sessionDuration =
        eventType === "consultation" || eventType === "webinar"
          ? options.durationInHours
          : options.sessionDurationInHours;

      const attempt = resolveAttemptKey(
        attemptKeyRef.current,
        computeAttemptFingerprint("manual", eventId, selectedSlots),
      );
      attemptKeyRef.current = attempt;

      const allocationOptions: AllocationOptions = {
        eventType,
        eventId,
        durationInMonths: options.durationInMonths,
        sessionsPerWeek: options.sessionsPerWeek,
        sessionDurationInHours: sessionDuration,
        startDate: options.startDate,
        endDate: options.endDate,
        totalSessions: options.maxTotalCalls, // maxTotalCalls is already totalSessions-aware
        pastConfirmedSlotCount: options.pastConfirmedSlotCount,
        schedulingTimezone: options.schedulingTimezone,
        idempotencyKey: attempt.key,
        initialAllocation: options.initialAllocation || undefined,
        expectedTentativeSlotCount: options.expectedTentativeSlotCount,
      };

      const result = await AllocationAlgorithms.manualAllocate(
        selectedSlots,
        allocationOptions,
      );

      if (result.success) {
        toast(timingsSaved());
        onSuccess?.(result);
      } else {
        handleAllocationFailure(result, "Manual allocation failed");
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Allocation failed";
      setAllocationError(errorMessage);
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        {
          tags: { subsystem: "client", feature: "slot-allocation" },
          extra: { eventType, mode: "manual" },
        },
      );
      toast(allocationFailed(errorMessage));
      onError?.(errorMessage);
    } finally {
      setIsAllocating(false);
    }
  }, [
    selectedSlots,
    isValid,
    validationErrors,
    eventType,
    eventId,
    options,
    onSuccess,
    onError,
    toast,
    handleAllocationFailure,
  ]);

  /**
   * Auto-allocate using available slots
   */
  const autoAllocate = useCallback(
    // #997 Phase 1 — auto-allocation runs SERVER-side (isAuto mode: Redis
    // locks, tz-aware caps, initialAllocation guard, idempotent replay).
    // The old path fetched the consultant's entire scheduling period of
    // availability into the browser and ran AllocationAlgorithms here.
    // The parameter is kept for interface stability with UnifiedCalendar.
    async (
      _availableSlots: TimeSlot[],
      // #1206 — the second attempt, sent only after the consultant answered
      // the "only N of M fit" confirm.
      allocateOptions?: { allowPartial?: boolean },
    ) => {
      setIsAllocating(true);
      setAllocationError(null);
      setPartialOffer(null);

      try {
        // Slots are picked server-side, so the fingerprint covers mode +
        // event only: a double-click replays, a later re-run (after a
        // failure changed nothing) also replays, which is safe either way.
        const attempt = resolveAttemptKey(
          attemptKeyRef.current,
          computeAttemptFingerprint("auto", eventId, []),
        );
        attemptKeyRef.current = attempt;

        const response = await AllocationService.allocateSlots(
          eventType,
          eventId,
          [],
          {
            isAuto: true,
            idempotencyKey: attempt.key,
            initialAllocation: options.initialAllocation || undefined,
            expectedTentativeSlotCount: options.expectedTentativeSlotCount,
            allowPartial: allocateOptions?.allowPartial,
          },
        );

        if (response.success) {
          // Reflect the server's picks on the grid (best-effort — the host
          // closes the dialog via onSuccess either way).
          const pickedSlots: TimeSlot[] = (response.data ?? [])
            .flatMap(
              (appointment) =>
                (appointment.slotsOfAppointment as
                  | { startsAt: string; endsAt: string }[]
                  | undefined) ?? [],
            )
            .map((slot) => ({
              startTime: new Date(slot.startsAt),
              endTime: new Date(slot.endsAt),
              isAvailable: true,
              isBooked: false,
            }));
          if (pickedSlots.length > 0) {
            setSelectedSlots(pickedSlots);
          }
          // #1206 — "all sessions scheduled" would be a lie on a partial run.
          toast(
            response.partial
              ? partiallyScheduled(
                  response.placedSessions ?? pickedSlots.length,
                  response.requiredSessions ?? 0,
                )
              : autoScheduled(),
          );
          onSuccess?.({
            success: true,
            selectedSlots: pickedSlots,
            strategy: "server-auto",
          });
        } else {
          // #1206 — a shortage that could still place SOMETHING is a question
          // for the consultant, not a dead end. The offer replaces the toast
          // on the first attempt only; answering it re-runs with allowPartial
          // and any failure then reports normally.
          const placeable = response.placeableSessions ?? 0;
          const required = response.requiredSessions ?? 0;
          if (
            !allocateOptions?.allowPartial &&
            response.errorCode === "SLOT_SHORTAGE" &&
            placeable > 0 &&
            required > placeable
          ) {
            setPartialOffer({
              placeableSessions: placeable,
              requiredSessions: required,
            });
            return;
          }
          handleAllocationFailure(
            {
              success: false,
              selectedSlots: [],
              error: response.error,
              httpStatus: response.httpStatus,
              errorCode: response.errorCode,
            },
            "Auto allocation failed",
          );
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Auto allocation failed";
        setAllocationError(errorMessage);
        Sentry.captureException(
          error instanceof Error ? error : new Error(String(error)),
          {
            tags: { subsystem: "client", feature: "slot-allocation" },
            extra: { eventType, mode: "auto" },
          },
        );
        toast(allocationFailed(errorMessage));
        onError?.(errorMessage);
      } finally {
        setIsAllocating(false);
      }
    },
    [
      eventType,
      eventId,
      options,
      onSuccess,
      onError,
      toast,
      handleAllocationFailure,
    ],
  );

  /**
   * Allocate using the consultee's requested slots (server "requested" mode).
   */
  const allocateRequestedSlots = useCallback(
    async (requestedSlots: TimeSlot[]) => {
      setIsAllocating(true);
      setAllocationError(null);

      try {
        const sessionDuration =
          eventType === "consultation" || eventType === "webinar"
            ? options.durationInHours
            : options.sessionDurationInHours;

        const attempt = resolveAttemptKey(
          attemptKeyRef.current,
          computeAttemptFingerprint("requested", eventId, requestedSlots),
        );
        attemptKeyRef.current = attempt;

        const allocationOptions: AllocationOptions = {
          eventType,
          eventId,
          durationInMonths: options.durationInMonths,
          sessionsPerWeek: options.sessionsPerWeek,
          sessionDurationInHours: sessionDuration,
          startDate: options.startDate,
          endDate: options.endDate,
          // Parity with manual/auto: honor plan totals and in-progress
          // reschedules — the requested path previously skipped both.
          totalSessions: options.maxTotalCalls,
          pastConfirmedSlotCount: options.pastConfirmedSlotCount,
          requestedSlots,
          schedulingTimezone: options.schedulingTimezone,
          idempotencyKey: attempt.key,
          initialAllocation: options.initialAllocation || undefined,
          expectedTentativeSlotCount: options.expectedTentativeSlotCount,
        };

        const result =
          await AllocationAlgorithms.allocateRequestedSlots(allocationOptions);

        if (result.success) {
          setSelectedSlots(result.selectedSlots);
          toast(timingsSaved());
          onSuccess?.(result);
        } else {
          handleAllocationFailure(result, "Requested-slots allocation failed");
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : "Requested-slots allocation failed";
        setAllocationError(errorMessage);
        Sentry.captureException(
          error instanceof Error ? error : new Error(String(error)),
          {
            tags: { subsystem: "client", feature: "slot-allocation" },
            extra: { eventType, mode: "requested" },
          },
        );
        toast(allocationFailed(errorMessage));
        onError?.(errorMessage);
      } finally {
        setIsAllocating(false);
      }
    },
    [
      eventType,
      eventId,
      options,
      onSuccess,
      onError,
      toast,
      handleAllocationFailure,
    ],
  );

  // ==========================================
  // VALIDATION FUNCTIONS
  // ==========================================

  /**
   * Validate current slot selection (strict validation for final allocation)
   */
  const validateSlots = useCallback(() => {
    const result = validateEventSlots(
      selectedSlots,
      eventType,
      eventConstraints,
      slotLimits,
      options,
    );

    // For final validation, enforce minimum slot count
    if (selectedSlots.length < slotLimits.minSlots) {
      result.isValid = false;
      if (!result.errors.some((e) => e.includes("Minimum"))) {
        result.errors.unshift(
          `Minimum ${slotLimits.minSlots} slots required, ${selectedSlots.length} selected`,
        );
      }
    }

    return result;
  }, [selectedSlots, eventType, eventConstraints, slotLimits, options]);

  /**
   * Validate specific slots without selecting them (interactive validation)
   */
  const validateSlotsPreview = useCallback(
    (slots: TimeSlot[]) => {
      return validateEventSlots(
        slots,
        eventType,
        eventConstraints,
        slotLimits,
        options,
      );
    },
    [eventType, eventConstraints, slotLimits, options],
  );

  // ==========================================
  // EVENT-SPECIFIC HELPERS
  // ==========================================

  const getEventConstraintsHelper = useCallback(() => {
    return eventConstraints;
  }, [eventConstraints]);

  const getSlotLimitsHelper = useCallback(() => {
    return slotLimits;
  }, [slotLimits]);

  /**
   * Check if adding a slot would be valid
   */
  const canAddSlot = useCallback(
    (slot: TimeSlot) => {
      const testSelection = [...selectedSlots, slot];
      const validation = validateEventSlots(
        testSelection,
        eventType,
        eventConstraints,
        slotLimits,
        options,
      );
      return validation.isValid;
    },
    [selectedSlots, eventType, eventConstraints, slotLimits, options],
  );

  // ==========================================
  // RETURN HOOK INTERFACE
  // ==========================================

  return {
    // State management
    selectedSlots,
    setSelectedSlots,
    isAllocating,
    allocationError,
    isValid,
    validationResult,

    // Computed values
    requiredSlots,
    canAllocate,
    validationErrors,
    validationWarnings,
    eventConstraints,
    slotLimits,

    // Slot management functions
    toggleSlot,
    clearSlots,
    isSlotSelected,
    selectedSlotsSet,
    addSlots,
    removeSlots,

    // Allocation methods
    manualAllocate,
    autoAllocate,
    allocateRequestedSlots,
    partialOffer,
    dismissPartialOffer,

    // Validation functions
    validateSlots,
    validateSlotsPreview,

    // Event-specific helpers
    getEventConstraints: getEventConstraintsHelper,
    getSlotLimits: getSlotLimitsHelper,
    canAddSlot,
  };
}
