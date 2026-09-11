"use client";

/**
 * Participant roster for a group session — one route for webinars and classes.
 *
 * There were four of these: `webinars/[webinarId]`, `classes/[classId]`,
 * `consultations/[consultationId]` and `subscriptions/[subscriptionId]`.
 *
 * The last two were unreachable — `supportsParticipantManagement()` only
 * returns true for webinar/class, so nothing ever linked to them — and that
 * gate is right: consultations and subscriptions are 1-on-1, so their
 * "roster" was a list of two people (the consultation page literally rendered
 * `participants.length/2 (1-on-1 consultation)`). They're deleted rather than
 * wired up, along with the `getParticipantManagementUrl` branches that
 * emitted hrefs to them.
 *
 * The remaining two were ~270 lines each and collapse to this one route. Most
 * of the difference was the entity noun (`webinarEvent`/`webinarPlan` vs
 * `classEvent`/`classPlan`) and the API path segment, but not all of it: a
 * class carries `appointments: Appointment[]` while a webinar carries a single
 * `appointment | null`, so the two are narrowed rather than cast and the
 * appointment list is normalised before the participant flattening.
 */

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { TableSkeleton } from "@/components/dashboard/DashboardSkeletons";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { effectiveMaxParticipants } from "@/lib/events/capacity";
import { formatCurrencyAmount } from "@/utils/formatting";

import type { ClassEvent, WebinarEvent } from "@/types/planner-events";

/** URL segment → API path segment and the noun used in the count line. */
const EVENT_KINDS = {
  webinars: { apiSegment: "webinar", countNoun: "registered" },
  classes: { apiSegment: "class", countNoun: "participants" },
} as const;

type EventKind = keyof typeof EVENT_KINDS;

/**
 * The two responses differ in more than naming: a class carries
 * `appointments: Appointment[]`, a webinar a single `appointment | null`.
 * Narrowing on the key rather than casting keeps that difference honest.
 */
type ParticipantsResponse =
  | { webinarEvent: WebinarEvent; classEvent?: never }
  | { classEvent: ClassEvent; webinarEvent?: never };

// Registered-participant rows are flattened from the event's slot users.
type RegisteredParticipant = { id: string; name?: string; email?: string };

/**
 * What the DELETE handler answers (#1003). `refund` is null when the seat was
 * never paid for, and `{ amountRefundedPaise: 0 }` when the policy tier
 * returned nothing — two different facts the toast has to keep apart.
 */
type RemoveParticipantResult = {
  removed: boolean;
  refund: {
    amountRefundedPaise: number;
    refundPct: number;
    /** Null when nothing moved. See the toast: only GATEWAY reaches them. */
    rail?: "GATEWAY" | "INTERNAL" | "CREDITS" | null;
  } | null;
};

const fetchParticipants = async (
  apiSegment: string,
  eventId: string,
): Promise<ParticipantsResponse> => {
  const response = await fetch(`/api/participants/${apiSegment}/${eventId}`);
  if (!response.ok) throw new Error("Failed to fetch event data");
  return response.json();
};

