import { notFound } from "next/navigation";

import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { readAppointmentDetail } from "@/lib/data/appointment-detail";

import DetailPageClient from "./DetailPageClient";

/**
 * One org-funded session, for the member who is on it.
 *
 * Two checks, and they are different questions:
 *
 *   1. `requireOrgAccess` — is the caller a member of this org at all.
 *   2. Below — is this appointment ACTUALLY this org's, and is the caller a
 *      party to it.
 *
 * The second matters because the org id and the appointment id both come from
 * the URL and neither constrains the other. Without it, any member of any org
 * could read any appointment by pairing their own org id with someone else's
 * appointment id — the same shape as the SSR ownership hole closed in #1029,
 * where a server page trusted a route param because a client layout appeared to
 * have checked it.
 *
 * Participation is required rather than `operations.read`: this page renders
 * documents and offers reschedule and cancel, which are participant actions.
 * An operator's view of org sessions stays the metadata-only list, per ADR 20.
 */
export default async function OrgAppointmentDetailPage({
  params,
}: {
  params: Promise<{ orgId: string; appointmentId: string }>;
}) {
  const { orgId, appointmentId } = await params;

  const access = await requireOrgAccess(orgId);
  if (access.error) {
    notFound();
  }

  const userId = access.session.user.id;

  const [detail, profile] = await Promise.all([
    readAppointmentDetail(appointmentId),
    prisma.consulteeProfile.findUnique({
      where: { userId },
      select: { id: true },
    }),
  ]);
  if (!detail || !profile) notFound();

  const { appointment } = detail;

  // Belongs to THIS org — not merely to some org.
  if (appointment.organizationId !== orgId) notFound();

  // And the caller is on it. Mirrors the consultee detail page's participation
  // test: requester, trial consultee, or a user attached to one of the slots.
  const owns =
    appointment.consultation?.requestedBy?.id === profile.id ||
    appointment.subscription?.requestedBy?.id === profile.id ||
    appointment.trialSession?.consulteeProfile?.id === profile.id ||
    appointment.slotsOfAppointment.some((slot) =>
      slot.user.some((u) => u.id === userId),
    );
  if (!owns) notFound();

  return (
    <DetailPageClient
      orgId={orgId}
      appointmentId={appointmentId}
      consulteeId={profile.id}
    />
  );
}
