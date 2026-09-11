"use client";

import { useState } from "react";
import * as Sentry from "@sentry/nextjs";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import type { SlotLike } from "@/lib/appointments/view-model";
import type { SlotPreference } from "@/components/scheduling/slot-picker-policy";

interface UseConsultantEventActionsOptions {
  consultantId: string;
  appointmentId?: string;
  /** Kept for call-site parity with consultee actions / reschedule modal. */
  rawSlots: SlotLike[];
  title: string;
  type: "Consultation" | "Subscription" | "Webinar" | "Class" | "Trial";
}

/**
 * Cancel / reschedule mutations for the consultant appointments surface.
 * Mirrors consultee `useEventActions` against the same APIs, with consultant
 * query-cache invalidation.
 */
export function useConsultantEventActions({
  consultantId,
  appointmentId,
  title,
  type,
}: UseConsultantEventActionsOptions) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(false);

  const invalidateBookingData = () => {
    void queryClient.invalidateQueries({
      queryKey: ["consultant-appointments", consultantId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["consultant-dashboard", consultantId],
    });
    if (appointmentId) {
      void queryClient.invalidateQueries({
        queryKey: ["appointment-detail", appointmentId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["appointment-documents", appointmentId],
      });
    }
  };

  /**
   * Release sessions, optionally naming the times to replace them with.
   *
   * A consultant proposal never auto-confirms — publishing availability is
   * standing consent to be booked inside it, but merely being free is not
   * consent to be moved — so these times are always an offer to the consultee.
   * Resolves true only when the release landed, which is what lets the
   * reschedule page navigate on success and stay put on failure.
   */
  const handleReschedule = async (
    slotIds?: string[],
    proposedSlots?: { startsAt: string; endsAt: string }[],
    // #1065 — only meaningful alongside an absent proposedSlots: how to place
    // the replacement when no time is named.
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

      const sessionsAffected =
        data.sessionsAffected ?? data.slotsAffected ?? slotIds?.length ?? 1;

      toast(
        proposedSlots?.length
          ? {
              title: "Times proposed",
              description:
                "The consultee has been asked to accept the new time.",
            }
          : {
              title: "Ready to reschedule",
              description:
                sessionsAffected === 1
                  ? "Select a new time for this session."
                  : `Select new times for ${sessionsAffected} sessions.`,
            },
      );

      invalidateBookingData();
      return true;
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "client" } },
      );
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

  /**
   * Withdraw a published group event's date without ending the booking.
   *
   * Same route as `handleReschedule`, deliberately: for a WEBINAR/CLASS that
   * call never opened a proposal — there is no single counterparty to propose
   * to — it only released the slots back to the allocate queue. That behaviour
   * was correct and is what this names (#1082). Nothing here touches money,
   * enrolment, earnings or the ledger; that is Cancel.
   */
  const handleUnschedule = async (): Promise<boolean> => {
    if (!appointmentId) {
      toast({
        title: "Error",
        description: "Appointment ID is missing",
        variant: "destructive",
      });
      return false;
    }

    setIsLoading(true);
    try {
      // No `type` param: the route derives it from the DB and only compares
      // when one is supplied, so omitting it cannot mismatch.
      const response = await fetch(
        `/api/appointments/${appointmentId}/reschedule`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to unschedule");
      }

      toast({
        title: `${type} unscheduled`,
        description: `"${title}" is off the calendar and back in your queue. Attendees stay enrolled and have been told the date is withdrawn.`,
      });
      invalidateBookingData();
      return true;
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "client" } },
      );
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to unschedule",
        variant: "destructive",
      });
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancelConfirm = async () => {
    if (!appointmentId) {
      toast({
        title: "Error",
        description: "Appointment ID is missing",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(
        `/api/appointments/${appointmentId}/cancel`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409) {
          toast({
            title: "Booking already updated",
            description:
              "This booking changed state in the meantime — refreshing.",
          });
          invalidateBookingData();
          return;
        }
        throw new Error(data.error || "Failed to cancel appointment");
      }

      const refundNote =
        type === "Consultation" || type === "Subscription"
          ? " Any eligible refund follows your cancellation policy."
          : "";

      toast({
        title: "Appointment cancelled",
        description: `${type} "${title}" has been cancelled.${refundNote}`,
      });
      invalidateBookingData();
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "client" } },
      );
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
    handleReschedule,
    handleUnschedule,
    handleCancelConfirm,
  };
}
