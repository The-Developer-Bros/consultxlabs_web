/**
 * Event Processing Utilities for Consultee Home Dashboard
 *
 * Provides type-safe processing of consultee events (consultations, subscriptions,
 * webinars, classes) into a unified ProcessedEvent format for display.
 */

import type {
  TConsultationWithPlan,
  TSubscriptionWithPlan,
} from "@/hooks/useEvents";
import type {
  TConsulteeEventsResponse,
  TConsulteeWebinar,
  TConsulteeClass,
} from "@/types/consultee-events";
import type { MeetingAppointment, MeetingSlot } from "@/lib/meeting";
import {
  getCurrentOrNextSession,
  groupSlotsIntoRuns,
  type SessionRun,
} from "@/lib/appointments/slots";

/**
 * Unified event type for display in the dashboard
 */
// Collaborator info for co-hosts display
interface ProcessedCollaborator {
  name: string;
  image?: string | null;
  role: string;
}

/** Whether the consultee holds a seat on a group event. */
export type BookingStatus = "CONFIRMED" | null;

export interface ProcessedEvent {
  id: string;
  type: "consultation" | "subscription" | "class" | "webinar";
  title: string;
  consultantName: string;
  consultantImage?: string | null;
  startsAt: Date;
  endsAt: Date;
  status: string;
  slots: ProcessedEventSlot[];
  appointmentId?: string;
  // Data needed for joining meetings
  joinableAppointment?: MeetingAppointment;
  joinableSlot?: MeetingSlot;
  // #1061 — the whole run `joinableSlot` anchors, so the card can ask
  // getSessionJoinState for a real state (including `ended`) instead of
  // re-deriving a time window from one row.
  joinableSession?: SessionRun<ProcessedSlot> | null;
  // Registration state for webinars/classes. There is no queue any more —
  // either the consultee holds a seat or the row is a plain event card.
  bookingStatus?: BookingStatus;
  // Collaborators (co-hosts) for webinars/classes
  collaborators?: ProcessedCollaborator[];
  // Org sponsorship — `Appointment.organizationId` (null = personal).
  // Drives the "Sponsored by <Org>" pill on the Home card so org-funded
  // sessions are visually distinct from personal bookings.
  organizationId?: string | null;
}

/**
 * A slot row as this tab carries it: `MeetingSlot` (what the join helper
 * needs) plus the two fields the session helpers read. Dropping them made
 * `groupSlotsIntoRuns` treat cancelled rows as live and left the card unable
 * to see that the host had ended the call — both silently, because they are
 * optional on `SessionSlotLike` (#1061).
 */
export type ProcessedSlot = MeetingSlot & {
  completionStatus?: string | null;
  meetingSession?: {
    id: string;
    endedAt: Date | string | null;
    endedReason: string | null;
  } | null;
};

/**
 * Internal type for tracking slots with their raw data
 */
interface SlotWithContext {
  startsAt: Date;
  endsAt: Date;
  rawSlot: ProcessedSlot;
  appointmentId: string;
}

/**
 * A slot as the card's session list carries it.
 *
 * #1199 — this used to be `{ startsAt, endsAt, appointmentId }` and nothing
 * more, which is exactly the shape that cannot answer "is this one session or
 * two". The identity, the tentative flag and the completion status ride along
 * now so the month view can group on runs like every other surface does.
 */
export type ProcessedEventSlot = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  appointmentId: string;
  isTentative: boolean;
  completionStatus: string | null;
};

function toEventSlot(slot: SlotWithContext): ProcessedEventSlot {
  return {
    id: slot.rawSlot.id,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    appointmentId: slot.appointmentId,
    isTentative: Boolean(slot.rawSlot.isTentative),
    completionStatus: slot.rawSlot.completionStatus ?? null,
  };
}

/** A picked session: the run, plus its anchor row in list-item shape. */
interface SessionPick extends SlotWithContext {
  run: SessionRun<ProcessedSlot> | null;
}

/**
 * The session that is live or next up, spanning its whole run of slot rows.
 *
 * #1061 — this used to return the first slot whose `startsAt` was in the
 * FUTURE. From minute 0 of a one-hour session that is the second half-hour
 * row, so Home greyed Join out while the session was live and then, once the
 * second row's own window opened, dropped the consultee into a different room
 * from the consultant. `startsAt`/`endsAt` now describe the run, and
 * `rawSlot` is the run's anchor — the row the video room is keyed to.
 */
