"use client";

import { useRouter } from "next/navigation";
import { SlotPicker } from "@/components/scheduling/SlotPicker";
import {
  rescheduleConsultantPolicy,
  type SlotPickerSubject,
} from "@/components/scheduling/slot-picker-policy";
import { useConsultantEventActions } from "../../components/useConsultantEventActions";
import type { BookingTypeLabel } from "@/lib/scheduling/slot-picker-subject";
import { useSetBreadcrumbLabel } from "@/components/dashboard/breadcrumb-override";

/**
 * The consultant half of the reschedule page.
 *
 * It exists because the consultant's appointments surface used to mount the
 * CONSULTEE's dialog. Sending it to the consultee route instead would 403 on
 * that route's `requirePersonalProfileAccess("consultee", …)`, so retiring the
 * dialog without this would leave consultants unable to reschedule at all.
 */
export function RescheduleClient({
  consultantId,
  appointmentId,
  title,
  typeLabel,
  subject,
  backHref,
}: Readonly<{
  consultantId: string;
  appointmentId: string;
  title: string;
  typeLabel: BookingTypeLabel;
  subject: SlotPickerSubject;
  backHref: string;
}>) {
  const router = useRouter();
  // Replaces the generic "reschedule" crumb with the booking's own name (#1064).
  useSetBreadcrumbLabel(title);

  const actions = useConsultantEventActions({
    consultantId,
    appointmentId,
    rawSlots: [],
    title,
    type: typeLabel,
  });

  const goBack = () => {
    router.push(backHref);
    router.refresh();
  };

  const policy = rescheduleConsultantPolicy({
    onSubmit: async ({ slotIds, proposedSlots, preference }) => {
      const moved = await actions.handleReschedule(
        slotIds,
        proposedSlots,
        preference,
      );
      if (moved) goBack();
    },
  });

  return (
    <SlotPicker
      className="min-h-0 flex-1"
      policy={policy}
      subject={subject}
      isSubmitting={actions.isLoading}
      onCancel={goBack}
    />
  );
}
