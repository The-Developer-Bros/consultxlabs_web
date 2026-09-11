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
import { useQuery } from "@tanstack/react-query";
import { Loader2, AlertTriangle } from "lucide-react";
import { formatCurrencyAmount } from "@/utils/formatting";

/** What `GET /api/appointments/[id]/cancel/preview` answers. */
interface CancelRefundPreview {
  refundPct: number;
  estimatedRefundPaise: number;
  currency: string;
  /**
   * Null when the booking has no live session at all, and on the whole-event
   * rail, which never consults the clock.
   */
  hoursUntilNextSession: number | null;
  prorated: boolean;
  /**
   * Which rail the money comes back on. Null on the whole-event rail, where a
   * roster funds through several at once and no single sentence is true.
   */
  fundingRail: "GATEWAY" | "INTERNAL" | "CREDITS" | null;
  /**
   * Cancelling a class or webinar refunds the entire roster in full, not the
   * viewer's own seat — `estimatedRefundPaise` is then the sum across
   * `attendeeCount` paid attendees.
   */
  wholeEvent?: boolean;
  attendeeCount?: number | null;
}

interface CancelConfirmationDialogProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  title: string;
  consultant: string;
  appointmentType: string;
  isLoading?: boolean;
  /**
   * Booking is APPROVED_PENDING_PAYMENT — nothing has been charged, so the
   * dialog reads as "cancel the request" rather than warning about an
   * irreversible cancellation of a paid session.
   */
  isPendingPayment?: boolean;
  /**
   * #1005 — group self-leave uses different copy than a full booking cancel.
   */
  mode?: "cancel" | "leave";
  /**
   * #1167 — enables the concrete refund quote. Absent means the caller cannot
   * name the Appointment row, and the dialog keeps the policy sentence.
   */
  appointmentId?: string | null;
}

