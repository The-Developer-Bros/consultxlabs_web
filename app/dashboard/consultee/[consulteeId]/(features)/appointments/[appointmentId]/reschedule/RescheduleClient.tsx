"use client";

import { useRouter } from "next/navigation";
import { SlotPicker } from "@/components/scheduling/SlotPicker";
import {
  rescheduleConsulteePolicy,
  type SlotPickerSubject,
} from "@/components/scheduling/slot-picker-policy";
import { useEventActions } from "@/components/appointments/consultee/useEventActions";
import type { BookingTypeLabel } from "@/lib/scheduling/slot-picker-subject";
import { useSetBreadcrumbLabel } from "@/components/dashboard/breadcrumb-override";

/**
 * The consultee half of the reschedule page: the shared picker, the consultee
 * policy, and the mutation hook that already owns this API call and its cache
 * invalidation.
 */
export function RescheduleClient({
  appointmentId,
  title,
  typeLabel,
  subject,
  backHref,
}: Readonly<{
  appointmentId: string;
  title: string;
  typeLabel: BookingTypeLabel;
  subject: SlotPickerSubject;
  backHref: string;
}>) {
  const router = useRouter();
  // Replaces the generic "reschedule" crumb with the booking's own name (#1064).
  useSetBreadcrumbLabel(title);

  const actions = useEventActions({
    appointmentId,
    rawSlots: [],
    title,
    consultant: "",
    type: typeLabel,
  });

  const goBack = () => {
    // The list this returns to was rendered before the release; refresh it or
    // the row still offers "Reschedule" for a booking now awaiting a time.
    router.push(backHref);
    router.refresh();
  };

  const policy = rescheduleConsulteePolicy({
    onSubmit: async ({ slotIds, proposedSlots, preference }) => {
      const moved = await actions.handleReschedule(
        slotIds,
        proposedSlots,
        preference,
      );
      // A failure keeps the page (and the user's selection) so they can retry;
      // the hook has already explained why in a toast.
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