function findNextSlot(slots: SlotWithContext[]): SessionPick | null {
  if (slots.length === 0) return null;

  const now = new Date();
  const sortedSlots = [...slots].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );

  const run = getCurrentOrNextSession(
    slots.map((s) => ({ ...s.rawSlot, appointmentId: s.appointmentId })),
    now,
  );
  const anchor = run
    ? slots.find((s) => s.rawSlot.id === run.anchor.id)
    : undefined;
  if (run && anchor) {
    return { ...anchor, startsAt: run.startsAt, endsAt: run.endsAt, run };
  }

  // Every row was cancelled/rescheduled: keep the old shape so the card still
  // renders (with Join inert) instead of vanishing from Home.
  const fallback =
    sortedSlots.find((s) => s.startsAt > now) ??
    sortedSlots[sortedSlots.length - 1];
  return { ...fallback, run: null };
}

/** Slot rows in the shape `findNextSlot` groups on. */
function toSlotContexts(
  slots: Array<{
    id: string;
    startsAt: Date | string;
    endsAt: Date | string | null;
    isTentative: boolean;
    appointmentId: string | null;
    completionStatus?: string | null;
    meetingSession?: {
    id: string;
    endedAt: Date | string | null;
    endedReason: string | null;
  } | null;
  }>,
  appointmentId: string,
): SlotWithContext[] {
  return slots.map((slot) => ({
    startsAt: new Date(slot.startsAt),
    endsAt: new Date(slot.endsAt ?? slot.startsAt),
    rawSlot: {
      id: slot.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      isTentative: slot.isTentative,
      appointmentId: slot.appointmentId,
      // Both are already selected by the events read
      // (lib/data/consultee-events-read.ts): the slot include is unfiltered,
      // and `meetingSession: { id, endedAt }` is explicit on all four types.
      completionStatus: slot.completionStatus ?? null,
      meetingSession: slot.meetingSession ?? null,
    },
    appointmentId,
  }));
}

/**
 * Process a consultation into a ProcessedEvent
 */
function processConsultation(
  consultation: TConsultationWithPlan,
): ProcessedEvent | null {
  const slots = consultation.appointment?.slotsOfAppointment;
  if (!slots || slots.length === 0) return null;

  const appointmentId = consultation.appointment?.id ?? "";
  const slotContexts = toSlotContexts(slots, appointmentId);
  // #1061 — the card's time range and its Join target are the whole session,
  // not the first 30-minute row of it.
  const session = findNextSlot(slotContexts);
  if (!session) return null;

  // Build meeting appointment
  const joinableAppointment: MeetingAppointment = {
    id: appointmentId,
    appointmentType: "CONSULTATION",
    slotsOfAppointment: slots.map((s) => ({
      id: s.id,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      isTentative: s.isTentative,
      appointmentId: s.appointmentId,
    })),
    consultation: {
      consultationPlan: {
        title: consultation.consultationPlan?.title,
      },
      requestedBy: {
        user: {
          name: consultation.consultationPlan?.consultantProfile?.user?.name,
        },
      },
    },
  };

  const joinableSlot: MeetingSlot = session.rawSlot;

  return {
    id: consultation.id,
    type: "consultation",
    title: consultation.consultationPlan?.title ?? "Consultation",
    consultantName:
      consultation.consultationPlan?.consultantProfile?.user?.name ?? "Expert",
    consultantImage:
      consultation.consultationPlan?.consultantProfile?.user?.image,
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    status: consultation.status ?? "PENDING",
    slots: slotContexts.map(toEventSlot),
    appointmentId,
    joinableAppointment,
    joinableSlot,
    joinableSession: session.run,
    organizationId: consultation.appointment?.organizationId ?? null,
  };
}

/**
 * Process a subscription into a ProcessedEvent
 */
