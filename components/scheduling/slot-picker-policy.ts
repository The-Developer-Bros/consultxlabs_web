import type { AppointmentsType } from "@prisma/client";
import type { SlotLike } from "@/lib/appointments/view-model";
import { supportsProposals } from "@/lib/booking/reschedule-proposals";

/**
 * The four surfaces that place slots on a consultant's calendar, expressed as
 * data.
 *
 * They differ in how much notice a session needs, whether anything is being
 * released, and who owns the submit — not in structure. Threading those as
 * boolean props through one component is how `EventPlanner` reached 3,890
 * lines, so the differences live here and `SlotPicker` only ever reads fields.
 */

export type SlotPickerPolicyKind =
  | "ALLOCATE"
  | "RESCHEDULE_CONSULTEE"
  | "RESCHEDULE_CONSULTANT"
  | "MANAGE_TIMINGS";

/**
 * How the initiator would like the replacement placed when they name no time
 * (#1065). Two independent axes so "weekday mornings" is sayable, and both are
 * scored by the allocator rather than filtered on — the worst case of a
 * preference nobody can meet is a less-liked time, never a failed allocation.
 */
export interface SlotPreference {
  preferredTimeOfDay?: "MORNING" | "AFTERNOON" | "EVENING";
  preferredDays?: "WEEKDAYS" | "WEEKENDS";
}

/**
 * The picker's lowercase event types against the Prisma enum the policy layer
 * speaks. A total map rather than a cast, so adding an event type is a compile
 * error here instead of a silent `false` at runtime.
 */
const APPOINTMENT_TYPE: Record<
  SlotPickerSubject["eventType"],
  AppointmentsType
> = {
  consultation: "CONSULTATION",
  subscription: "SUBSCRIPTION",
  webinar: "WEBINAR",
  class: "CLASS",
};

/**
 * Whether a stated preference would survive being submitted for this booking.
 *
 * The reschedule API only opens a RescheduleRequest for the kinds that support
 * proposals, and a group event has no single counterparty to state one on
 * behalf of — so on a webinar or class the server discards a preference with no
 * row, no error and no feedback. Asking for something that is silently dropped
 * is worse than not being asked, so the control does not render there. Reads
 * the SAME predicate the route gates on rather than restating the rule.
 */
export function acceptsSlotPreference(
  eventType: SlotPickerSubject["eventType"],
): boolean {
  return supportsProposals(APPOINTMENT_TYPE[eventType]);
}

export interface SlotPickerSubmission {
  /** Sessions being released. Undefined = every session of the booking. */
  slotIds?: string[];
  /** Times asked for. Absent = "any time works". */
  proposedSlots?: { startsAt: string; endsAt: string }[];
  /** Only ever set alongside an absent `proposedSlots` — naming a time says it. */
  preference?: SlotPreference;
}

export interface SlotPickerPolicy {
  kind: SlotPickerPolicyKind;
  /**
   * Notice a session needs before it may be moved. Zero is not "no rule": a
   * pending request was never scheduled and a consultant's own event instance
   * strands nobody, so neither has a counterparty to give notice to.
   */
  minLeadHours: number;
  /**
   * Whether this surface releases sessions that already exist. Showing
   * released slots and offering a release step are the same condition, so it
   * is one field rather than two that can disagree.
   */
  showReleasedSlots: boolean;
  /**
   * Primary submit copy. Read only when `calendarMode` is "select" — the
   * allocate grid ships its own footer and labels its own buttons.
   */
  submitLabel: string;
  /**
   * Release WITHOUT naming a time. Predates proposals and is still the whole
   * contract when the counterparty should be the one choosing, so it survives
   * on every reschedule surface and at every session count.
   */
  allowReleaseWithoutTime: boolean;
  /**
   * "allocate" hands the submit to the grid's own buttons, which POST the
   * allocation themselves; "select" collects times and leaves the POST here.
   */
  calendarMode: "select" | "allocate";
  /**
   * Refuse the allocation when the event already holds confirmed slots
   * (#837). Fresh allocations only — a partial reschedule legitimately has
   * some, which is why the subject supplies the "is it fresh" half.
   */
  appliesInitialAllocationGuard: boolean;
  /** One line above the grid; the only place the two roles read differently. */
  pickerHint: string;
  onSubmit: (submission: SlotPickerSubmission) => void | Promise<void>;
  /** The grid reported a 409 — someone else allocated this first. */
  onConflict?: () => void;
}