const removeParticipant = async ({
  apiSegment,
  eventId,
  userId,
}: {
  apiSegment: string;
  eventId: string;
  userId: string;
}): Promise<RemoveParticipantResult> => {
  const response = await fetch(
    `/api/participants/${apiSegment}/${eventId}?userId=${userId}`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error("Failed to remove participant");
  // Only the class and webinar handlers are reachable (EVENT_KINDS admits no
  // others) and both answer JSON — a refund summary since #1003. Both also
  // answer 200 for an already-removed participant, so a repeat click still
  // invalidates the roster rather than surfacing a failure.
  return response.json();
};

export default function EventParticipantsPage() {
  const params = useParams();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // The person the confirm dialog is about; null closes it.
  const [pendingRemoval, setPendingRemoval] =
    useState<RegisteredParticipant | null>(null);

  const eventType = params.eventType as string;
  const eventId = params.eventId as string;
  const kind = EVENT_KINDS[eventType as EventKind];

  const { data, isLoading, error } = useQuery({
    queryKey: ["event-participants", eventType, eventId],
    queryFn: () => fetchParticipants(kind.apiSegment, eventId),
    enabled: !!eventId && !!kind,
  });

  const removeParticipantMutation = useMutation({
    mutationFn: removeParticipant,
    // The organiser is told what actually happened to the money, not a generic
    // "removed". A removal issues a refund server-side and used to say so
    // nowhere at all — the response was explicitly discarded.
    onSuccess: (result) => {
      queryClient.invalidateQueries({
        queryKey: ["event-participants", eventType, eventId],
      });
      let description: string;
      if (!result.removed) {
        description = "They were already off the roster — nothing changed.";
      } else if (!result.refund) {
        description =
          "No payment was found for this seat, so nothing was refunded.";
      } else if (result.refund.amountRefundedPaise > 0) {
        // INR: settlement is INR-only by design, and the refund summary
        // carries no currency of its own.
        const amount = formatCurrencyAmount(
          result.refund.amountRefundedPaise,
          "INR",
        );
        const pct = `${result.refund.refundPct}% of the seat`;
        // Only the gateway rail reaches the attendee. An org-funded seat
        // returns to the sponsor's wallet/accrual/licence and a credit-funded
        // one to the buyer's referral balance — telling the organiser it lands
        // on a card in 5–7 working days was false on both.
        if (result.refund.rail === "INTERNAL") {
          description = `${amount} (${pct}) went back to the sponsoring organisation's balance; nothing was charged to them.`;
        } else if (result.refund.rail === "CREDITS") {
          description = `${amount} (${pct}) was restored to their referral credit balance.`;
        } else {
          description = `${amount} refunded (${pct}). It reaches them in 5–7 working days.`;
        }
      } else {
        description = `No refund was due under the cancellation policy (${result.refund.refundPct}%).`;
      }
      toast({ title: "Participant removed", description });
    },
    onError: (err, variables) => {
      Sentry.captureException(
        err instanceof Error ? err : new Error(String(err)),
        { tags: { subsystem: "client" } },
      );
      console.error("Error removing participant:", err);
      // A lost response is not proof of a lost write: the DELETE may have
      // disconnected the attendee AND issued their refund before the
      // connection dropped. "Nothing was changed and no refund was issued" was
      // the one claim this handler cannot support, and a retry cannot recover
      // the original refund result either — it would answer `removed: false`.
      // Refresh the roster instead, and say only what is actually known.
      queryClient.invalidateQueries({
        queryKey: ["event-participants", eventType, eventId],
      });
      toast({
        title: "Could not confirm the removal",
        description:
          "We couldn't confirm whether they were removed or refunded. The roster has been refreshed — try again if they're still listed.",
        variant: "destructive",
        action: (
          <ToastAction
            altText="Retry removing this participant"
            onClick={() => removeParticipantMutation.mutate(variables)}
          >
            Retry
          </ToastAction>
        ),
      });
    },
  });

  // Only webinars and classes have a roster worth managing. Anything else in
  // the URL is a hand-edit or a stale link.
  if (!kind) notFound();

  const handleConfirmRemoval = () => {
    if (!pendingRemoval) return;
    removeParticipantMutation.mutate({
      apiSegment: kind.apiSegment,
      eventId,
      userId: pendingRemoval.id,
    });
    setPendingRemoval(null);
  };

  if (isLoading) return <TableSkeleton />;
  if (error) {
    return (
      <Card className="mt-6">
        <CardContent className="py-10 text-center space-y-3">
          <p className="text-sm text-muted-foreground">
            We couldn&apos;t load this roster.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              queryClient.invalidateQueries({
                queryKey: ["event-participants", eventType, eventId],
              })
            }
          >
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  const event = data?.webinarEvent ?? data?.classEvent;
  if (!event) return <div>Event not found</div>;

  const plan = "webinarPlan" in event ? event.webinarPlan : event.classPlan;

  // A class has many appointments; a webinar has at most one. Normalise so
  // the flattening below is identical for both.
  const appointments =
    "appointments" in event
      ? event.appointments
      : event.appointment
        ? [event.appointment]
        : [];

  // Unique participants by user id, flattened out of the event's slots.
  const participants = Array.from(
    new Map(
      appointments
        .flatMap((appointment) =>
          (appointment.slotsOfAppointment || []).flatMap(
            (slot) => slot.user || [],
          ),
        )
        .map((user) => [user.id, user]),
    ).values(),
  );

  // The instance may override the plan's capacity.
  const effectiveCapacity = effectiveMaxParticipants(event, plan);

  const registeredColumns: ResponsiveColumn<RegisteredParticipant>[] = [
    { key: "name", header: "Name", primary: true, cell: (p) => p.name },
    { key: "email", header: "Email", cell: (p) => p.email },
    {
      key: "status",
      header: "Status",
      cell: () => (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
          Registered
        </span>
      ),
    },
  ];

  const renderRegisteredActions = (participant: RegisteredParticipant) => (
    <Button
      variant="outline"
      size="sm"
      onClick={() => setPendingRemoval(participant)}
      disabled={removeParticipantMutation.isPending}
    >
      {removeParticipantMutation.isPending ? "Removing..." : "Remove"}
    </Button>
  );

  return (
    <>
      <DashboardHeader
        title={`${plan.title} — Participants`}
        subtitle={`${participants.length}/${effectiveCapacity} ${kind.countNoun}${
          participants.length >= effectiveCapacity ? " · sold out" : ""
        }`}
        actions={
          <Link
            href={`/dashboard/consultant/${params.consultantId}/appointments`}
            passHref
          >
            <Button variant="outline" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" /> Back to Appointments
            </Button>
          </Link>
        }
      />
      <Card className="mt-6">
        <CardContent className="pt-6">
          <ResponsiveTable<RegisteredParticipant>
            columns={registeredColumns}
            rows={participants}
            getRowId={(p) => p.id}
            rowActions={renderRegisteredActions}
            empty={
              <div className="py-8 text-center text-muted-foreground">
                No registered participants yet.
              </div>
            }
          />
        </CardContent>
      </Card>

      {/* Removing someone spends money: the seat is refunded under the
          organiser tier, which is a full refund at any notice. One click with
          no confirmation and no mention of the refund is not a decision the
          organiser got to make. */}
      <AlertDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {pendingRemoval?.name ?? "this participant"}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  They lose access to {plan.title} and their seat is released
                  back to the event.
                </p>
                <p>
                  Because you are removing them, their seat is refunded in full
                  under the organiser tier of the cancellation policy — at any
                  notice, including after the session has started. A seat that
                  was never paid for refunds nothing.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them enrolled</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={handleConfirmRemoval}
            >
              Remove and refund
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