function processSubscription(
  subscription: TSubscriptionWithPlan,
): ProcessedEvent | null {
  const allSlots: SlotWithContext[] = [];

  subscription.appointments?.forEach((appointment) => {
    allSlots.push(
      ...toSlotContexts(appointment.slotsOfAppointment ?? [], appointment.id),
    );
  });

  if (allSlots.length === 0) return null;

  const nextSlot = findNextSlot(allSlots);
  if (!nextSlot) return null;

  // Find the appointment that contains the next slot
  const nextAppointment = subscription.appointments?.find(
    (a) => a.id === nextSlot.appointmentId,
  );

  // Build meeting appointment
  const joinableAppointment: MeetingAppointment = {
    id: nextSlot.appointmentId,
    appointmentType: "SUBSCRIPTION",
    slotsOfAppointment:
      nextAppointment?.slotsOfAppointment?.map((s) => ({
        id: s.id,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        isTentative: s.isTentative,
        appointmentId: s.appointmentId,
      })) ?? [],
    subscription: {
      subscriptionPlan: {
        title: subscription.subscriptionPlan?.title,
      },
      requestedBy: {
        user: {
          name: subscription.subscriptionPlan?.consultantProfile?.user?.name,
        },
      },
    },
  };

  return {
    id: subscription.id,
    type: "subscription",
    title: subscription.subscriptionPlan?.title ?? "Subscription",
    consultantName:
      subscription.subscriptionPlan?.consultantProfile?.user?.name ?? "Expert",
    consultantImage:
      subscription.subscriptionPlan?.consultantProfile?.user?.image,
    startsAt: nextSlot.startsAt,
    endsAt: nextSlot.endsAt,
    status: subscription.status ?? "PENDING",
    slots: allSlots.map(toEventSlot),
    appointmentId: nextSlot.appointmentId,
    joinableAppointment,
    joinableSlot: nextSlot.rawSlot,
    joinableSession: nextSlot.run,
    organizationId: nextAppointment?.organizationId ?? null,
  };
}

/**
 * Process a webinar into a ProcessedEvent
 */
function processWebinar(webinar: TConsulteeWebinar): ProcessedEvent | null {
  const allSlots: SlotWithContext[] = [];
  const appointmentId = webinar.appointment?.id ?? "";

  // Get slots from the appointment
  allSlots.push(
    ...toSlotContexts(
      webinar.appointment?.slotsOfAppointment ?? [],
      appointmentId,
    ),
  );

  if (allSlots.length === 0) return null;

  const nextSlot = findNextSlot(allSlots);
  if (!nextSlot) return null;

  // Build meeting appointment
  const joinableAppointment: MeetingAppointment = {
    id: appointmentId,
    appointmentType: "WEBINAR",
    slotsOfAppointment:
      webinar.appointment?.slotsOfAppointment?.map((s) => ({
        id: s.id,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        isTentative: s.isTentative,
        appointmentId: s.appointmentId,
      })) ?? [],
    webinar: {
      webinarPlan: {
        title: webinar.webinarPlan?.title,
      },
    },
  };

  // Registered = the consultee is connected to at least one session slot.
  const bookingStatus: BookingStatus =
    (webinar.appointment?.slotsOfAppointment?.length ?? 0) > 0
      ? "CONFIRMED"
      : null;

  // Extract collaborators
  const collaborators: ProcessedCollaborator[] = (
    webinar.webinarPlan?.collaborators ?? []
  ).map((c) => ({
    name: c.consultantProfile?.user?.name ?? "Collaborator",
    image: c.consultantProfile?.user?.image,
    role: c.role,
  }));

  return {
    id: webinar.id,
    type: "webinar",
    title: webinar.webinarPlan?.title ?? "Webinar",
    consultantName:
      webinar.webinarPlan?.consultantProfile?.user?.name ?? "Expert",
    consultantImage: webinar.webinarPlan?.consultantProfile?.user?.image,
    startsAt: nextSlot.startsAt,
    endsAt: nextSlot.endsAt,
    status: webinar.status ?? "APPROVED",
    slots: allSlots.map(toEventSlot),
    appointmentId,
    joinableAppointment,
    joinableSlot: nextSlot.rawSlot,
    joinableSession: nextSlot.run,
    bookingStatus,
    collaborators,
    organizationId: webinar.appointment?.organizationId ?? null,
  };
}

/**
 * Process a class into a ProcessedEvent
 */