/**
 * What is being placed. Pure scheduling data: the surrounding page or dialog
 * owns its own title and description, so no copy lives here.
 */
export interface SlotPickerSubject {
  /** Whose availability grid is drawn. */
  consultantProfileId: string;
  eventType: "consultation" | "subscription" | "webinar" | "class";
  /** Consultation/Subscription/Webinar/Class id — what the grid keys on. */
  eventId?: string;
  /**
   * The other party, so the grid greys out times they are already booked at:
   * allocation rejects those, and painting them green only fails at submit.
   * Absent under MANAGE_TIMINGS — a consultant's own instance has no
   * counterparty to conflict with.
   */
  counterpartUserId?: string;
  /** Consultations and webinars: the length of the one session. */
  durationInHours?: number;
  /** Subscriptions and classes: the length of each session. */
  sessionDurationInHours?: number;
  sessionsPerWeek?: number;
  durationInMonths?: number;
  totalSessions?: number;
  /** Defines the limit day/week buckets (ADR B9). */
  schedulingTimezone?: string;
  /** The plan's scheduling period; the grid clamps selection to it. */
  allowedStart?: Date;
  allowedEnd?: Date;
  /** Existing sessions, for the release step. */
  slots?: SlotLike[];
  /** A session is already released and awaiting a new time. */
  hasReleasedSlots?: boolean;
}

/** Lead time the reschedule API enforces server-side; mirrored for the UI. */
const RESCHEDULE_MIN_LEAD_HOURS = 24;

type PolicyHandlers = Pick<SlotPickerPolicy, "onSubmit"> &
  Partial<Pick<SlotPickerPolicy, "onConflict">>;

/** A consultant placing a pending request that has never been scheduled. */
export function allocatePolicy(handlers: PolicyHandlers): SlotPickerPolicy {
  return {
    kind: "ALLOCATE",
    minLeadHours: 0,
    showReleasedSlots: false,
    submitLabel: "Allocate slots",
    allowReleaseWithoutTime: false,
    calendarMode: "allocate",
    appliesInitialAllocationGuard: true,
    pickerHint:
      "Choose the times for this booking. Green is free for both of you; anything else is already taken.",
    ...handlers,
  };
}

/** A consultee moving a live booking of theirs. */
export function rescheduleConsulteePolicy(
  handlers: PolicyHandlers,
): SlotPickerPolicy {
  return {
    kind: "RESCHEDULE_CONSULTEE",
    minLeadHours: RESCHEDULE_MIN_LEAD_HOURS,
    showReleasedSlots: true,
    submitLabel: "Request this time",
    allowReleaseWithoutTime: true,
    calendarMode: "select",
    appliesInitialAllocationGuard: false,
    pickerHint:
      "Green means your consultant is free — choosing one of those confirms straight away. Anything else is sent to them to approve.",
    ...handlers,
  };
}

/** A consultant moving a booking they deliver. */
export function rescheduleConsultantPolicy(
  handlers: PolicyHandlers,
): SlotPickerPolicy {
  return {
    kind: "RESCHEDULE_CONSULTANT",
    minLeadHours: RESCHEDULE_MIN_LEAD_HOURS,
    showReleasedSlots: true,
    submitLabel: "Propose this time",
    allowReleaseWithoutTime: true,
    calendarMode: "select",
    appliesInitialAllocationGuard: false,
    // Never auto-confirms: publishing availability is standing consent to be
    // booked inside it, but merely being free is not consent to be moved.
    pickerHint:
      "Green means you are free. Whatever you propose is sent to the consultee to accept.",
    ...handlers,
  };
}

/** A consultant setting the times of their own event instance. */
export function manageTimingsPolicy(
  handlers: PolicyHandlers,
): SlotPickerPolicy {
  return {
    kind: "MANAGE_TIMINGS",
    minLeadHours: 0,
    showReleasedSlots: false,
    submitLabel: "Save timings",
    allowReleaseWithoutTime: false,
    calendarMode: "allocate",
    appliesInitialAllocationGuard: false,
    pickerHint:
      "Choose when this runs. Green is free on your calendar; anything else is already taken.",
    ...handlers,
  };
}
