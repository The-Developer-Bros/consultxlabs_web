/**
 * Shared read for the single-appointment detail hub (consultant + consultee
 * /appointments/[appointmentId] pages). Both the API route
 * (GET /api/appointments/[appointmentId]) and the RSC prefetch call this so
 * SSR hydration and the client useQuery resolve identical payloads.
 *
 * Includes everything the detail page renders: the polymorphic event with
 * plan + people, ordered slots with meeting sessions AND their recordings,
 * payment, sponsoring org — plus sibling appointments of the same
 * subscription/class so the timeline shows the whole program. userId fields
 * on the profile selects exist for the API route's ownership check.
 */

import prisma from "@/lib/prisma";
import type { AppointmentFeedbackRole } from "@prisma/client";
import { toPlain } from "@/lib/data/serialize";

const userSelect = {
  select: { id: true, name: true, image: true },
} as const;

const recordingsSelect = {
  select: {
    id: true,
    title: true,
    recordingUrl: true,
    storageUrl: true,
    thumbnailUrl: true,
    status: true,
    durationInMinutes: true,
    recordedAt: true,
  },
} as const;

const slotsInclude = {
  orderBy: { startsAt: "asc" },
  include: {
    user: userSelect,
    meetingSession: {
      select: {
        id: true,
        endedAt: true,
        endedReason: true,
        recordings: recordingsSelect,
      },
    },
  },
} as const;

const consultantProfileSelect = {
  select: { id: true, userId: true, user: userSelect },
} as const;

const consulteeProfileSelect = {
  select: { id: true, userId: true, user: userSelect },
} as const;

const collaboratorsInclude = {
  where: { status: "ACCEPTED" as const },
  select: {
    role: true,
    consultantProfile: consultantProfileSelect,
  },
} as const;

export async function readAppointmentDetail(appointmentId: string) {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      consultation: {
        include: {
          consultationPlan: {
            include: { consultantProfile: consultantProfileSelect },
          },
          requestedBy: consulteeProfileSelect,
        },
      },
      subscription: {
        include: {
          subscriptionPlan: {
            include: { consultantProfile: consultantProfileSelect },
          },
          requestedBy: consulteeProfileSelect,
        },
      },
      webinar: {
        include: {
          webinarPlan: {
            include: {
              consultantProfile: consultantProfileSelect,
              collaborators: collaboratorsInclude,
            },
          },
        },
      },
      class: {
        include: {
          classPlan: {
            include: {
              consultantProfile: consultantProfileSelect,
              collaborators: collaboratorsInclude,
            },
          },
        },
      },
      trialSession: {
        include: {
          consulteeProfile: consulteeProfileSelect,
          subscriptionPlan: {
            include: { consultantProfile: consultantProfileSelect },
          },
        },
      },
      // Display-fields allowlist (#946 pattern) — the counterpart to the
      // booking must not receive gateway ids / tax internals.
      payment: {
        select: {
          id: true,
          amount: true,
          currency: true,
          paymentStatus: true,
          createdAt: true,
          // #1428 — the tentative-hold deadline shown on the detail page;
          // without it a held slot has no way to say when it releases.
          expiresAt: true,
        },
      },
      organization: { select: { id: true, name: true } },
      // #1163 — the live proposal, so the detail page can render it and offer
      // accept / decline / withdraw instead of "Awaiting schedule confirmation".
      rescheduleRequests: {
        where: { status: { in: ["PENDING_REVIEW", "COUNTERED"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          status: true,
          reason: true,
          round: true,
          expiresAt: true,
          initiatorRole: true,
          initiatedById: true,
          proposedSlots: {
            orderBy: { startsAt: "asc" },
            // round: a COUNTERED request carries both rounds; the card must
            // show only the current offer.
            select: { startsAt: true, endsAt: true, round: true },
          },
        },
      },
      slotsOfAppointment: slotsInclude,
    },
  });

  if (!appointment) return null;

  // Whole-program timeline: sibling sessions of the same subscription/class.
  const siblingWhere = appointment.subscriptionId
    ? { subscriptionId: appointment.subscriptionId }
    : appointment.classId
      ? { classId: appointment.classId }
      : null;
  const siblings = siblingWhere
    ? await prisma.appointment.findMany({
        where: { ...siblingWhere, id: { not: appointment.id } },
        include: { slotsOfAppointment: slotsInclude },
      })
    : [];

  return toPlain({ appointment, siblings });
}

export type TAppointmentDetail = NonNullable<
  Awaited<ReturnType<typeof readAppointmentDetail>>
>;

/** Every party to the appointment: the requesting consultee (or trial consultee,
 *  or a slot participant), the plan's consultant, and ACCEPTED collaborators.
 *  Capability-based — participation, not UserRole (#org-appts). Platform
 *  ADMIN/STAFF are handled by the caller via isPrivileged. */
/**
 * #705 — which side of the session this user is on, or null if neither.
 *
 * PROVIDER wins a tie. A consultant who is also somehow on the attendee list
 * must not be counted as an attendee: their CSAT would then feed the org
 * quality average, which is a rating of THEIR OWN work.
 */
export function appointmentRaterRole(
  userId: string,
  detail: TAppointmentDetail,
): AppointmentFeedbackRole | null {
  const { consulteeUserIds, consultantUserIds } = participantUserIds(detail);
  if (consultantUserIds.includes(userId)) return "PROVIDER";
  if (consulteeUserIds.includes(userId)) return "CONSULTEE";
  return null;
}

export function canAccessAppointment(
  userId: string,
  detail: TAppointmentDetail,
): boolean {
  const { consulteeUserIds, consultantUserIds } = participantUserIds(detail);
  return [...consulteeUserIds, ...consultantUserIds].includes(userId);
}

function participantUserIds(detail: TAppointmentDetail) {
  const { appointment } = detail;
  const consulteeUserIds = [
    appointment.consultation?.requestedBy?.userId,
    appointment.subscription?.requestedBy?.userId,
    appointment.trialSession?.consulteeProfile?.userId,
    ...appointment.slotsOfAppointment.flatMap((slot) =>
      slot.user.map((u) => u.id),
    ),
  ];
  const consultantUserIds = [
    appointment.consultation?.consultationPlan?.consultantProfile?.userId,
    appointment.subscription?.subscriptionPlan?.consultantProfile?.userId,
    appointment.webinar?.webinarPlan?.consultantProfile?.userId,
    appointment.class?.classPlan?.consultantProfile?.userId,
    appointment.trialSession?.subscriptionPlan?.consultantProfile?.userId,
    ...(appointment.webinar?.webinarPlan?.collaborators ?? []).map(
      (c) => c.consultantProfile?.userId,
    ),
    ...(appointment.class?.classPlan?.collaborators ?? []).map(
      (c) => c.consultantProfile?.userId,
    ),
  ];
  return { consulteeUserIds, consultantUserIds };
}
export type TDetailAppointment = TAppointmentDetail["appointment"];
export type TDetailRecording =
  TDetailAppointment["slotsOfAppointment"][number] extends {
    meetingSession: infer M;
  }
    ? M extends { recordings: Array<infer R> } | null
      ? R
      : never
    : never;
