import prisma from "@/lib/prisma";
import { toPlain } from "@/lib/data/serialize";
import type { SlotLike } from "@/lib/appointments/view-model";
import type { AppointmentStatus } from "@prisma/client";

/**
 * The one pending request the allocate page is placing.
 *
 * Keyed by the CONSULTATION/SUBSCRIPTION id, not an appointment id: the
 * `Appointment` row is downstream of the request and does not exist at all for
 * one that has never been scheduled, which is the ordinary case here.
 */

export type AllocationEventType = "consultation" | "subscription";

export interface AllocationRequest {
  id: string;
  eventType: AllocationEventType;
  title: string;
  status: AppointmentStatus;
  /** Owner of the plan — the page's ownership check. */
  consultantProfileId: string;
  /** The buyer, so the grid greys out times they are already booked at. */
  consulteeUserId?: string;
  consulteeName?: string;
  durationInHours?: number;
  sessionDurationInHours?: number;
  sessionsPerWeek?: number;
  durationInMonths?: number;
  totalSessions?: number;
  schedulingTimezone?: string;
  allowedStart?: Date;
  allowedEnd?: Date;
  /**
   * Some slot is released and awaiting a new time, i.e. this is a partial
   * reschedule rather than a fresh allocation — which is exactly when the
   * `initialAllocation` guard must NOT fire (#837).
   */
  hasReleasedSlots: boolean;
  /**
   * The times already asked for on the placeholder appointment — the buyer's
   * requested times, or the ones left behind by a partial reschedule. Same
   * rows `hasReleasedSlots` is derived from; the picker opens on the earliest
   * of them (#1073).
   */
  slots: SlotLike[];
}

const requestedBySelect = {
  select: { userId: true, user: { select: { name: true } } },
} as const;

/** Enough of a slot to place it on the grid, and to say whether it is live. */
const slotSelect = {
  select: {
    id: true,
    appointmentId: true,
    startsAt: true,
    endsAt: true,
    isTentative: true,
    completionStatus: true,
    // A10 tombstone (#676): a deleted slot is not a time anyone requested.
    deletedAt: true,
  },
} as const;

export async function readAllocationRequest(
  requestId: string,
  eventType: AllocationEventType,
): Promise<AllocationRequest | null> {
  if (eventType === "subscription") {
    const subscription = await prisma.subscription.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        status: true,
        schedulingPeriodStartsAt: true,
        schedulingPeriodEndsAt: true,
        schedulingTimezone: true,
        requestedBy: requestedBySelect,
        subscriptionPlan: {
          select: {
            title: true,
            consultantProfileId: true,
            sessionsPerWeek: true,
            sessionDurationInHours: true,
            durationInMonths: true,
            totalSessions: true,
          },
        },
        appointments: {
          select: { slotsOfAppointment: slotSelect },
        },
      },
    });
    if (!subscription?.subscriptionPlan) return null;

    const plan = subscription.subscriptionPlan;
    return toPlain<AllocationRequest>({
      id: subscription.id,
      eventType: "subscription",
      title: plan.title,
      status: subscription.status,
      consultantProfileId: plan.consultantProfileId,
      consulteeUserId: subscription.requestedBy?.userId,
      consulteeName: subscription.requestedBy?.user?.name,
      sessionDurationInHours: plan.sessionDurationInHours,
      sessionsPerWeek: plan.sessionsPerWeek,
      durationInMonths: plan.durationInMonths,
      totalSessions: plan.totalSessions,
      schedulingTimezone: subscription.schedulingTimezone,
      allowedStart: subscription.schedulingPeriodStartsAt,
      allowedEnd: subscription.schedulingPeriodEndsAt,
      hasReleasedSlots: subscription.appointments.some((appointment) =>
        appointment.slotsOfAppointment.some((slot) => slot.isTentative),
      ),
      slots: subscription.appointments.flatMap(
        (appointment) => appointment.slotsOfAppointment,
      ),
    });
  }

  const consultation = await prisma.consultation.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      status: true,
      requestedBy: requestedBySelect,
      consultationPlan: {
        select: {
          title: true,
          consultantProfileId: true,
          durationInHours: true,
        },
      },
      appointment: { select: { slotsOfAppointment: slotSelect } },
    },
  });
  if (!consultation?.consultationPlan) return null;

  const plan = consultation.consultationPlan;
  return toPlain<AllocationRequest>({
    id: consultation.id,
    eventType: "consultation",
    title: plan.title,
    status: consultation.status,
    consultantProfileId: plan.consultantProfileId,
    consulteeUserId: consultation.requestedBy?.userId,
    consulteeName: consultation.requestedBy?.user?.name,
    durationInHours: plan.durationInHours,
    hasReleasedSlots: (
      consultation.appointment?.slotsOfAppointment ?? []
    ).some((slot) => slot.isTentative),
    slots: consultation.appointment?.slotsOfAppointment ?? [],
  });
}
