import type { SlotPickerSubject } from "@/components/scheduling/slot-picker-policy";
import type { TAppointmentDetail } from "@/lib/data/appointment-detail";
import { toSlotLike, type SlotLike } from "@/lib/appointments/view-model";

/**
 * Turns one appointment into everything a reschedule page needs.
 *
 * The consultee's route carries `[consulteeId]` and `[appointmentId]` and
 * nothing else, so the consultant whose grid the picker draws has to be
 * resolved from the booking — this is where that happens, server-side, before
 * anything reaches the client.
 */

export type BookingTypeLabel =
  | "Consultation"
  | "Subscription"
  | "Webinar"
  | "Class"
  | "Trial";

export interface RescheduleSubject {
  subject: SlotPickerSubject;
  /** Plan title, for the page header. */
  title: string;
  /** Drives copy and the reschedule endpoint's `?type=` discriminator. */
  typeLabel: BookingTypeLabel;
  /** Owner of the grid — the answer the consultee's route params cannot give. */
  consultantProfileId: string;
  /** The booking's consultee, for the page's ownership check. */
  consulteeProfileId?: string;
  consulteeUserId?: string;
  /** Counterpart names for the page header — already on the plan/requestedBy
   * includes `readAppointmentDetail` selects, so no second query. */
  consultantName?: string;
  consulteeName?: string;
}

/** Slots that a reschedule could still act on: ahead of now, and not already dead. */
function liveFutureSlots(detail: TAppointmentDetail): SlotLike[] {
  const { appointment, siblings } = detail;
  // Program-wide. A subscription or class session is one Appointment among
  // many, and "every session" has to mean all of them — the reschedule API
  // reads the whole program off a single appointment id for the same reason.
  const all = [
    ...appointment.slotsOfAppointment,
    ...siblings.flatMap((sibling) => sibling.slotsOfAppointment),
  ];
  const now = Date.now();
  return all
    .filter(
      (slot) =>
        new Date(slot.endsAt).getTime() >= now &&
        slot.completionStatus !== "CANCELLED" &&
        slot.completionStatus !== "RESCHEDULED",
    )
    // The shared allowlist, not a hand-rolled one: these rows come from an
    // `include` and carry attendees and recording URLs (#1073).
    .map(toSlotLike);
}

/**
 * Consultant, consultee, session length and copy for one booking.
 *
 * Returns null when the booking has no consultant to draw a grid for, which
 * the caller should treat as a 404 rather than render an empty calendar.
 */
