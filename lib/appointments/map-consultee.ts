/**
 * Consultee mapper: TConsulteeEventsResponse (the 5-type grouped union from
 * readConsulteeEvents) → AppointmentVM[]. Subscriptions and classes collapse
 * to ONE group row each; their per-session detail lives in vm.sessions.
 */

import type { TAppointment } from "@/types/appointment";
import type {
  TConsulteeEventsResponse,
  TConsulteeWebinar,
  TConsulteeClass,
} from "@/types/consultee-events";
import type {
  TConsultationWithPlan,
  TSubscriptionWithPlan,
  TTrialWithPlan,
} from "@/hooks/useEvents";
import { deriveBucket } from "./bucket";
import { sessionsOfAppointment } from "./sessions-of";
import { getAnchorTime, isSessionOver } from "./slots";
import { normalizeStatus } from "./status";
import { trialMeta } from "./trial-labels";
import {
  sortSessions,
  toDate,
  type AppointmentVM,
  type PersonVM,
  type SlotLike,
} from "./view-model";

interface ConsulteeCollaboratorLike {
  consultantProfile: {
    user: { id: string; name: string; image: string | null };
  } | null;
  role: string;
}

function person(
  user: { name?: string | null; image?: string | null } | null | undefined,
): PersonVM {
  return {
    name: user?.name ?? "Unknown Consultant",
    image: user?.image ?? null,
  };
}

function collaborators(
  list: ConsulteeCollaboratorLike[] | undefined,
): AppointmentVM["collaborators"] {
  if (!Array.isArray(list)) return [];
  return list.map((c) => ({
    name: c.consultantProfile?.user?.name ?? "Collaborator",
    image: c.consultantProfile?.user?.image ?? null,
    role: c.role ?? "",
  }));
}

/**
 * Future/ongoing slots in the shape the existing consultee action hook
 * (useEventActions) receives — mirrors utils/scheduleHelpers.getActualSlots:
 * keep slots whose end hasn't passed, sorted ascending.
 */
function actionableSlots(slots: SlotLike[], now: Date): SlotLike[] {
  return slots
    .filter((slot) => {
      const end = slot.endsAt ? toDate(slot.endsAt) : toDate(slot.startsAt);
      return end.getTime() >= now.getTime();
    })
    .sort(
      (a, b) => toDate(a.startsAt).getTime() - toDate(b.startsAt).getTime(),
    );
}

/** Group progress in calculateSessionProgress semantics: only slot-carrying
 *  child appointments are sessions; completed = all its slots elapsed. */
function groupProgress(
  children: Array<{ id: string; slotsOfAppointment?: SlotLike[] }>,
  now: Date,
): { total: number; completed: number } {
  const withSlots = children.filter(
    (c) => (c.slotsOfAppointment?.length ?? 0) > 0,
  );
  // Per SESSION, not per row: a four-hour booking is not three-quarters
  // complete an hour in.
  const completed = withSlots.filter((c) =>
    sessionsOfAppointment(c).every((s) => isSessionOver(s, now)),
  ).length;
  return { total: withSlots.length, completed };
}

/** The child appointment the action hook should target: the next one with a
 *  live/future slot, else the first slot-carrying child, else the first. */
function nextActionableChild<
  T extends { id: string; slotsOfAppointment?: SlotLike[] },
>(children: T[], now: Date): T | undefined {
  const sorted = [...children].sort((a, b) => {
    const aStart = a.slotsOfAppointment?.[0]
      ? toDate(a.slotsOfAppointment[0].startsAt).getTime()
      : Infinity;
    const bStart = b.slotsOfAppointment?.[0]
      ? toDate(b.slotsOfAppointment[0].startsAt).getTime()
      : Infinity;
    return aStart - bStart;
  });
  return (
    sorted.find((c) =>
      sessionsOfAppointment(c).some((s) => !isSessionOver(s, now)),
    ) ??
    sorted.find((c) => (c.slotsOfAppointment?.length ?? 0) > 0) ??
    sorted[0]
  );
}

function mapConsultation(c: TConsultationWithPlan, now: Date): AppointmentVM {
  const sessions = sessionsOfAppointment(c.appointment);
  const status = normalizeStatus(c.status?.toString());
  return {
    id: `consultation-${c.id}`,
    appointmentId: c.appointment?.id ?? null,
    kind: "CONSULTATION",
    title: c.consultationPlan.title,
    counterpart: person(c.consultationPlan.consultantProfile?.user),
    consultantProfileId: c.consultationPlan.consultantProfile?.id ?? null,
    status,
    ...deriveBucket({ status, sessions, now }),
    nextAt: getAnchorTime(sessions, now),
    sessions,
    group: null,
    meta: null,
    organizationId: c.appointment?.organizationId ?? null,
    pendingPaymentUrl: c.pendingPaymentUrl ?? null,
    collaborators: [],
    collaboratorRole: null,
    raw: {
      appointment: (c.appointment ?? undefined) as TAppointment | undefined,
      rawSlots: actionableSlots(c.appointment?.slotsOfAppointment ?? [], now),
      source: c,
    },
  };
}

