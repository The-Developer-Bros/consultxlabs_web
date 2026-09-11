"use client";

import { useRouter } from "next/navigation";
import { SlotPicker } from "@/components/scheduling/SlotPicker";
import {
  allocatePolicy,
  type SlotPickerSubject,
} from "@/components/scheduling/slot-picker-policy";
import { toast } from "@/components/ui/use-toast";
import { allocatedElsewhere } from "@/lib/scheduling/allocationMessages";
import { useSetBreadcrumbLabel } from "@/components/dashboard/breadcrumb-override";

/**
 * The consultant's allocation surface, replacing the dialog the requests table
 * used to open. The grid owns the submit here — `useEventSlotAllocation`
 * inside it POSTs the allocation — so this only decides where to go
 * afterwards.
 */
export function AllocateClient({
  subject,
  backHref,
  title,
}: Readonly<{
  subject: SlotPickerSubject;
  backHref: string;
  title: string;
}>) {
  const router = useRouter();
  // Replaces the generic "allocate" crumb with the booking's own name (#1064).
  useSetBreadcrumbLabel(title);

  const goBack = () => {
    router.push(backHref);
    router.refresh();
  };

  const policy = allocatePolicy({
    onSubmit: () => {
      toast({
        title: "Schedule confirmed",
        description: "All session times have been scheduled.",
      });
      goBack();
    },
    // 409: another session allocated this request first. The list IS the
    // answer — the row will simply be gone.
    onConflict: () => {
      toast(allocatedElsewhere());
      goBack();
    },
  });

  return (
    <SlotPicker
      className="min-h-0 flex-1"
      policy={policy}
      subject={subject}
      onCancel={goBack}
    />
  );
}
