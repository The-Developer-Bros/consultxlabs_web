/**
 * Shared types for the unified slot allocation system
 *
 * This file consolidates all types used across allocation services to ensure
 * consistency and reduce duplication.
 */

/**
 * Allocation modes supported by the system
 */
export type AllocationMode = "auto" | "manual" | "requested";

/**
 * Event types that can be allocated
 */
export type EventType = "consultation" | "subscription" | "webinar" | "class";

/**
 * Event types that are recurring (have multiple sessions over time).
 * Used to guard past-session subtraction, reallocation logic, etc.
 */
export const RECURRING_EVENT_TYPES: ReadonlyArray<EventType> = [
  "class",
  "subscription",
] as const;

/** Type-safe check for whether an event type is recurring */
export function isRecurringEventType(eventType: string): boolean {
  return (RECURRING_EVENT_TYPES as ReadonlyArray<string>).includes(eventType);
}

/**
 * Request structure for slot allocation
 */
export interface AllocationRequest {
  eventType: EventType;
  eventId: string;
  mode: AllocationMode;
  slots?: string[]; // ISO date strings for manual allocation
  // #837 — client-supplied dedupe key (Idempotency-Key header). A double-submit
  // carrying the same key returns the first batch instead of allocating twice.
  idempotencyKey?: string;
  // Multi-tab guard — when true, reject (409) if the event already has
  // confirmed slots instead of replacing them. Auto and manual take different
  // Redis lock keys (#860), so a cross-mode race from two tabs otherwise ends
  // in the manual path silently deleting the winner's allocation.
  initialAllocation?: boolean;
  /**
   * #1012 — reschedule stale-tab guard. When set, the current tentative slot
   * count must match exactly; otherwise another tab already completed (or
   * mutated) the reschedule and this submit would delete+recreate confirmed
   * slots. Fresh allocations omit the field.
   */
  expectedTentativeSlotCount?: number;
  /**
   * Manual mode only. When true the Redis lock is taken consultant-WIDE rather
   * than sharded by the target day.
   *
   * #860 shards the manual key so allocations on different days for one
   * consultant run in parallel, with #440's GiST constraint backstopping
   * overlap. But GiST only prevents time OVERLAP — per-day and per-week caps
   * are validated by COUNTING, so two sharded allocations can each read the
   * same count and both add, taking a 4-session week to 5. Callers that place
   * times a human did not pick per-day (auto-confirm) must set this.
   */
  wideLock?: boolean;
  /**
   * Consultant's explicit acceptance of times outside their own published
   * availability. Routes must only set this for the consultant or a privileged
   * caller — a consultee cannot wave away the consultant's schedule.
   */
  override?: boolean;
  /**
   * #1206 — place every session that FITS instead of refusing the whole
   * allocation when the window cannot hold them all. Off by default: a partial
   * schedule is the consultant's explicit decision, taken after the shortfall
   * has been shown to them. Only recurring events (subscription, class) can be
   * partial — a consultation or webinar is one session, so it either fits or
   * it does not.
   */
  allowPartial?: boolean;
  /**
   * #1206 — place ONLY the sessions an earlier partial allocation left
   * unplaced, treating every confirmed appointment as fixed. Off by default
   * because the ordinary auto path is a re-plan: it deletes what exists and
   * lays the whole schedule out again. That is right for a reschedule and
   * catastrophic for an event whose earlier sessions are already booked and
   * paid. Honoured only for a recurring event that already has confirmed
   * sessions and no reschedule in flight; every other shape falls through to
   * today's behaviour unchanged.
   */
  topUp?: boolean;
  /**
   * #1340 — the reschedule proposal this allocation IS the confirmation of.
   *
   * Placing replacement times supersedes every OTHER open proposal on the same
   * released slots, so the allocator closes those as DECLINED. The confirming
   * caller's own proposal used to be in that set: it was DECLINED inside the
   * allocator's transaction, and the caller's following
   * `PENDING_REVIEW → AUTO_ACCEPTED/ACCEPTED` CAS then matched zero rows. The
   * booking had moved while its audit trail read "declined", auto-confirm
   * reported `autoConfirmed: false`, and the explicit accept answered 409 with
   * no MOVED notification. Set only by the two confirmation callers.
   */
  excludeRescheduleRequestId?: string;
}

/**
 * Result of validation check
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Result of slot conflict checking — shared across all 4 event validate API routes,
 * the allocationService utility, and the RequestedSlotsDialog component.
 *
 * Routes with extra fields (subscription, class, dialog) extend this base.
 */