export function buildRescheduleSubject(
  detail: TAppointmentDetail,
): RescheduleSubject | null {
  const { appointment } = detail;

  const resolved = ((): {
    consultantProfileId?: string;
    consulteeProfileId?: string;
    consulteeUserId?: string;
    consultantName?: string;
    consulteeName?: string;
    title: string;
    typeLabel: BookingTypeLabel;
    sessionDurationInHours?: number;
    /** Consultation/Subscription/Webinar/Class id for "This booking" /
     * "Being moved" paint. Absent for Trial (no event-slots fetch). */
    eventType?: SlotPickerSubject["eventType"];
    eventId?: string;
    /** Recurring bookings only — the grid clamps selection to this window and
     *  buckets its per-day/week caps in this zone. */
    allowedStart?: Date;
    allowedEnd?: Date;
    schedulingTimezone?: string;
    sessionsPerWeek?: number;
    totalSessions?: number;
  } | null => {
    switch (appointment.appointmentType) {
      case "CONSULTATION": {
        const plan = appointment.consultation?.consultationPlan;
        return {
          consultantProfileId: plan?.consultantProfile?.id,
          consulteeProfileId: appointment.consultation?.requestedBy?.id,
          consulteeUserId: appointment.consultation?.requestedBy?.userId,
          consultantName: plan?.consultantProfile?.user?.name,
          consulteeName: appointment.consultation?.requestedBy?.user?.name,
          title: plan?.title ?? "Consultation",
          typeLabel: "Consultation",
          sessionDurationInHours: plan?.durationInHours,
          eventType: "consultation",
          eventId: appointment.consultation?.id ?? undefined,
        };
      }
      case "SUBSCRIPTION": {
        const plan = appointment.subscription?.subscriptionPlan;
        const subscription = appointment.subscription;
        return {
          consultantProfileId: plan?.consultantProfile?.id,
          consulteeProfileId: subscription?.requestedBy?.id,
          consulteeUserId: subscription?.requestedBy?.userId,
          consultantName: plan?.consultantProfile?.user?.name,
          consulteeName: subscription?.requestedBy?.user?.name,
          title: plan?.title ?? "Subscription",
          typeLabel: "Subscription",
          sessionDurationInHours: plan?.sessionDurationInHours,
          eventType: "subscription",
          eventId: subscription?.id ?? undefined,
          // The plan's scheduling period and cadence. Omitting these drew an
          // unclamped grid: the consultee could pick a time outside the
          // period they bought, and only found out at submit, where the API
          // rejects it. The allocate subject has always passed them.
          allowedStart: subscription?.schedulingPeriodStartsAt
            ? new Date(subscription.schedulingPeriodStartsAt)
            : undefined,
          allowedEnd: subscription?.schedulingPeriodEndsAt
            ? new Date(subscription.schedulingPeriodEndsAt)
            : undefined,
          schedulingTimezone: subscription?.schedulingTimezone,
          sessionsPerWeek: plan?.sessionsPerWeek,
          totalSessions: plan?.totalSessions,
        };
      }
      case "WEBINAR": {
        const plan = appointment.webinar?.webinarPlan;
        return {
          consultantProfileId: plan?.consultantProfile?.id,
          consultantName: plan?.consultantProfile?.user?.name,
          title: plan?.title ?? "Webinar",
          typeLabel: "Webinar",
          sessionDurationInHours: plan?.durationInHours,
          eventType: "webinar",
          eventId: appointment.webinar?.id ?? undefined,
        };
      }
      case "CLASS": {
        const plan = appointment.class?.classPlan;
        const classEvent = appointment.class;
        return {
          consultantProfileId: plan?.consultantProfile?.id,
          consultantName: plan?.consultantProfile?.user?.name,
          title: plan?.title ?? "Class",
          typeLabel: "Class",
          sessionDurationInHours: plan?.sessionDurationInHours ?? undefined,
          eventType: "class",
          eventId: classEvent?.id ?? undefined,
          // Same clamp as SUBSCRIPTION; a class is the other recurring shape.
          allowedStart: classEvent?.schedulingPeriodStartsAt
            ? new Date(classEvent.schedulingPeriodStartsAt)
            : undefined,
          allowedEnd: classEvent?.schedulingPeriodEndsAt
            ? new Date(classEvent.schedulingPeriodEndsAt)
            : undefined,
          schedulingTimezone: classEvent?.schedulingTimezone,
          sessionsPerWeek: plan?.sessionsPerWeek,
          totalSessions: plan?.totalSessions,
        };
      }
      case "TRIAL": {
        const plan = appointment.trialSession?.subscriptionPlan;
        return {
          consultantProfileId: plan?.consultantProfile?.id,
          consulteeProfileId: appointment.trialSession?.consulteeProfile?.id,
          consulteeUserId: appointment.trialSession?.consulteeProfile?.userId,
          consultantName: plan?.consultantProfile?.user?.name,
          consulteeName: appointment.trialSession?.consulteeProfile?.user?.name,
          title: plan?.title ?? "Trial session",
          typeLabel: "Trial",
          sessionDurationInHours: plan?.sessionDurationInHours,
          // Trial has no allocate/event-slots endpoint — availability only.
          eventType: "consultation",
        };
      }
      default:
        return null;
    }
  })();

  if (!resolved?.consultantProfileId) return null;

  const slots = liveFutureSlots(detail);

  return {
    title: resolved.title,
    typeLabel: resolved.typeLabel,
    consultantProfileId: resolved.consultantProfileId,
    consulteeProfileId: resolved.consulteeProfileId,
    consulteeUserId: resolved.consulteeUserId,
    consultantName: resolved.consultantName,
    consulteeName: resolved.consulteeName,
    subject: {
      consultantProfileId: resolved.consultantProfileId,
      // Real eventType + eventId so fetchEventSlots paints "This booking" /
      // "Being moved". Availability still comes from the consultant grid; the
      // reschedule submit goes to the appointment reschedule API, not allocate.
      eventType: resolved.eventType ?? "consultation",
      eventId: resolved.eventId,
      counterpartUserId: resolved.consulteeUserId,
      // Both, deliberately: the grid reads `durationInHours` for the
      // consultation shape it is drawing and `sessionDurationInHours` for the
      // block size, and for a session being MOVED those are the same number.
      // Leaving the first unset is what made the picker warn "duration not
      // configured" and fall back to an hour.
      durationInHours: resolved.sessionDurationInHours,
      sessionDurationInHours: resolved.sessionDurationInHours,
      // Recurring bookings only; undefined on the one-off types leaves the
      // grid unclamped, which is correct there.
      allowedStart: resolved.allowedStart,
      allowedEnd: resolved.allowedEnd,
      schedulingTimezone: resolved.schedulingTimezone,
      sessionsPerWeek: resolved.sessionsPerWeek,
      totalSessions: resolved.totalSessions,
      slots,
      // Tentative sessions mean a move is already in flight — pin the count
      // for allocate-path stale-tab guards if this subject is reused there.
      hasReleasedSlots: slots.some((slot) => slot.isTentative),
    },
  };
}
