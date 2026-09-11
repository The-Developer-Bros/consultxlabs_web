/**
 * Single catalog for every user-facing message in the slot-allocation flow so
 * the week view, month view, and requests table never drift in wording.
 * Limits bucket by the event's scheduling timezone (SlotCalculationService,
 * ADR B9), which for a viewer in a different timezone is not always the
 * calendar day they see on the grid. #1076 — the cap messages used to hide
 * behind a vague "this day/this week"; when the zones differ they now name
 * the scheduling bucket and translate its span onto the viewer's clock.
 */

import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";

export interface AllocationToast {
  title: string;
  description: string;
  variant: "default" | "destructive";
}

const plural = (n: number) => (n === 1 ? "" : "s");

/** "Jul 20, 2026" for a "YYYY-MM-DD" scheduling-timezone day key. */
export function formatDayKey(dayKey: string): string {
  const d = new Date(`${dayKey}T00:00:00.000Z`);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

/** "week of Jul 19, 2026" for a week key ("YYYY-MM-DD" of the week's Sunday). */
export function formatWeekKey(weekKey: string): string {
  return `week of ${formatDayKey(weekKey.split("T")[0])}`;
}

// --- #1076 limit buckets ---

/** The scheduling-timezone day/week bucket a cap rejection is about. */
export interface LimitBucket {
  kind: "day" | "week";
  /** UTC instants bounding the bucket. */
  start: Date;
  end: Date;
  /** "Jul 20, 2026" / "week of Jul 19, 2026" — the bucket as scheduled. */
  label: string;
  /** RESOLVED scheduling timezone (never undefined — the default counts). */
  timeZone: string;
}

export function schedulingDayBucket(
  at: Date,
  schedulingTimezone?: string,
): LimitBucket {
  const timeZone =
    schedulingTimezone ?? SlotCalculationService.DEFAULT_SCHEDULING_TIMEZONE;
  const start = SlotCalculationService.startOfDayInTz(at, timeZone);
  // +26h lands inside the NEXT bucket whatever DST did (a day is 23-25h),
  // then snaps back to its start — so the end is exact, not start+24h.
  const end = SlotCalculationService.startOfDayInTz(
    new Date(start.getTime() + 26 * 3_600_000),
    timeZone,
  );
  return {
    kind: "day",
    start,
    end,
    label: formatDayKey(SlotCalculationService.dayKey(at, timeZone)),
    timeZone,
  };
}

export function schedulingWeekBucket(
  at: Date,
  schedulingTimezone?: string,
): LimitBucket {
  const timeZone =
    schedulingTimezone ?? SlotCalculationService.DEFAULT_SCHEDULING_TIMEZONE;
  const start = SlotCalculationService.startOfWeekSundayInTz(at, timeZone);
  // 7 days + 2h: early into the following Sunday across any DST shift.
  const end = SlotCalculationService.startOfWeekSundayInTz(
    new Date(start.getTime() + 170 * 3_600_000),
    timeZone,
  );
  return {
    kind: "week",
    start,
    end,
    label: formatWeekKey(SlotCalculationService.weekKey(at, timeZone)),
    timeZone,
  };
}

const viewerTimezone = (): string | undefined =>
  typeof Intl !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : undefined;

/**
 * " Days are counted in Asia/Kolkata: this day is Jul 20, 2026, Jul 19,
 * 11:30 PM – Jul 20, 11:30 PM on your clock." — appended to a cap rejection
 * so the bucket that filled up is nameable and locatable on the viewer's own
 * clock. Empty when the zones agree: there is nothing to explain, the bucket
 * is the day/week the viewer already sees.
 */
export function limitBucketNote(bucket?: LimitBucket): string {
  if (!bucket || viewerTimezone() === bucket.timeZone) return "";
  const fmt = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const span = `${fmt.format(bucket.start)} – ${fmt.format(bucket.end)} on your clock`;
  return bucket.kind === "day"
    ? ` Days are counted in ${bucket.timeZone}: this day is ${bucket.label}, ${span}.`
    : ` Weeks are counted in ${bucket.timeZone}: this ${bucket.label} runs ${span}.`;
}

// --- interactive selection guards ---

export const weeklyLimitReached = (
  sessionsPerWeek: number,
  bucket?: LimitBucket,
): AllocationToast => ({
  variant: "destructive",
  title: "Weekly limit reached",
  description: `You can only schedule ${sessionsPerWeek} session${plural(sessionsPerWeek)} per week. This week is full — choose a different week.${limitBucketNote(bucket)}`,
});

export const dailyLimitReached = (
  maxPerDay: number,
  bucket?: LimitBucket,
): AllocationToast => ({
  variant: "destructive",
  title: "Daily limit reached",
  description: `You can only schedule ${maxPerDay} session${plural(maxPerDay)} per day. Choose a different day.${limitBucketNote(bucket)}`,
});

export const oneSessionPerDay = (bucket?: LimitBucket): AllocationToast => ({
  variant: "destructive",
  title: "One session per day",
  description: `You can only schedule one session per day. Please choose a different day.${limitBucketNote(bucket)}`,
});

export const sessionLimitReached = (maxTotal: number): AllocationToast => ({
  variant: "destructive",
  title: "Session limit reached",
  description: `You've already selected all ${maxTotal} session${plural(maxTotal)}. Remove a session to choose a different time.`,
});

export const allSessionsSelected = (): AllocationToast => ({
  variant: "destructive",
  title: "All sessions selected",
  description:
    "You've selected all the required time slots. Click 'Allocate' to confirm.",
});

export const completeSessionFirst = (): AllocationToast => ({
  variant: "destructive",
  title: "Complete this session first",
  description:
    "Select the next consecutive time slot to finish the session you've started.",
});

export const consecutiveRequired = (): AllocationToast => ({
  variant: "destructive",
  title: "Slots must be consecutive",
  description:
    "Each session requires back-to-back time slots on the same day. Select the immediately following slot.",
});

export const invalidSelection = (reason: string): AllocationToast => ({
  variant: "destructive",
  title: "Invalid selection",
  description: reason,
});

export const outsideSchedulingWindow = (
  rangeText: string,
): AllocationToast => ({
  variant: "destructive",
  title: "Outside scheduling window",
  description: `Slots can only be selected within the scheduling period (${rangeText}).`,
});

export const pastSlotBlocked = (): AllocationToast => ({
  variant: "destructive",
  title: "Slot has passed",
  description: "This slot is no longer available.",
});

export const pastSessionBlocked = (): AllocationToast => ({
  variant: "destructive",
  title: "Past session",
  description:
    "This session has already passed. Navigate to a future week to schedule a replacement.",
});

export const sessionTooSoon = (): AllocationToast => ({
  variant: "destructive",
  title: "Session too soon",
  description: "This session starts within 24 hours and cannot be rescheduled.",
});

export const sessionBeingRescheduled = (): AllocationToast => ({
  variant: "default",
  title: "Session being rescheduled",
  description:
    "This is the session you're rescheduling — pick a new available time for it.",
});

export const slotUnavailable = (isBooked: boolean): AllocationToast => ({
  variant: "destructive",
  title: "Slot unavailable",
  description: isBooked
    ? "This slot is already booked."
    : "This slot is not available.",
});

export const notEnoughConsecutive = (
  requiredSlots: number,
  availableHere: number,
): AllocationToast => ({
  variant: "destructive",
  title: "Not enough consecutive slots",
  description: `Each session requires ${(requiredSlots * 30) / 60} hours (${requiredSlots} consecutive slots). Only ${availableHere} available here.`,
});

// --- selection progress ---

export const sessionAdded = (
  completed: number,
  total: number,
): AllocationToast => ({
  variant: "default",
  title: "Session added",
  description: `${completed} of ${total} session${plural(total)} selected — ${total - completed} more to go.`,
});

export const keepGoing = (
  remainingInCall: number,
  sessionNumber: number,
): AllocationToast => ({
  variant: "default",
  title: "Keep going",
  description: `Select ${remainingInCall} more consecutive slot${plural(remainingInCall)} to complete session ${sessionNumber}.`,
});

// --- allocation outcomes ---

export const timingsSaved = (): AllocationToast => ({
  variant: "default",
  title: "Timings saved",
  description: "Sessions have been scheduled successfully.",
});

export const autoScheduled = (): AllocationToast => ({
  variant: "default",
  title: "Sessions auto-scheduled",
  description: "All sessions have been automatically scheduled.",
});

/**
 * #1206 — the consultant asked for a partial placement and got one. Says how
 * many sessions are still unscheduled, because "scheduled" on its own would
 * read as the whole plan.
 */
export const partiallyScheduled = (
  placed: number,
  required: number,
): AllocationToast => {
  // The remainder needs its own noun and its own agreement: a shortfall of one
  // is the common near-complete case, and "The remaining 1 stay unscheduled"
  // is what the consultant read there.
  const remaining = Math.max(0, required - placed);
  return {
    variant: "default",
    title: "Some sessions scheduled",
    description: `${placed} of ${required} session${plural(required)} now have times. The remaining ${remaining} session${plural(remaining)} ${remaining === 1 ? "stays" : "stay"} unscheduled until more availability opens.`,
  };
};

export const allocationFailed = (reason: string): AllocationToast => ({
  variant: "destructive",
  title: "Couldn't save timings",
  description: reason,
});

/**
 * PR 2c resilience (audit gap #5) — cause-specific toasts keyed by the
 * server's structured errorCode. The raw message still renders as the
 * description, but the title tells the consultant WHY without parsing
 * internal error strings. Falls back to `allocationFailed` for unknown
 * codes so nothing silently loses its copy.
 */
const ALLOCATION_ERROR_TOASTS: Record<
  string,
  { title: string; variant: "destructive" | "default" }
> = {
  NO_AVAILABILITY: {
    title: "No availability published",
    variant: "destructive",
  },
  PERIOD_ENDED: {
    title: "The scheduling period has ended",
    variant: "destructive",
  },
  SLOT_SHORTAGE: {
    title: "Not enough free slots",
    variant: "destructive",
  },
};

export const allocationFailedWithCode = (
  reason: string,
  errorCode?: string,
): AllocationToast => {
  if (errorCode && ALLOCATION_ERROR_TOASTS[errorCode]) {
    return {
      ...ALLOCATION_ERROR_TOASTS[errorCode],
      description: reason,
    } as AllocationToast;
  }
  return allocationFailed(reason);
};

/** Client-side gate when the event PK is not UUID/CUID (mock/hand-crafted rows). */
export const invalidEventId = (): AllocationToast => ({
  variant: "destructive",
  title: "Couldn't save timings",
  description:
    "This booking has an invalid event id — reseed or recreate it with a generated UUID/CUID.",
});

/**
 * #1132 — server 409 messages that must render AS THEMSELVES instead of
 * being relabeled "already allocated in another tab". A slot conflict
 * ("Slot taken during allocation: [CONFLICT] Slot already booked: …",
 * SlotValidationService/SlotAllocationService) means the SLOT went to
 * someone else — the request is still allocatable with different times, so
 * the honest message keeps the dialog open instead of kicking the
 * consultant back to the list.
 */
export const preservedMessages: readonly RegExp[] = [
  /slot already booked/i,
  /slot taken during allocation/i,
  // Audit gap #11 — a #1012 stale-tab reschedule precondition was being
  // mislabeled "Already allocated" because it wasn't in this list. It means
  // the tentative count changed (another tab finished/started the
  // reschedule), NOT that the event was allocated elsewhere.
  /reschedule state changed in another session/i,
];

export const isPreservedAllocationMessage = (message: string): boolean =>
  preservedMessages.some((pattern) => pattern.test(message));

/** 409 — another tab or teammate already allocated this request. "Session"
 * is deliberately avoided here: it means a bookable session everywhere else
 * in this dialog. */
export const allocatedElsewhere = (): AllocationToast => ({
  variant: "destructive",
  title: "Already allocated",
  description:
    "This request was already allocated in another tab or by a teammate. Refreshing the list.",
});

/** Request left the allocatable state (declined/cancelled) in another tab. */
export const requestChangedElsewhere = (): AllocationToast => ({
  variant: "destructive",
  title: "Request changed",
  description:
    "This request was updated in another tab or by a teammate and can no longer be allocated. Refreshing the list.",
});

/** Plan data anomaly: no totalSessions and no scheduling period. */
export const planConfigIncomplete = (): AllocationToast => ({
  variant: "destructive",
  title: "Plan configuration incomplete",
  description:
    "This request's plan is missing its session count and scheduling period, so slots can't be allocated. Contact support.",
});