export interface SlotConflictResult {
  conflicts: Array<{
    slot: string;
    existingAppointment: {
      type: string;
      with: string;
      time: string;
    };
  }>;
  outsideAvailability: Array<{
    slot: string;
  }>;
  validSlots: string[];
}

/**
 * Structured error codes for allocation failures.
 * Routes use this instead of string-prefix checks to determine HTTP status.
 */
export type AllocationErrorCode =
  | "VALIDATION_ERROR" // bad input from caller — 400
  | "NOT_FOUND" // event/consultant missing — 400
  | "INVALID_MODE" // unknown allocation mode — 400
  | "LOCK_CONTENTION" // Redis lock busy — 409
  | "ILLEGAL_TRANSITION" // event left the approvable state mid-allocation (#836) — 409
  | "PROGRAM_CAP_EXHAUSTED" // org's per-cycle overage ceiling vetoed it — 402
  | "NO_AVAILABILITY" // consultant has no published availability — 400
  | "PERIOD_ENDED" // scheduling period is in the past — 400
  | "SLOT_SHORTAGE" // not enough free slots in the window — 400
  | "COLLABORATOR_UNAVAILABLE" // AE-2 (#784) — a co-host is already committed — 409
  | "UNKNOWN_ERROR"; // infra / unexpected — 500

/**
 * Result of allocation operation
 */
export interface AllocationResult {
  success: boolean;
  appointments?: any[]; // Appointment records created
  error?: string;
  errorCode?: AllocationErrorCode;
  httpStatus?: number;
  warnings?: string[];
  // AE-4 — appointment ids whose tentative slots were freed during a partial
  // reschedule, so callers (calendar refresh, notifications) know what to drop.
  deletedAppointmentIds?: string[];
  /**
   * #1206 — fewer sessions than the plan requires were placed, at the
   * consultant's explicit request. Derived at read time from confirmed
   * sessions vs the plan's total; nothing is persisted.
   */
  partial?: boolean;
  placedSessions?: number;
  requiredSessions?: number;
  unplacedSessions?: number;
  /**
   * #1206 — a top-up run that wrote nothing: either the plan is already fully
   * scheduled or the consultant's availability still has no room. Success, not
   * a failure, and the one signal the notification suppressor reads — the
   * hourly sweep re-attempts every incomplete event, so a notice on a run that
   * changed nothing would page the consultee every hour forever.
   */
  noChange?: boolean;
  /**
   * #1206 — on a SLOT_SHORTAGE refusal: how many whole sessions the search
   * COULD have placed. Zero means offering a partial allocation is pointless.
   */
  placeableSessions?: number;
}

/**
 * Time slot representation
 */
export interface TimeSlot {
  startTime: Date;
  endTime: Date;
  isAvailable: boolean;
  isBooked: boolean;
}

/**
 * Progress information for UI display
 */
export interface ProgressInfo {
  scheduled: number; // Number of calls/sessions scheduled
  required: number; // Total required
  remaining: number; // Remaining to schedule
  sessionDuration: number; // In hours
  displayText: string; // Formatted text for UI
}

/**
 * Consultant profile data needed for allocation
 */
export interface ConsultantAllocationData {
  userId: string;
  scheduleType: "WEEKLY" | "CUSTOM";
  slotsOfAvailabilityWeekly: Array<{
    id: string;
    startDay: string;
    startTimeUtc: number;
    endDay: string;
    endTimeUtc: number;
    utcOffsetMinutes: number;
  }>;
  slotsOfAvailabilityCustom: Array<{
    id: string;
    startsAt: Date;
    endsAt: Date;
  }>;
  timezone?: string;
}

/**
 * Event configuration for allocation
 */
export interface EventConfig {
  durationInMonths?: number;
  durationInHours?: number; // For consultations/webinars (total duration)
  sessionDurationInHours?: number; // For subscriptions/classes (per session)
  sessionsPerWeek?: number; // For subscriptions/classes
  totalSessions?: number; // Authoritative session count from subscription plan
  schedulingPeriodStartsAt?: Date; // For subscriptions/classes
  schedulingPeriodEndsAt?: Date; // For subscriptions/classes
  // Timezone defining the limit day/week buckets (ADR B9). Subscription/Class
  // column; consultations/webinars fall back to the helper default.
  schedulingTimezone?: string;
}
