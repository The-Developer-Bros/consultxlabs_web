/**
 * Detail-payload mapper: readAppointmentDetail's { appointment, siblings }
 * → one AppointmentVM (plus flattened recordings) so the detail page reuses
 * the shared timeline/badge/action machinery. Role decides the counterpart:
 * consultees see the consultant; consultants see the consultee (or the plan
 * host for group events).
 */

import type {
  TAppointmentDetail,
  TDetailAppointment,
} from "@/lib/data/appointment-detail";
import type { TAppointment } from "@/types/appointment";
import { deriveBucket } from "./bucket";
import { getAnchorTime, isSessionOver } from "./slots";
import { sessionsOfAppointment } from "./sessions-of";
import { normalizeStatus } from "./status";
import { trialMeta } from "./trial-labels";
import {
  sortSessions,
  toDate,
  type AppointmentVM,
  type PersonVM,
  type SlotLike,
} from "./view-model";

type Role = "consultee" | "consultant";

interface DetailRecordingVM {
  id: string;
  title: string;
  url: string | null;
  thumbnailUrl: string | null;
  status: string;
  durationInMinutes: number;
  recordedAt: Date;
  sessionStartsAt: Date;
}

function person(
  user: { name?: string | null; image?: string | null } | null | undefined,
  fallback: string,
): PersonVM {
  return { name: user?.name ?? fallback, image: user?.image ?? null };
}

function eventOf(appointment: TDetailAppointment): {
  title: string;
  status: string;
  consultant: PersonVM;
  consultantProfileId: string | null;
  consultee: PersonVM | null;
  pendingPaymentUrl: string | null;
  collaborators: AppointmentVM["collaborators"];
} {
  const consultation = appointment.consultation;
  const subscription = appointment.subscription;
  const webinar = appointment.webinar;
  const cls = appointment.class;
  const trial = appointment.trialSession;

  if (trial) {
    return {
      title: trial.subscriptionPlan?.title ?? "Trial",
      status: normalizeStatus(trial.status?.toString()),
      consultant: person(
        trial.subscriptionPlan?.consultantProfile?.user,
        "Unknown Consultant",
      ),
      consultantProfileId:
        trial.subscriptionPlan?.consultantProfile?.id ?? null,
      consultee: person(trial.consulteeProfile?.user, "Unknown User"),
      pendingPaymentUrl: null,
      collaborators: [],
    };
  }
  if (consultation) {
    return {
      title: consultation.consultationPlan?.title ?? "Consultation",
      status: normalizeStatus(consultation.status?.toString()),
      consultant: person(
        consultation.consultationPlan?.consultantProfile?.user,
        "Unknown Consultant",
      ),
      consultantProfileId:
        consultation.consultationPlan?.consultantProfile?.id ?? null,
      consultee: person(consultation.requestedBy?.user, "Unknown User"),
      pendingPaymentUrl: consultation.pendingPaymentUrl ?? null,
      collaborators: [],
    };
  }
  if (subscription) {
    return {
      title: subscription.subscriptionPlan?.title ?? "Subscription",
      status: normalizeStatus(subscription.status?.toString()),
      consultant: person(
        subscription.subscriptionPlan?.consultantProfile?.user,
        "Unknown Consultant",
      ),
      consultantProfileId:
        subscription.subscriptionPlan?.consultantProfile?.id ?? null,
      consultee: person(subscription.requestedBy?.user, "Unknown User"),
      pendingPaymentUrl: subscription.pendingPaymentUrl ?? null,
      collaborators: [],
    };
  }
  const plan = webinar?.webinarPlan ?? cls?.classPlan;
  return {
    title: plan?.title ?? (webinar ? "Webinar" : "Class"),
    status: normalizeStatus((webinar?.status ?? cls?.status)?.toString()),
    consultant: person(plan?.consultantProfile?.user, "Unknown Consultant"),
    consultantProfileId: plan?.consultantProfile?.id ?? null,
    consultee: null,
    pendingPaymentUrl: null,
    collaborators: (plan?.collaborators ?? []).map((c) => ({
      name: c.consultantProfile?.user?.name ?? "Collaborator",
      image: c.consultantProfile?.user?.image ?? null,
      role: c.role ?? "",
    })),
  };
}

export function mapAppointmentDetail(
  detail: TAppointmentDetail,
  role: Role,
  now: Date = new Date(),
): { vm: AppointmentVM; recordings: DetailRecordingVM[] } {
  const { appointment, siblings } = detail;
  const facts = eventOf(appointment);
  const all = [appointment, ...siblings];
  // Grouped PER APPOINTMENT before the flatten, or two sittings on different
  // days would merge into one session.
  const sessions = sortSessions(all.flatMap((a) => sessionsOfAppointment(a)));

  const isGroup =
    appointment.appointmentType === "SUBSCRIPTION" ||
    appointment.appointmentType === "CLASS";
  const withSlots = all.filter((a) => a.slotsOfAppointment.length > 0);
  const completed = withSlots.filter((a) =>
    sessionsOfAppointment(a).every((s) => isSessionOver(s, now)),
  ).length;

  const counterpart =
    role === "consultee"
      ? facts.consultant
      : (facts.consultee ?? facts.consultant);

  const rawSlots: SlotLike[] = all
    .flatMap((a) =>
      a.slotsOfAppointment.map((slot) => ({ ...slot }) as SlotLike),
    )
    .filter((slot) => {
      const end = toDate(slot.endsAt ?? slot.startsAt);
      return end.getTime() >= now.getTime();
    })
    .sort(
      (a, b) => toDate(a.startsAt).getTime() - toDate(b.startsAt).getTime(),
    );

  const vm: AppointmentVM = {
    id: `appointment-${appointment.id}`,
    appointmentId: appointment.id,
    kind: appointment.appointmentType as AppointmentVM["kind"],
    title: facts.title,
    counterpart,
    consultantProfileId: facts.consultantProfileId,
    status: facts.status,
    ...deriveBucket({ status: facts.status, sessions, now }),
    nextAt: getAnchorTime(sessions, now),
    sessions,
    group: isGroup ? { total: withSlots.length, completed } : null,
    meta: appointment.trialSession
      ? trialMeta(
          appointment.trialSession.subscriptionPlan?.trialPriceInPaise ?? null,
          appointment.trialSession.subscriptionPlan?.trialDurationMinutes ??
            null,
        )
      : null,
    organizationId: appointment.organizationId ?? null,
    pendingPaymentUrl: facts.pendingPaymentUrl,
    collaborators: facts.collaborators,
    collaboratorRole: null,
    raw: {
      appointment: appointment as unknown as TAppointment,
      rawSlots,
      groupAppointments: all as unknown as TAppointment[],
      source: detail,
    },
  };

  const recordings: DetailRecordingVM[] = all.flatMap((a) =>
    a.slotsOfAppointment.flatMap((slot) =>
      (slot.meetingSession?.recordings ?? []).map((rec) => ({
        id: rec.id,
        title: rec.title,
        url: rec.storageUrl ?? rec.recordingUrl ?? null,
        thumbnailUrl: rec.thumbnailUrl ?? null,
        status: rec.status?.toString() ?? "READY",
        durationInMinutes: rec.durationInMinutes,
        recordedAt: toDate(rec.recordedAt),
        sessionStartsAt: toDate(slot.startsAt),
      })),
    ),
  );
  recordings.sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());

  return { vm, recordings };
}

export type { DetailRecordingVM };