export function CancelConfirmationDialog({
  isOpen,
  onConfirm,
  onCancel,
  title,
  consultant,
  appointmentType,
  isLoading = false,
  isPendingPayment = false,
  mode = "cancel",
  appointmentId,
}: Readonly<CancelConfirmationDialogProps>) {
  const isLeave = mode === "leave";

  // Only the cancel path: an unpaid request has nothing to quote, and leaving a
  // group event refunds through the roster route rather than this one.
  const previewEnabled =
    isOpen && !!appointmentId && !isLeave && !isPendingPayment;
  const {
    data: preview,
    isLoading: isPreviewLoading,
    isError: isPreviewError,
  } = useQuery<CancelRefundPreview>({
      queryKey: ["cancel-refund-preview", appointmentId],
      queryFn: async () => {
        const response = await fetch(
          `/api/appointments/${appointmentId}/cancel/preview`,
          // R18 — the quote had no deadline, and the confirm button is disabled
          // while it loads. A hung request therefore did not just withhold the
          // number, it locked the user out of cancelling their own booking
          // behind a spinner that never stopped.
          { signal: AbortSignal.timeout(8_000) },
        );
        if (!response.ok) throw new Error("Could not estimate the refund");
        return response.json();
      },
      enabled: previewEnabled,
      // Money owed moves with the clock (the notice tiers), so this is never
      // served from cache across openings.
      staleTime: 0,
      gcTime: 0,
      retry: false,
    });

  // Flattened from a nested ternary — Sonar flags nested ternaries in JSX;
  // the three outcomes are easier to skim as sequential assignments.
  let dialogTitle: string;
  if (isLeave) {
    dialogTitle = `Leave ${appointmentType}?`;
  } else if (isPendingPayment) {
    dialogTitle = `Cancel ${appointmentType} request?`;
  } else {
    dialogTitle = `Cancel ${appointmentType}?`;
  }

  /**
   * The refund line. A quote only replaces the policy sentence when the server
   * actually produced one — a 403, a network failure or a booking the preview
   * cannot price all fall back to saying what is still true rather than
   * guessing at a number someone would act on.
   */
  const renderRefundLine = () => {
    if (isPreviewLoading) {
      return (
        <p className="text-muted-foreground text-sm inline-flex items-center gap-1.5">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Checking what you&apos;d get back…
        </p>
      );
    }
    if (!preview) {
      // A quote that timed out or 500'd is a different fact from a booking that
      // was never priced, and the difference matters to someone deciding: one
      // says "we can't tell you right now", the other "there is nothing to
      // tell". Both end at the same rule, which is what still governs the click.
      return (
        <p className="text-muted-foreground text-sm">
          {isPreviewError
            ? "We couldn't load the refund estimate just now — the booking's cancellation policy still applies."
            : "If a payment was captured, any refund follows the booking's cancellation policy."}
        </p>
      );
    }
    // Cancelling a class or webinar is not a quote about the viewer's own seat.
    // The POST route hands the whole event to `refundWholeEventPayments`, which
    // refunds every attendee in full — so an organiser, who owns no seat, was
    // being told "no refund at this notice" about a click that returns the
    // entire roster's money.
    if (preview.wholeEvent) {
      const attendees = preview.attendeeCount ?? 0;
      if (attendees === 0) {
        return (
          <p className="text-muted-foreground text-sm">
            Nobody has paid for a seat yet, so cancelling refunds nothing.
          </p>
        );
      }
      return (
        <p className="text-muted-foreground text-sm">
          Cancelling this event refunds all{" "}
          <strong className="text-foreground">
            {attendees} {attendees === 1 ? "attendee" : "attendees"}
          </strong>{" "}
          in full —{" "}
          <strong className="text-foreground">
            ~
            {formatCurrencyAmount(
              preview.estimatedRefundPaise,
              preview.currency,
            )}
          </strong>{" "}
          in total.
        </p>
      );
    }
    if (preview.fundingRail === "CREDITS") {
      // #1161 — credit restoration is all-or-nothing. Only a full-refund window
      // restores automatically; inside a partial window the cancellation still
      // stands but the credits are escalated for a human, not returned. The
      // dialog said "they'll be restored" for both, which was a promise the
      // money path does not keep.
      if (preview.refundPct === 100) {
        return (
          <p className="text-muted-foreground text-sm">
            You paid with referral credits — they&apos;ll be restored to your
            balance.
          </p>
        );
      }
      return (
        <p className="text-muted-foreground text-sm">
          You paid with referral credits, and this cancellation falls in a
          partial-refund window — restoration is reviewed manually rather than
          returned automatically.
        </p>
      );
    }
    if (preview.estimatedRefundPaise > 0) {
      // The learner never paid on an org-funded booking — the wallet, invoice
      // accrual or licence did — so "your original payment method" names a card
      // that was never charged and promises a settlement that will never arrive.
      const isInternal = preview.fundingRail === "INTERNAL";
      return (
        <p className="text-muted-foreground text-sm">
          {isInternal ? "Your organisation is credited " : "You'll be refunded "}
          <strong className="text-foreground">
            ~
            {formatCurrencyAmount(
              preview.estimatedRefundPaise,
              preview.currency,
            )}
          </strong>{" "}
          ({preview.refundPct}%
          {preview.prorated ? ", prorated for sessions already held" : ""}).{" "}
          {isInternal
            ? "Your organisation's balance is restored; nothing was charged to you."
            : "Refunds reach your original payment method in 5–7 working days."}
        </p>
      );
    }
    return (
      <p className="text-muted-foreground text-sm">
        No refund at this notice — cancelling now returns nothing under the
        booking&apos;s cancellation policy.
      </p>
    );
  };

  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-500" />
            {dialogTitle}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                Are you sure you want to {isLeave ? "leave" : "cancel"}{" "}
                <strong>&quot;{title}&quot;</strong> with{" "}
                <strong>{consultant}</strong>?
              </p>
              {isLeave ? (
                <p className="text-muted-foreground text-sm">
                  You will be removed from this event. If you paid for a seat,
                  a refund is issued under the event&apos;s cancellation policy.
                </p>
              ) : isPendingPayment ? (
                <p className="text-muted-foreground">
                  You haven&apos;t been charged — this releases the approved
                  request without any payment.
                </p>
              ) : (
                <>
                  <p className="text-red-600 font-medium">
                    This action cannot be undone.
                  </p>
                  {previewEnabled ||
                  appointmentType === "Consultation" ||
                  appointmentType === "Subscription" ||
                  appointmentType === "Trial"
                    ? renderRefundLine()
                    : null}
                </>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel} disabled={isLoading}>
            {isLeave ? "Stay enrolled" : "Keep Appointment"}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isLoading || isPreviewLoading}
            className="bg-red-600 text-white hover:bg-red-700 focus:ring-red-600"
          >
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                {isLeave ? "Leaving..." : "Cancelling..."}
              </>
            ) : isLeave ? (
              "Yes, Leave"
            ) : (
              "Yes, Cancel"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
