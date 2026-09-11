import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DashboardViewportFill } from "@/components/dashboard/DashboardViewportFill";
import { PanelHeader } from "@/components/dashboard/PageScaffold";
import prisma from "@/lib/prisma";
import { readAppointmentDetail } from "@/lib/data/appointment-detail";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { safeReturnTo } from "@/lib/navigation/safe-return-to";
import { buildRescheduleSubject } from "@/lib/scheduling/slot-picker-subject";

import { RescheduleClient } from "./RescheduleClient";

/**
 * The consultee's reschedule surface.
 *
 * A page rather than the dialog it replaces: every defect found reviewing that
 * dialog — labels overflowing their column, a legend that would not fit, a
 * selection lost on reload — traced back to width. The route also gives the
 * flow a URL, so "pick a new time" in a notification can link straight here.
 */
type PageProps = {
  params: Promise<{ consulteeId: string; appointmentId: string }>;
  // `string[]` is not hypothetical: a repeated ?returnTo= arrives as an array.
  searchParams: Promise<{ returnTo?: string | string[] }>;
};

// React.cache so generateMetadata() and the page body share one query per request.
const loadDetail = cache(readAppointmentDetail);
const loadConsulteeUserId = cache(async (consulteeId: string) =>
  prisma.consulteeProfile.findUnique({
    where: { id: consulteeId },
    select: { userId: true },
  }),
);

/**
 * Binds the appointment to the URL's consultee. Mirrors the detail page.
 *
 * Shared with generateMetadata deliberately: metadata runs BEFORE the body's
 * guards and is not covered by them, so without this the page `<title>` named
 * the offering and the consultant for any appointment id a signed-in user
 * cared to try.
 */
function consulteeOwns(
  appointment: NonNullable<
    Awaited<ReturnType<typeof loadDetail>>
  >["appointment"],
  consulteeId: string,
  userId: string,
): boolean {
  return (
    appointment.consultation?.requestedBy?.id === consulteeId ||
    appointment.subscription?.requestedBy?.id === consulteeId ||
    appointment.trialSession?.consulteeProfile?.id === consulteeId ||
    appointment.slotsOfAppointment.some((slot) =>
      slot.user.some((user) => user.id === userId),
    )
  );
}

/**
 * Names the booking, not the task. "Reschedule" on a backgrounded tab does not
 * say which of a consultee's sessions is being moved (#1064).
 */
export async function generateMetadata({
  params,
}: Readonly<PageProps>): Promise<Metadata> {
  const { consulteeId, appointmentId } = await params;
  const [detail, profile] = await Promise.all([
    loadDetail(appointmentId).catch(() => null),
    loadConsulteeUserId(consulteeId).catch(() => null),
  ]);
  const generic = { title: "Reschedule — Familiarise" };
  if (!detail || !profile) return generic;
  if (!consulteeOwns(detail.appointment, consulteeId, profile.userId)) {
    return generic;
  }

  const resolved = buildRescheduleSubject(detail);
  if (!resolved) return generic;

  const who = resolved.consultantName ? ` with ${resolved.consultantName}` : "";
  return { title: `Reschedule: ${resolved.title}${who} — Familiarise` };
}

export default async function RescheduleAppointmentPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  const { consulteeId, appointmentId } = await params;
  const { returnTo } = await searchParams;
  // Enforced here rather than in the layout: the layout is a client component,
  // so its check runs only after this server render has already streamed.
  await requirePersonalProfileAccess("consultee", consulteeId);

  const [detail, profile] = await Promise.all([
    loadDetail(appointmentId),
    loadConsulteeUserId(consulteeId),
  ]);
  if (!detail || !profile) notFound();

  // Binds the appointment to the URL's consultee; binding that consultee to
  // the SESSION is the guard above.
  if (!consulteeOwns(detail.appointment, consulteeId, profile.userId)) {
    notFound();
  }

  // #1163 — trials have no reschedule path (the API rejects them at submit),
  // so refuse before drawing a picker whose submit can only fail.
  if (detail.appointment.appointmentType === "TRIAL") {
    return (
      <DashboardViewportFill className="gap-4">
        <div className="flex flex-1 flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            <CalendarX className="h-7 w-7 text-muted-foreground/70" />
          </div>
          <h1 className="text-base font-medium text-foreground">
            Trial sessions can&apos;t be rescheduled
          </h1>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            A trial is a one-off taster at the time your consultant offered.
            If it no longer works, cancel it and request a new one, or message
            your consultant.
          </p>
          <Button variant="outline" size="sm" className="mt-4" asChild>
            <Link href={`/dashboard/consultee/${consulteeId}/appointments`}>
              Back to appointments
            </Link>
          </Button>
        </div>
      </DashboardViewportFill>
    );
  }

  // The picker draws the CONSULTANT's availability, and this route's params
  // carry no consultant — so it is resolved from the booking, here, rather
  // than shipped to the client to look up.
  const resolved = buildRescheduleSubject(detail);
  if (!resolved) notFound();

  // #1166 — org detail pages send ?returnTo= so finishing (or backing out of)
  // a reschedule lands back in the org context instead of this personal list.
  // RescheduleClient router.push()es this, so an off-site value would be an
  // open redirect; safeReturnTo() decides it by parsing, not by prefix.
  const backHref = safeReturnTo(
    returnTo,
    `/dashboard/consultee/${consulteeId}/appointments`,
  );

  return (
    <DashboardViewportFill className="gap-4">
      {/* The BOOKING now lives in the breadcrumb (RescheduleClient sets it via
          useSetBreadcrumbLabel); every reschedule page used to render an
          identical "Reschedule" heading, so the consultee could not tell
          which session they were moving (#1064). */}
      <div className="shrink-0">
        <PanelHeader
          description={
            resolved.consultantName
              ? `Choose a new time for your ${resolved.typeLabel.toLowerCase()} with ${resolved.consultantName}`
              : `Choose a new time for your ${resolved.typeLabel.toLowerCase()}`
          }
        />
      </div>

      <RescheduleClient
        appointmentId={appointmentId}
        title={resolved.title}
        typeLabel={resolved.typeLabel}
        subject={resolved.subject}
        backHref={backHref}
      />
    </DashboardViewportFill>
  );
}