function mapSubscription(s: TSubscriptionWithPlan, now: Date): AppointmentVM {
  const children = s.appointments ?? [];
  const sessions = sortSessions(
    children.flatMap((child) => sessionsOfAppointment(child)),
  );
  const status = normalizeStatus(s.status?.toString());
  const target = nextActionableChild(children, now);
  return {
    id: `subscription-${s.id}`,
    appointmentId: target?.id ?? null,
    kind: "SUBSCRIPTION",
    title: s.subscriptionPlan.title,
    counterpart: person(s.subscriptionPlan.consultantProfile?.user),
    consultantProfileId: s.subscriptionPlan.consultantProfile?.id ?? null,
    status,
    ...deriveBucket({ status, sessions, now }),
    nextAt: getAnchorTime(sessions, now),
    sessions,
    group: groupProgress(children, now),
    meta: null,
    organizationId: children[0]?.organizationId ?? null,
    pendingPaymentUrl: s.pendingPaymentUrl ?? null,
    collaborators: [],
    collaboratorRole: null,
    raw: {
      appointment: target as TAppointment | undefined,
      rawSlots: actionableSlots(
        children.flatMap((child) => child.slotsOfAppointment ?? []),
        now,
      ),
      groupAppointments: children as TAppointment[],
      source: s,
    },
  };
}

function mapWebinar(w: TConsulteeWebinar, now: Date): AppointmentVM {
  const sessions = sessionsOfAppointment(w.appointment);
  const status = normalizeStatus(w.status?.toString());
  return {
    id: `webinar-${w.id}`,
    appointmentId: w.appointment?.id ?? null,
    kind: "WEBINAR",
    title: w.webinarPlan.title,
    counterpart: person(w.webinarPlan.consultantProfile?.user),
    consultantProfileId: w.webinarPlan.consultantProfile?.id ?? null,
    status,
    ...deriveBucket({ status, sessions, now }),
    nextAt: getAnchorTime(sessions, now),
    sessions,
    group: null,
    meta: null,
    organizationId: w.appointment?.organizationId ?? null,
    pendingPaymentUrl: null,
    collaborators: collaborators(w.webinarPlan.collaborators),
    collaboratorRole: null,
    raw: {
      appointment: (w.appointment ?? undefined) as TAppointment | undefined,
      rawSlots: actionableSlots(w.appointment?.slotsOfAppointment ?? [], now),
      source: w,
    },
  };
}

function mapClass(c: TConsulteeClass, now: Date): AppointmentVM {
  const children = c.appointments ?? [];
  const sessions = sortSessions(
    children.flatMap((child) => sessionsOfAppointment(child)),
  );
  const status = normalizeStatus(c.status?.toString());
  const target = nextActionableChild(children, now);
  return {
    id: `class-${c.id}`,
    appointmentId: target?.id ?? null,
    kind: "CLASS",
    title: c.classPlan.title,
    counterpart: person(c.classPlan.consultantProfile?.user),
    consultantProfileId: c.classPlan.consultantProfile?.id ?? null,
    status,
    ...deriveBucket({ status, sessions, now }),
    nextAt: getAnchorTime(sessions, now),
    sessions,
    group: groupProgress(children, now),
    meta: null,
    organizationId: children[0]?.organizationId ?? null,
    pendingPaymentUrl: null,
    collaborators: collaborators(c.classPlan.collaborators),
    collaboratorRole: null,
    raw: {
      appointment: target as TAppointment | undefined,
      rawSlots: actionableSlots(
        children.flatMap((child) => child.slotsOfAppointment ?? []),
        now,
      ),
      groupAppointments: children as TAppointment[],
      source: c,
    },
  };
}

function mapTrial(t: TTrialWithPlan, now: Date): AppointmentVM {
  const sessions = sessionsOfAppointment(t.appointment);
  const status = normalizeStatus(t.status);
  return {
    id: `trial-${t.id}`,
    appointmentId: t.appointment?.id ?? null,
    kind: "TRIAL",
    title: t.subscriptionPlan.title,
    counterpart: person(t.subscriptionPlan.consultantProfile?.user),
    consultantProfileId: t.subscriptionPlan.consultantProfile?.id ?? null,
    status,
    ...deriveBucket({ status, sessions, now }),
    nextAt: getAnchorTime(sessions, now),
    sessions,
    group: null,
    meta: trialMeta(
      t.subscriptionPlan.trialPriceInPaise,
      t.subscriptionPlan.trialDurationMinutes,
    ),
    organizationId: t.appointment?.organizationId ?? null,
    // Paid trials carry a live pay-link while AWAITING_PAYMENT.
    pendingPaymentUrl: t.pendingPaymentUrl ?? null,
    collaborators: [],
    collaboratorRole: null,
    raw: {
      appointment: (t.appointment ?? undefined) as TAppointment | undefined,
      rawSlots: actionableSlots(t.appointment?.slotsOfAppointment ?? [], now),
      source: t,
    },
  };
}

export function mapConsulteeEvents(
  data: TConsulteeEventsResponse | undefined,
  now: Date = new Date(),
): AppointmentVM[] {
  if (!data) return [];
  return [
    ...(data.consultations ?? []).map((c) => mapConsultation(c, now)),
    ...(data.subscriptions ?? []).map((s) => mapSubscription(s, now)),
    ...(data.webinars ?? []).map((w) => mapWebinar(w, now)),
    ...(data.classes ?? []).map((c) => mapClass(c, now)),
    ...(data.trials ?? []).map((t) => mapTrial(t, now)),
  ];
}
