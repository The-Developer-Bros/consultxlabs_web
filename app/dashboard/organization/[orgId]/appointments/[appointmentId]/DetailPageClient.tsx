"use client";

import { useMemo } from "react";

import { AppointmentDetailClient } from "@/components/appointments/detail/AppointmentDetailClient";
import { DocumentUpload } from "@/components/appointments/DocumentUpload";
import { useConsulteeAppointmentsAdapter } from "@/components/appointments/consultee/ConsulteeAppointmentsAdapter";
import { CONSULTEE_JOIN_WINDOW_MS } from "@/lib/appointments/slots";
import { isConfirmedStatus } from "@/lib/appointments/status";

/** Only these kinds carry documents; a webinar or class has no per-attendee file. */
const DOCUMENT_KINDS = new Set(["CONSULTATION", "TRIAL", "SUBSCRIPTION"]);

/**
 * Detail view for one of the member's own org-funded sessions.
 *
 * The org appointment list previously offered a single action — Join, and only
 * inside the join window. It named your counterpart and gave you no way to
 * reach them, reschedule, cancel, or hand over a document; every one of those
 * meant switching to the personal dashboard, for a session the organization
 * paid for. ADR 19 puts org-funded work in the org dashboard, so the actions
 * belong here too.
 *
 * Reuses the same `AppointmentDetailClient` and consultee adapter the B2C tree
 * mounts, which is what makes reschedule, cancel and report identical in both
 * places rather than a second implementation that drifts. Only `detailHref` is
 * overridden, so navigating within the detail view keeps the member inside the
 * org context instead of bouncing them to `/dashboard/consultee/...`.
 *
 * Reschedule still deep-links to the personal consultee reschedule heatmap
 * (no org-native picker yet), but carries a `returnTo` back to THIS page so
 * finishing or abandoning the flow no longer ejects the member into the
 * personal dashboard (#1166). `consulteeId` is passed from the SSR page
 * (already loaded for the participation check) because this URL has `orgId`,
 * not `consulteeId`.
 *
 * `role="consultee"` because this page is the ATTENDING side. An EXPERT
 * delivering org sessions manages them from Requests and their own tree; the
 * two roles want different actions on the same row, and conflating them behind
 * one page is how the appointments surfaces drifted before.
 */
export default function DetailPageClient({
  orgId,
  appointmentId,
  consulteeId,
}: Readonly<{
  orgId: string;
  appointmentId: string;
  consulteeId: string;
}>) {
  const base = useConsulteeAppointmentsAdapter({
    consulteeId,
    rescheduleReturnTo: `/dashboard/organization/${orgId}/appointments/${appointmentId}`,
  });

  const adapter = useMemo(
    () => ({
      ...base,
      detailHref: () =>
        `/dashboard/organization/${orgId}/appointments/${appointmentId}`,
    }),
    [base, orgId, appointmentId],
  );

  return (
    <AppointmentDetailClient
      appointmentId={appointmentId}
      role="consultee"
      adapter={adapter}
      backHref={`/dashboard/organization/${orgId}/appointments`}
      joinWindowMs={CONSULTEE_JOIN_WINDOW_MS}
      renderDocuments={(vm) =>
        DOCUMENT_KINDS.has(vm.kind) && isConfirmedStatus(vm.status) ? (
          <DocumentUpload
            appointmentId={appointmentId}
            appointmentTitle={vm.title}
            appointmentType={vm.kind.charAt(0) + vm.kind.slice(1).toLowerCase()}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            Documents can be shared once the booking is confirmed.
          </p>
        )
      }
    />
  );
}
