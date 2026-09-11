"use client";

import { AppointmentDetailClient } from "@/components/appointments/detail/AppointmentDetailClient";
import { CONSULTEE_JOIN_WINDOW_MS } from "@/lib/appointments/slots";
import { isConfirmedStatus } from "@/lib/appointments/status";
import { useConsulteeAppointmentsAdapter } from "@/components/appointments/consultee/ConsulteeAppointmentsAdapter";
import { DocumentUpload } from "@/components/appointments/DocumentUpload";

const DOCUMENT_KINDS = new Set(["CONSULTATION", "TRIAL", "SUBSCRIPTION"]);

export default function DetailPageClient({
  consulteeId,
  appointmentId,
}: Readonly<{ consulteeId: string; appointmentId: string }>) {
  const adapter = useConsulteeAppointmentsAdapter();

  return (
    <AppointmentDetailClient
      appointmentId={appointmentId}
      role="consultee"
      adapter={adapter}
      backHref={`/dashboard/consultee/${consulteeId}/appointments`}
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
