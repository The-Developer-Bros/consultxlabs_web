"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { AppointmentDetailClient } from "@/components/appointments/detail/AppointmentDetailClient";
import { AppointmentDocumentsList } from "@/components/appointments/detail/AppointmentDocumentsList";
import { Button } from "@/components/ui/button";
import { isConfirmedStatus } from "@/lib/appointments/status";
import { CONSULTANT_JOIN_WINDOW_MS } from "@/lib/appointments/slots";
import type { TAppointment } from "@/types/appointment";
import { ConsultantResponseUpload } from "../../documents/ConsultantResponseUpload";
import { useConsultantAppointmentsAdapter } from "../ConsultantAppointmentsAdapter";
import {
  getParticipantManagementUrl,
  supportsParticipantManagement,
} from "../utils/participantHelpers";

const DOCUMENT_KINDS = new Set(["CONSULTATION", "SUBSCRIPTION", "TRIAL"]);

export default function DetailPageClient({
  consultantId,
  appointmentId,
}: Readonly<{ consultantId: string; appointmentId: string }>) {
  const adapter = useConsultantAppointmentsAdapter(consultantId);
  const queryClient = useQueryClient();
  const [uploadOpen, setUploadOpen] = useState(false);

  return (
    <>
      <AppointmentDetailClient
        appointmentId={appointmentId}
        role="consultant"
        adapter={adapter}
        backHref={`/dashboard/consultant/${consultantId}/appointments`}
        joinWindowMs={CONSULTANT_JOIN_WINDOW_MS}
        renderDocuments={(vm) => {
          const canUpload =
            DOCUMENT_KINDS.has(vm.kind) && isConfirmedStatus(vm.status);

          return (
            <div className="space-y-3">
              <AppointmentDocumentsList appointmentId={appointmentId} />
              {canUpload ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setUploadOpen(true)}
                >
                  <Upload className="mr-1.5 h-3.5 w-3.5" />
                  Upload document
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Documents can be uploaded once the booking is confirmed.
                </p>
              )}
            </div>
          );
        }}
        participantsHref={(detail) => {
          const appointment = detail.appointment as unknown as TAppointment;
          return supportsParticipantManagement(appointment)
            ? getParticipantManagementUrl(appointment, consultantId)
            : null;
        }}
      />
      <ConsultantResponseUpload
        appointmentId={appointmentId}
        isOpen={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onSuccess={() => {
          setUploadOpen(false);
          void queryClient.invalidateQueries({
            queryKey: ["appointment-documents", appointmentId],
          });
        }}
      />
    </>
  );
}