function processClass(classEvent: TConsulteeClass): ProcessedEvent | null {
  const allSlots: SlotWithContext[] = [];

  classEvent.appointments?.forEach((appointment) => {
    allSlots.push(
      ...toSlotContexts(appointment.slotsOfAppointment ?? [], appointment.id),
    );
  });

  if (allSlots.length === 0) return null;

  const nextSlot = findNextSlot(allSlots);
  if (!nextSlot) return null;

  // Find the appointment that contains the next slot
  const nextAppointment = classEvent.appointments?.find(
    (a) => a.id === nextSlot.appointmentId,
  );

  // Build meeting appointment
  const joinableAppointment: MeetingAppointment = {
    id: nextSlot.appointmentId,
    appointmentType: "CLASS",
    slotsOfAppointment:
      nextAppointment?.slotsOfAppointment?.map((s) => ({
        id: s.id,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        isTentative: s.isTentative,
        appointmentId: s.appointmentId,
      })) ?? [],
    class: {
      classPlan: {
        title: classEvent.classPlan?.title,
      },
    },
  };

  const bookingStatus: BookingStatus =
    (classEvent.appointments?.some(
      (a) => (a.slotsOfAppointment?.length ?? 0) > 0,
    ) ?? false)
      ? "CONFIRMED"
      : null;

  // Extract collaborators
  const collaborators: ProcessedCollaborator[] = (
    classEvent.classPlan?.collaborators ?? []
  ).map((c) => ({
    name: c.consultantProfile?.user?.name ?? "Collaborator",
    image: c.consultantProfile?.user?.image,
    role: c.role,
  }));

  return {
    id: classEvent.id,
    type: "class",
    title: classEvent.classPlan?.title ?? "Class",
    consultantName:
      classEvent.classPlan?.consultantProfile?.user?.name ?? "Expert",
    consultantImage: classEvent.classPlan?.consultantProfile?.user?.image,
    startsAt: nextSlot.startsAt,
    endsAt: nextSlot.endsAt,
    status: classEvent.status ?? "APPROVED",
    slots: allSlots.map(toEventSlot),
    appointmentId: nextSlot.appointmentId,
    joinableAppointment,
    joinableSlot: nextSlot.rawSlot,
    joinableSession: nextSlot.run,
    bookingStatus,
    collaborators,
    organizationId: nextAppointment?.organizationId ?? null,
  };
}

/**
 * A session is a group of contiguous slots belonging to the same appointment.
 */
export interface SessionGroup {
  /** The run's anchor row. Two runs can share an appointmentId, so keys do too. */
  id: string;
  appointmentId: string;
  startTime: Date;
  endTime: Date;
  status: "completed" | "upcoming";
}

/**
 * Group an event's slots into sessions with a time-based status.
 *
 * #1199 — this grouped by appointmentId alone, which says a booking is one
 * session no matter when its rows sit. A subscription's Tuesday 09:00 and
 * Thursday 16:00 sittings therefore merged into a single phantom session
 * running from Tuesday morning to Thursday afternoon, and the "Sessions
 * Completed" stat counted the pair as one. `groupSlotsIntoRuns` is the
 * definition every other surface uses: contiguous rows, same appointment, same
 * tentative flag, with cancelled and rescheduled rows dropped rather than left
 * to bridge two runs that never touched.
 */
export function groupSlotsIntoSessions(
  slots: ProcessedEvent["slots"],
): SessionGroup[] {
  const now = new Date();
  // Already sorted by start time by groupSlotsIntoRuns.
  return groupSlotsIntoRuns(slots).map((run) => ({
    id: run.anchor.id,
    appointmentId: run.anchor.appointmentId,
    startTime: run.startsAt,
    endTime: run.endsAt,
    status: (run.endsAt < now ? "completed" : "upcoming") as
      | "completed"
      | "upcoming",
  }));
}

/**
 * Process all events from the API response into unified ProcessedEvent array
 */
export function processAllEvents(
  eventsData: TConsulteeEventsResponse,
): ProcessedEvent[] {
  const events: ProcessedEvent[] = [];

  // Process consultations
  eventsData.consultations?.forEach((c) => {
    const processed = processConsultation(c);
    if (processed) events.push(processed);
  });

  // Process subscriptions
  eventsData.subscriptions?.forEach((s) => {
    const processed = processSubscription(s);
    if (processed) events.push(processed);
  });

  // Process webinars
  eventsData.webinars?.forEach((w) => {
    const processed = processWebinar(w);
    if (processed) events.push(processed);
  });

  // Process classes
  eventsData.classes?.forEach((c) => {
    const processed = processClass(c);
    if (processed) events.push(processed);
  });

  return events;
}

/**
 * Filter and sort events for upcoming display
 */
export function getUpcomingEvents(events: ProcessedEvent[]): ProcessedEvent[] {
  const now = new Date();
  return events
    .filter((e) => e.startsAt > now || e.slots.some((s) => s.startsAt > now))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * Filter events for a specific month
 */
export function getMonthlyEvents(
  events: ProcessedEvent[],
  month: Date,
): ProcessedEvent[] {
  const inactive = ["cancelled", "rejected", "completed", "expired"];

  return events
    .filter((e) =>
      e.slots.some(
        (s) =>
          s.startsAt.getMonth() === month.getMonth() &&
          s.startsAt.getFullYear() === month.getFullYear(),
      ),
    )
    .sort((a, b) => {
      const aInactive = inactive.includes(a.status.toLowerCase());
      const bInactive = inactive.includes(b.status.toLowerCase());
      if (aInactive !== bInactive) return aInactive ? 1 : -1;
      return a.startsAt.getTime() - b.startsAt.getTime();
    });
}
