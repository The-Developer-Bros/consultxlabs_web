import { THIRTY_MIN_MS } from "@/utils/timeSlotsProcessing";

/** #997 Phase 2 — tooltip display metadata for a booked slot. Only computed
 * (and only ever returned) when the caller is the owning consultant/staff —
 * this route is otherwise PUBLIC/unauthenticated (consultee browsing), so
 * participant names must never leak onto that path. */
export interface OverlapAppointmentMeta {
  id: string;
  type: string;
  title: string;
  with?: string;
}

/** Minimal shape the overlap-metadata builder needs — a subset of the
 * detail-mode Prisma appointment include. */
export interface AppointmentForOverlapMeta {
  id: string;
  appointmentType: string;
  slotsOfAppointment: { id: string; startsAt: Date; endsAt: Date }[];
  consultation?: {
    consultationPlan?: { title?: string | null } | null;
    requestedBy?: { user?: { name?: string | null } | null } | null;
  } | null;
  subscription?: {
    subscriptionPlan?: { title?: string | null } | null;
    requestedBy?: { user?: { name?: string | null } | null } | null;
  } | null;
  webinar?: { webinarPlan?: { title?: string | null } | null } | null;
  class?: { classPlan?: { title?: string | null } | null } | null;
}

export function extractOverlapTitleAndParticipant(
  appt: AppointmentForOverlapMeta,
): { title: string; with?: string } {
  switch (appt.appointmentType) {
    case "CONSULTATION":
      return {
        title: appt.consultation?.consultationPlan?.title || "Consultation",
        with: appt.consultation?.requestedBy?.user?.name || undefined,
      };
    case "SUBSCRIPTION":
      return {
        title: appt.subscription?.subscriptionPlan?.title || "Subscription",
        with: appt.subscription?.requestedBy?.user?.name || undefined,
      };
    case "WEBINAR":
      return { title: appt.webinar?.webinarPlan?.title || "Webinar" };
    case "CLASS":
      return { title: appt.class?.classPlan?.title || "Class" };
    default:
      return { title: appt.appointmentType || "Unknown" };
  }
}

/** Buckets each appointment's display metadata by every 30-min epoch bucket
 * its slot spans — mirrors buildAppointmentIndex's alignment so a lookup with
 * {@link overlapMetaCandidatesFor} finds the same overlaps getSlotBookingStatus
 * would. */
export function buildOverlapMetaIndex(
  appointments: AppointmentForOverlapMeta[],
): Map<number, OverlapAppointmentMeta[]> {
  const index = new Map<number, OverlapAppointmentMeta[]>();
  for (const appt of appointments) {
    const { title, with: withUser } = extractOverlapTitleAndParticipant(appt);
    const meta: OverlapAppointmentMeta = {
      id: appt.id,
      type: appt.appointmentType,
      title,
      with: withUser,
    };
    for (const slot of appt.slotsOfAppointment) {
      if (!slot.startsAt || !slot.endsAt) continue;
      const startMs = new Date(slot.startsAt).getTime();
      const endMs = new Date(slot.endsAt).getTime();
      if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs) continue;
      const firstBucket = Math.floor(startMs / THIRTY_MIN_MS);
      const lastBucket = Math.floor((endMs - 1) / THIRTY_MIN_MS);
      for (let b = firstBucket; b <= lastBucket; b++) {
        const bucket = index.get(b);
        if (bucket) bucket.push(meta);
        else index.set(b, [meta]);
      }
    }
  }
  return index;
}

/** Dedupe-by-id overlap lookup spanning every 30-min bucket [startMs, endMs)
 * touches — safe even if the interval isn't itself epoch-aligned. */
export function overlapMetaCandidatesFor(
  index: Map<number, OverlapAppointmentMeta[]>,
  startMs: number,
  endMs: number,
): OverlapAppointmentMeta[] {
  const firstBucket = Math.floor(startMs / THIRTY_MIN_MS);
  const lastBucket = Math.floor((endMs - 1) / THIRTY_MIN_MS);
  const seen = new Set<string>();
  const out: OverlapAppointmentMeta[] = [];
  for (let b = firstBucket; b <= lastBucket; b++) {
    const bucket = index.get(b);
    if (!bucket) continue;
    for (const m of bucket) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        out.push(m);
      }
    }
  }
  return out;
}
