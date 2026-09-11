"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CalendarX, Loader2 } from "lucide-react";

interface UnscheduleConfirmationDialogProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title: string;
  /** "Webinar" / "Class" — the only kinds this action exists for. */
  appointmentType: string;
  isLoading?: boolean;
}

/**
 * Unschedule is one menu row away from Cancel booking and undoes far less, so
 * the whole job of this dialog is to make the two impossible to confuse: the
 * event stays sold, nobody is refunded, and the only thing withdrawn is the
 * date (#1082). Deliberately not styled destructive — it is reversible by
 * setting new times, and a red button here would read as "refund everyone".
 */
export function UnscheduleConfirmationDialog({
  isOpen,
  onConfirm,
  onCancel,
  title,
  appointmentType,
  isLoading = false,
}: Readonly<UnscheduleConfirmationDialogProps>) {
  const kind = appointmentType.toLowerCase();
  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <CalendarX className="h-5 w-5 text-amber-500" />
            Unschedule this {kind}?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                This takes <strong>&quot;{title}&quot;</strong> off the calendar
                and back into your queue, so you can set a new date for it.
              </p>
              <p className="text-muted-foreground">
                The {kind} is still sold and everyone enrolled stays enrolled.
                Nobody is refunded and your earnings do not change.
              </p>
              <p className="text-muted-foreground">
                Attendees will be told the date has been withdrawn, so only do
                this if you intend to set a new one.
              </p>
              <p className="text-muted-foreground text-sm">
                To end the {kind} instead and refund attendees, use{" "}
                <strong>Cancel booking</strong>.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel} disabled={isLoading}>
            Keep the date
          </AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Unscheduling...
              </>
            ) : (
              "Unschedule"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
