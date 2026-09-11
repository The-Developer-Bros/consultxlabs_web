import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DashboardViewportFill } from "@/components/dashboard/DashboardViewportFill";
import { PanelHeader } from "@/components/dashboard/PageScaffold";
import { Badge } from "@/components/ui/badge";
import { allowsManageTimings, upcomingSlots } from "@/lib/appointments/slots";
import { readAppointmentDetail } from "@/lib/data/appointment-detail";
import {
  readManageTimingsTarget,
  type ManageTimingsTarget,
} from "@/lib/data/manage-timings-target";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { buildManageTimingsSubject } from "@/lib/scheduling/manage-timings-subject";
import { isEventIdFormat } from "@/schemas/slotAllocation/validationSchemas";

import { ManageTimingsClient } from "./ManageTimingsClient";

/**
 * The consultant setting the times of their own event instance — the fourth
 * caller of the shared slot-picker surface, and the one `SlotPicker` was
 * generalised FROM. It stayed a dialog the longest because nothing here felt
 * per-appointment enough to deserve a URL; cramped on a real calendar grid
 * regardless, so it gets the same page treatment as the other three.
 *
 * `[appointmentId]` carries two different id shapes here, same as the list
 * that links here: a real `Appointment` row's id once one exists, or the
 * `unscheduled-class-<id>` / `unscheduled-webinar-<id>` synthetic id for an
 * offering that has never been scheduled — see manage-timings-target.ts.
 */
type PageProps = {
  params: Promise<{ consultantId: string; appointmentId: string }>;
};

// React.cache so generateMetadata() and the page body share one query per request.
const loadTarget = cache(readManageTimingsTarget);
const loadDetail = cache(readAppointmentDetail);

/**
 * The counterparty gate, server side (#1082).
 *
 * This surface writes new times with no notice and no acceptance, which is
 * honest only while nobody else has committed to one. The menu already hides
 * it for a 1:1 whose consultee holds a confirmed slot, but the URL is linkable
 * and survives a refresh, so the menu is not the control.
 *
 * Only the two 1:1 kinds need the extra read, and only they pay for it: a
 * group event is allowed regardless. Slots are fetched here rather than
 * widened into `ManageTimingsTarget` to stay clear of #1075; `cache` keeps it
 * to one query across metadata and body.
 */
async function manageTimingsAllowed(
  target: ManageTimingsTarget,
  appointmentId: string,
): Promise<boolean> {
  const kind = target.appointment.appointmentType;
  if (kind !== "CONSULTATION" && kind !== "SUBSCRIPTION") return true;

  const detail = await loadDetail(appointmentId);
  if (!detail) return false;
  // Program-wide, same as the menu's group card: a subscription session is one
  // Appointment among several and any of them may carry the committed time.
  const slots = [
    ...detail.appointment.slotsOfAppointment,
    ...detail.siblings.flatMap((sibling) => sibling.slotsOfAppointment),
  ];
  return allowsManageTimings(kind, upcomingSlots(slots));
}

/**
 * Names the offering, not the task. A consultant with several unscheduled
 * classes had identical "Manage timings" tabs otherwise (#1064).
 */
export async function generateMetadata({
  params,
}: Readonly<PageProps>): Promise<Metadata> {
  const { consultantId, appointmentId } = await params;
  const target = await loadTarget(appointmentId).catch(() => null);
  // Metadata runs BEFORE the body's guards and is not covered by them, so the
  // same ownership check runs here — otherwise the tab title named the
  // offering for any id a signed-in consultant cared to try. The counterparty
  // gate joins it so a route that 404s never gets a titled tab either.
  if (!target || !target.planOwnerIds.includes(consultantId)) {
    return { title: "Manage timings — Familiarise" };
  }
  const allowed = await manageTimingsAllowed(target, appointmentId).catch(
    () => false,
  );
  if (!allowed) return { title: "Manage timings — Familiarise" };

  const resolved = buildManageTimingsSubject(consultantId, target.appointment);
  return { title: `Manage timings: ${resolved.title} — Familiarise` };
}

export default async function ManageTimingsPage({
  params,
}: Readonly<PageProps>) {
  const { consultantId, appointmentId } = await params;
  // Enforced here rather than in the layout: the layout is a client component,
  // so its check runs only after this server render has already streamed.
  await requirePersonalProfileAccess("consultant", consultantId);

  const target = await loadTarget(appointmentId);
  if (!target) notFound();

  // The route's consultant must own the plan or be an ACCEPTED collaborator.
  // Binds the offering to the URL's consultant; the guard above binds that
  // consultant to the session.
  if (!target.planOwnerIds.includes(consultantId)) notFound();

  // Ownership is not the question a booked consultee cares about — see
  // manageTimingsAllowed. Reschedule is the route for that case.
  if (!(await manageTimingsAllowed(target, appointmentId))) notFound();

  const resolved = buildManageTimingsSubject(
    consultantId,
    target.appointment,
    target.completedSessions,
    target.groupTotalSessions,
  );

  // Allocate APIs require UUID/CUID event ids. Hand-crafted mock PKs (legal
  // Prisma String @ids) would 400 on save — fail closed here instead of
  // mounting a picker that cannot submit.
  if (!isEventIdFormat(resolved.subject.eventId)) notFound();

  const backHref = `/dashboard/consultant/${consultantId}/appointments`;

  return (
    <DashboardViewportFill className="gap-4">
      {/* The OFFERING now lives in the breadcrumb (ManageTimingsClient sets it
          via useSetBreadcrumbLabel) — see the reschedule/allocate pages
          (#1064). */}
      <div className="shrink-0 space-y-4">
        <PanelHeader description={resolved.description} />

        {resolved.classInfo && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">Plan: {resolved.classInfo.planType}</Badge>
            <span>
              {resolved.classInfo.sessionsPerWeek} meetings/week ·{" "}
              {resolved.classInfo.durationInMonths} month
              {resolved.classInfo.durationInMonths !== 1 ? "s" : ""} ·{" "}
              {resolved.classInfo.durationInHours}h/session
            </span>
          </div>
        )}

        {resolved.classInfo && (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
            Tip: Each class is{" "}
            {Math.ceil(resolved.classInfo.durationInHours / 0.5)} consecutive
            30-min slots. Complete an in-progress class before starting another.
            Max {resolved.classInfo.sessionsPerWeek} classes per day; weekly
            limit applies.
          </div>
        )}
      </div>

      <ManageTimingsClient
        subject={resolved.subject}
        backHref={backHref}
        title={resolved.title}
      />
    </DashboardViewportFill>
  );
}
