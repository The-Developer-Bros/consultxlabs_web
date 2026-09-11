"use client";

import { useState } from "react";
import * as Sentry from "@sentry/nextjs";
import { useToast } from "@/hooks/use-toast";
import { useParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import type { SlotOfAppointment } from "@prisma/client";
import {
  CONSULTEE_JOIN_WINDOW_MS,
  getJoinableSlot as getJoinableSlotShared,
} from "@/lib/appointments/slots";
import type { SlotPreference } from "@/components/scheduling/slot-picker-policy";

interface UseEventActionsOptions {
  appointmentId?: string;
  rawSlots: SlotOfAppointment[];
  title: string;
  consultant: string;
  type: "Consultation" | "Subscription" | "Webinar" | "Class" | "Trial";
  /** #1163 — the org detail route has no `[consulteeId]` param, so a caller
   * that resolved the id another way must thread it or invalidation no-ops. */
  consulteeId?: string;
}

/**
 * Which of the three reschedule outcomes happened.
 *
 * They must not read alike: the time is already yours, the consultant has been
 * asked, or nothing was proposed and they will pick. Lifted out of the handler
 * so the branching lives next to the copy it produces rather than inflating a
 * function that also does auth, fetch and error handling.
 */
function rescheduleOutcomeToast(outcome: {
  autoConfirmed: boolean;
  proposedTimes: boolean;
  sessionsAffected: number;
}): { title: string; description: string } {
  if (outcome.autoConfirmed) {
    return {
      title: "New time confirmed",
      description: "Your session has been moved. Nothing further is needed.",
    };
  }
  if (outcome.proposedTimes) {
    return {
      title: "Request sent",
      description:
        "That time isn't free, so we've asked your consultant to confirm it.",
    };
  }
  return {
    title: "Ready to reschedule",
    description:
      outcome.sessionsAffected === 1
        ? "Your consultant will pick a new time for your session."
        : `Your consultant will pick new times for your ${outcome.sessionsAffected} sessions.`,
  };
}

/** What the cancel route reports about the money, in the buyer's words. */
type CancelRefund = {
  amountRefundedPaise: number;
  refundPct: number;
  status?: "REFUNDED" | "FAILED" | "NOTHING_REFUNDABLE" | "POLICY_ZERO";
  requiresManualReview?: boolean;
  /**
   * Which rail returned the money. The cancel route has answered this since
   * #1325 and the toast ignored it, so an org-funded learner — whose card was
   * never charged — was told a refund was on its way back to them.
   */
  rail?: "GATEWAY" | "INTERNAL" | "CREDITS";
} | null;

function describeRefund(refund: CancelRefund): string {
  // A free booking has no money to speak about.
  if (!refund) return "";

  // Branch on what the route SAYS happened, never on the amount: zero is
  // equally "the policy owes nothing", "the balance was already exhausted" and
  // "the gateway refused", and only one of those deserves an apology.
  switch (refund.status) {
    case "FAILED":
      return "We could not complete your refund automatically — our team has been alerted and will sort it out.";
    case "NOTHING_REFUNDABLE":
      // No alert was raised here, so do not claim one was.
      return "This booking had already been refunded, so there is nothing further to return.";
    case "POLICY_ZERO":
      return "No refund applies under the cancellation policy for this booking.";
    default:
      break;
  }

  // An org-funded booking reverses in the ledger against the org's wallet,
  // invoice or licence — the learner's card was never charged, so "on its way
  // back to you" is a promise nobody kept. Checked before the credit sentence so
  // an internal reversal can never be described as a referral credit.
  if (refund.rail === "INTERNAL") {
    return "The refund goes back to your organisation's account.";
  }

  // #1500 — a credit-funded booking settles as a REFUNDED restoration that moves no
  // gateway money, so the amount is legitimately zero and the sentence has to come
  // from the status rather than the number.
  if (refund.status === "REFUNDED" && refund.amountRefundedPaise === 0) {
    return "Your referral credit has been restored in full.";
  }

  if (refund.amountRefundedPaise > 0) {
    const rupees = (refund.amountRefundedPaise / 100).toLocaleString("en-IN", {
      maximumFractionDigits: 2,
    });
    return `A refund of ₹${rupees} (${refund.refundPct}%) is on its way back to you.`;
  }
  return "";
}

export function useEventActions({
  appointmentId,
  rawSlots,
  title,
  consultant: _consultant,
  type,
  consulteeId: consulteeIdOverride,
}: UseEventActionsOptions) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const params = useParams<{ consulteeId: string }>();
  // Caller's resolved id first: on the org detail route the param is absent,
  // and trusting it alone made every invalidation there a silent no-op. #1163
  const consulteeId = consulteeIdOverride || params?.consulteeId;

  // Refresh every surface that renders this booking (events across all org
  // scopes via prefix match, plus the home pending-payments widget) without
  // the full-page reload that used to nuke the react-query cache and SPA
  // state after cancel/reschedule.
  const invalidateBookingData = () => {
    // The detail hub renders this booking on every dashboard — always
    // refresh it, whatever route the action came from. #1163
    if (appointmentId) {
      void queryClient.invalidateQueries({
        queryKey: ["appointment-detail", appointmentId],
      });
    }
    // Outside the consultee route the id may be absent; an undefined key
    // segment would silently match nothing — bail instead.
    if (!consulteeId) return;
    void queryClient.invalidateQueries({
      queryKey: ["consultee-events", consulteeId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["pending-payments", consulteeId],
    });
  };

  const [isLoading, setIsLoading] = useState(false);
  const [showRescheduleDialog, setShowRescheduleDialog] = useState(false);
  const [showConfirmReschedule, setShowConfirmReschedule] = useState(false);
  const [showReportDialog, setShowReportDialog] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);

  const getJoinableSlot = (): SlotOfAppointment | null =>
    getJoinableSlotShared(rawSlots ?? [], {
      joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
    });

  const handleRescheduleClick = (isMultiSession: boolean) => {
    if (isMultiSession) {
      setShowRescheduleDialog(true);
    } else {
      setShowConfirmReschedule(true);
    }
  };

  /** Resolves true only when the release actually landed — the reschedule page
   *  navigates away on that, and must stay put (with the selection) on a
   *  failure the user can retry. */
  const handleReschedule = async (
    slotIds?: string[],
    proposedSlots?: { startsAt: string; endsAt: string }[],
    // #1065 — only meaningful alongside an absent proposedSlots: how to place
    // the replacement when the consultee names no time.
    preference?: SlotPreference,
  ): Promise<boolean> => {
    if (!appointmentId) {
      toast({
        title: "Error",
        description: "Appointment ID is missing",
        variant: "destructive",
      });
      return false;
    }

    setIsLoading(true);
    setShowRescheduleDialog(false);

    try {
      const url =
        type === "Subscription"
          ? `/api/appointments/${appointmentId}/reschedule?type=SUBSCRIPTION`
          : `/api/appointments/${appointmentId}/reschedule`;

      const payload: Record<string, unknown> = {};
      if (slotIds && slotIds.length > 0) payload.slotIds = slotIds;
      if (proposedSlots?.length) payload.proposedSlots = proposedSlots;
      if (preference?.preferredTimeOfDay)
        payload.preferredTimeOfDay = preference.preferredTimeOfDay;
      if (preference?.preferredDays)
        payload.preferredDays = preference.preferredDays;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: Object.keys(payload).length ? JSON.stringify(payload) : undefined,
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to request reschedule");
      }

      // #448 — show the SESSION count, not the slot count: a 1-hour session is
      // 2 × 30-min slots, so the old slotsAffected label read "2 sessions" for a
      // single session. sessionsAffected is the distinct-appointment count.
      const sessionsAffected =
        data.sessionsAffected ?? data.slotsAffected ?? slotIds?.length ?? 1;

      toast(
        rescheduleOutcomeToast({
          autoConfirmed: !!data.autoConfirmed,
          proposedTimes: !!proposedSlots?.length,
          sessionsAffected,
        }),
      );

      invalidateBookingData();
      return true;
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "client" } },
      );
      console.error("Error requesting reschedule:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to request reschedule",
        variant: "destructive",
      });
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancelClick = () => {
    if (!appointmentId) {
      toast({
        title: "Error",
        description: "Appointment ID is missing",
        variant: "destructive",
      });
      return;
    }
    setShowCancelDialog(true);
  };

  const handleCancelConfirm = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(
        `/api/appointments/${appointmentId}/cancel`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      const data = await response.json();
      if (!response.ok) {
        // 409 = the CAS transition guard matched zero rows: the booking
        // already changed state (double-cancel, consultant approved a
        // stale tab, …). The list refresh IS the answer — not an error.
        if (response.status === 409) {
          toast({
            title: "Booking already updated",
            description:
              "This booking changed state in the meantime — refreshing.",
          });
          setShowCancelDialog(false);
          invalidateBookingData();
          return;
        }
        throw new Error(data.error || "Failed to cancel appointment");
      }
      // The route reports what happened to the money on `refund`. Discarding
      // it meant a cancellation that refunded nothing — or failed to refund —
      // looked exactly like one that paid out in full.
      toast({
        title: "Appointment cancelled",
        description: [
          `Your ${type.toLowerCase()} "${title}" has been cancelled.`,
          describeRefund(data.refund),
        ]
          .filter(Boolean)
          .join(" "),
      });
      setShowCancelDialog(false);
      invalidateBookingData();
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "client" } },
      );
      console.error("Error cancelling appointment:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to cancel appointment",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return {
    isLoading,
    joinableSlot: getJoinableSlot(),
    showRescheduleDialog,
    setShowRescheduleDialog,
    showConfirmReschedule,
    setShowConfirmReschedule,
    showReportDialog,
    setShowReportDialog,
    showCancelDialog,
    setShowCancelDialog,
    handleRescheduleClick,
    handleReschedule,
    handleCancelClick,
    handleCancelConfirm,
  };
}
