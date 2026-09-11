import type { TAppointment } from "@/types/appointment";

/**
 * Normalized appointment view-model shared by the consultant and consultee
 * appointments surfaces. The two dashboards read very different shapes
 * (consultee: 5-type grouped union; consultant: flat TAppointment[] plus
 * trials/unscheduled side-queries) — each side has a mapper into this VM so
 * the list/hero/sheet/calendar components render one type.
 */

export type AppointmentKind =
  | "CONSULTATION"
  | "SUBSCRIPTION"
  | "WEBINAR"
  | "CLASS"
  | "TRIAL";

export type AppointmentBucket =
  | "upcoming"
  | "needsAction"
  | "past"
  | "cancelled";

export type NeedsActionReason =
  | "PAY_NOW"
  | "PENDING_APPROVAL"
  | "UNSCHEDULED"
  | "TENTATIVE";

/**
 * Minimal structural slot shape. Both Prisma's bare SlotOfAppointment and
 * the relation-carrying TSlotOfAppointment satisfy it, and API payloads may
 * deliver dates as ISO strings — consumers must go through `new Date(...)`.
 */
export interface SlotLike {
  id: string;
  appointmentId?: string | null;
  startsAt: Date | string;
  endsAt?: Date | string | null;
  isTentative: boolean;
  completionStatus?: string | null;
  /** A10 soft-delete tombstone (#676) — a set value means the slot is gone. */
  deletedAt?: Date | string | null;
  meetingSession?: {
    id: string;
    endedAt: Date | string | null;
    /** #1270 — required; see the note in lib/appointments/slots.ts. */
    endedReason: string | null;
  } | null;
}

/**
 * The five scheduling fields, and nothing else.
 *
 * `readAppointmentDetail`'s slots are built with `include`, so each row also
 * drags along every attendee (`user[]`, name and image) and the session's
 * recording URLs. Those rows are fine to READ on the server, but handing one
 * to a client component serializes all of it into the RSC payload — and on a
 * class or webinar the attendee list is shared by every slot, so a term's
 * worth of sessions multiplies it by the whole roster. Same class of leak as
 * the consultant-PII one #946 fixed with a select-allowlist; this is that
 * allowlist, applied on the way out.
 */
export function toSlotLike(slot: SlotLike): SlotLike {
  return {
    id: slot.id,
    appointmentId: slot.appointmentId ?? null,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt ?? null,
    isTentative: slot.isTentative,
    completionStatus: slot.completionStatus ?? null,
    deletedAt: slot.deletedAt ?? null,
  };
}

export interface SessionVM {
  slotId: string;
  /** Owning appointment — differs per session inside subscription/class groups. */
  appointmentId: string | null;
  startsAt: Date;
  endsAt: Date | null;
  isTentative: boolean;
  /** Raw SlotCompletionStatus (CANCELLED/RESCHEDULED mark a dead session). */
  completionStatus: string | null;
  /** Meeting ended early by the host — session is over regardless of endsAt. */
  meetingEndedAt: Date | null;
  /**
   * #1270 — carried alongside `meetingEndedAt` because the two are only
   * meaningful together. A session ended by Stream's 30-second inactivity
   * timeout is not a session the host closed, and treating them alike locked
   * people out of their own booking mid-hour.
   */
  meetingEndedReason: string | null;
}

export interface PersonVM {
  name: string;
  image: string | null;
}

export interface AppointmentVMRaw {
  /** What the existing action hooks (join/cancel/reschedule/timings) consume. */
  appointment?: TAppointment;
  /** Future/ongoing slots in action-hook shape (consultee useEventActions input). */
  rawSlots?: SlotLike[];
  /** All child appointments of a subscription/class group, sorted. */
  groupAppointments?: TAppointment[];
  /** The original role-specific list item (trial, unscheduled event, …). */
  source?: unknown;
}

export interface AppointmentVM {
  /** Stable row key — synthetic for unscheduled rows. */
  id: string;
  /** Null ⇒ no detail page exists for this row (Sheet-only). */
  appointmentId: string | null;
  kind: AppointmentKind;
  title: string;
  /** The "other side" — consultant for consultee views, consultee/host for consultant views. */
  counterpart: PersonVM;
  /**
   * The consultant delivering this booking, for surfaces that need to load
   * their availability (the reschedule picker).
   *
   * Required rather than optional so the compiler names every mapper: it is
   * NOT derivable from `raw.appointment` on the consultee side, where the read
   * starts at the Consultation and nests the appointment beneath it — leaving
   * the plan a sibling, not a child. Reading it off the appointment there
   * silently yields null, which reads as "this consultant has no availability"
   * rather than as a bug.
   */
  consultantProfileId: string | null;
  /** Normalized (uppercase) lifecycle status from the owning event's enum. */
  status: string;
  bucket: AppointmentBucket;
  needsActionReason: NeedsActionReason | null;
  /** Sort/day-group anchor: next upcoming session, else the most recent one. */
  nextAt: Date | null;
  /** Full session timeline (all slots, past + future), chronological. */
  sessions: SessionVM[];
  /** Multi-session (subscription/class) progress; null for one-off events. */
  group: { total: number; completed: number } | null;
  /** Secondary descriptor line (plan cadence, duration, …). */
  meta: string | null;
  organizationId: string | null;
  pendingPaymentUrl: string | null;
  collaborators: Array<PersonVM & { role: string }>;
  /** Consultant view: the viewer's own role on a collaborative event. */
  collaboratorRole: string | null;
  raw: AppointmentVMRaw;
}

export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function toDateOrNull(
  value: Date | string | null | undefined,
): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}

export function toSessionVM(slot: SlotLike): SessionVM {
  return {
    slotId: slot.id,
    appointmentId: slot.appointmentId ?? null,
    startsAt: toDate(slot.startsAt),
    endsAt: toDateOrNull(slot.endsAt),
    isTentative: slot.isTentative,
    completionStatus: slot.completionStatus ?? null,
    meetingEndedAt: toDateOrNull(slot.meetingSession?.endedAt),
    meetingEndedReason: slot.meetingSession?.endedReason ?? null,
  };
}

export function sortSessions(sessions: SessionVM[]): SessionVM[] {
  return [...sessions].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );
}

/**
 * The consultant delivering this appointment, when the payload carries a plan.
 *
 * The reschedule proposal UI needs it to render that consultant's availability,
 * so the consultee picks a real bookable time rather than guessing and hoping.
 * Group events return null: they are organizer-rescheduled only, so no proposal
 * surface is offered for them.
 */
