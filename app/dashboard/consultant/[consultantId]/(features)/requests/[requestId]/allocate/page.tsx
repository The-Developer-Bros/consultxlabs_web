import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DashboardViewportFill } from "@/components/dashboard/DashboardViewportFill";
import { PanelHeader } from "@/components/dashboard/PageScaffold";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";
import { ALLOCATION_APPROVABLE_FROM } from "@/lib/booking/transitions";
import { readAllocationRequest } from "@/lib/data/allocation-request";

import { AllocateClient } from "./AllocateClient";

/**
 * The consultant's slot-allocation surface.
 *
 * Placing N sessions across a scheduling period under per-day and per-week
 * caps is a page-sized task that was living in a dialog. The heatmap stays —
 * it is the right tool here, unlike on the buyer side — it simply gets room to
 * breathe, plus a URL that survives a refresh and can be linked from the
 * notification that says a request is waiting.
 */
type PageProps = {
  // `requestId` is the CONSULTATION/SUBSCRIPTION id, which is what the
  // allocation endpoints and the grid's event lookup are keyed by. The
  // `Appointment` row is downstream of it and does not exist at all for a
  // request that has never been scheduled — the ordinary case here.
  params: Promise<{ consultantId: string; requestId: string }>;
  searchParams: Promise<{ type?: string }>;
};

// React.cache so generateMetadata() and the page body share one query per request.
const loadRequest = cache(readAllocationRequest);

/**
 * Names the booking, not the task. A consultant working three requests has
 * three of these tabs open, and "Allocate slots" on all of them tells them
 * nothing (#1064).
 */
export async function generateMetadata({
  params,
  searchParams,
}: Readonly<PageProps>): Promise<Metadata> {
  const { consultantId, requestId } = await params;
  const { type } = await searchParams;
  const request = await loadRequest(
    requestId,
    type === "subscription" ? "subscription" : "consultation",
  ).catch(() => null);
  // Metadata runs BEFORE the body's guards and is not covered by them, so the
  // same ownership check runs here — otherwise the tab title named the
  // offering and the buyer for any request id a signed-in consultant tried.
  if (!request || request.consultantProfileId !== consultantId) {
    return { title: "Allocate slots — Familiarise" };
  }

  const who = request.consulteeName ? ` · ${request.consulteeName}` : "";
  return { title: `Allocate: ${request.title}${who} — Familiarise` };
}

export default async function AllocateSlotsPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  const { consultantId, requestId } = await params;
  const { type } = await searchParams;
  // Enforced here rather than in the layout: the layout is a client component,
  // so its check runs only after this server render has already streamed.
  await requirePersonalProfileAccess("consultant", consultantId);

  // The route cannot say which product this is, and every grid fetch is keyed
  // by it. The caller already knows, so it travels in the link.
  const eventType = type === "subscription" ? "subscription" : "consultation";

  const request = await loadRequest(requestId, eventType);
  if (!request) notFound();
  // Binds the request to the URL's consultant; the guard above binds that
  // consultant to the session.
  if (request.consultantProfileId !== consultantId) notFound();
  // This URL outlives the work: it is linkable from a notification, survives a
  // refresh, and goBack() pushes, so the back button returns here once the
  // allocation is done. Without this a consultant reopens a live grid for a
  // request that is already cancelled, rejected or fully placed.
  //
  // ALLOCATION_APPROVABLE_FROM, not `=== PENDING`: a partial reschedule is
  // allocated from this same page, and a subscription is deliberately NOT
  // flipped back to PENDING when one of its sessions is released (#448), so it
  // arrives here still APPROVED.
  if (!ALLOCATION_APPROVABLE_FROM.includes(request.status)) notFound();

  const backHref = `/dashboard/consultant/${consultantId}/requests`;

  return (
    <DashboardViewportFill className="gap-4">
      {/* The BOOKING now lives in the breadcrumb itself (AllocateClient sets
          it via useSetBreadcrumbLabel) — the back link is the breadcrumb's
          own parent crumb. This line keeps the one thing the breadcrumb
          can't say: who the task is for (#1064). */}
      <div className="shrink-0">
        <PanelHeader
          description={
            request.consulteeName
              ? `Allocate slots for ${request.consulteeName}`
              : "Allocate slots"
          }
        />
      </div>

      <AllocateClient
        backHref={backHref}
        title={request.title}
        subject={{
          consultantProfileId: consultantId,
          eventType: request.eventType,
          eventId: request.id,
          counterpartUserId: request.consulteeUserId,
          durationInHours: request.durationInHours,
          sessionDurationInHours: request.sessionDurationInHours,
          sessionsPerWeek: request.sessionsPerWeek,
          durationInMonths: request.durationInMonths,
          totalSessions: request.totalSessions,
          schedulingTimezone: request.schedulingTimezone,
          allowedStart: request.allowedStart,
          allowedEnd: request.allowedEnd,
          hasReleasedSlots: request.hasReleasedSlots,
          slots: request.slots,
        }}
      />
    </DashboardViewportFill>
  );
}
