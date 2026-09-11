"use client";

import { useState } from "react";
import { format } from "date-fns";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Loader2 } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useSession } from "@/lib/auth-client";
import {
  currentRoundProposedSlots,
  type OpenRescheduleProposal,
} from "@/lib/appointments/consultee-affordances";

/**
 * The open reschedule proposal on an appointment, with its answers (#1163).
 *
 * Counterparty (session user ≠ initiator) gets Accept + Decline; the
 * initiator gets Withdraw. Decline confirms first, because its one surprise
 * is worth spelling out: the released times STAY with the consultant to
 * re-place — declining a proposal is not cancelling the booking.
 *
 * Toasts relay the SERVER's message: accept runs the full allocator and
 * decline/withdraw are CAS transitions, so what actually happened is decided
 * there, not here.
 */

type ProposalAnswer = "accept" | "decline" | "withdraw";

async function postAnswer(
  appointmentId: string,
  kind: ProposalAnswer,
): Promise<{ message?: string }> {
  const url =
    kind === "withdraw"
      ? `/api/appointments/${appointmentId}/reschedule/withdraw`
      : `/api/appointments/${appointmentId}/reschedule/respond`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(kind === "withdraw" ? {} : { body: JSON.stringify({ action: kind }) }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    message?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || "The request could not be completed.");
  }
  return data;
}

const ANSWER_TOAST_TITLE: Record<ProposalAnswer, string> = {
  accept: "New times confirmed",
  decline: "Proposal declined",
  withdraw: "Request withdrawn",
};

interface RescheduleProposalCardProps {
  appointmentId: string;
  proposal: OpenRescheduleProposal;
  /** Which detail page hosts the card — copy only, never authorization. */
  role: "consultee" | "consultant";
}

export function RescheduleProposalCard({
  appointmentId,
  proposal,
  role,
}: Readonly<RescheduleProposalCardProps>) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const [confirmDecline, setConfirmDecline] = useState(false);

  const viewerId = session?.user?.id;
  const isInitiator = !!viewerId && viewerId === proposal.initiatedById;
  const slots = currentRoundProposedSlots(proposal);

  const mutation = useMutation({
    mutationFn: (kind: ProposalAnswer) => postAnswer(appointmentId, kind),
    onSuccess: (data, kind) => {
      setConfirmDecline(false);
      toast({ title: ANSWER_TOAST_TITLE[kind], description: data.message });
      void queryClient.invalidateQueries({
        queryKey: ["appointment-detail", appointmentId],
      });
      // Prefix match — refreshes the events list for every consulteeId/scope.
      void queryClient.invalidateQueries({ queryKey: ["consultee-events"] });
    },
    onError: (error: Error) => {
      setConfirmDecline(false);
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
      // A 409 usually means the other side answered first — refetch so the
      // card stops offering answers to a settled request.
      void queryClient.invalidateQueries({
        queryKey: ["appointment-detail", appointmentId],
      });
    },
  });
  const busy = mutation.isPending;

  let heading: string;
  if (isInitiator) {
    heading = "You asked to reschedule";
  } else if (proposal.initiatorRole === "CONSULTANT") {
    heading =
      role === "consultee"
        ? "Your consultant proposed new times"
        : "New times were proposed for this booking";
  } else {
    // CONSULTEE-role proposals include org admins acting on the payer side
    // (#1166), so a consultee counterparty must not be told "you asked".
    heading =
      role === "consultant"
        ? "Your consultee asked for new times"
        : "New times were proposed for this booking";
  }

  return (
    <div className="rounded-2xl border border-border border-l-4 border-l-primary bg-card p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <CalendarClock className="h-4 w-4 text-muted-foreground" />
          {heading}
        </span>
        {proposal.round > 1 && (
          <Badge
            variant="outline"
            className="border-border px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide"
          >
            Counter-offer
          </Badge>
        )}
      </div>

      {slots.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {slots.map((slot) => {
            const startsAt = new Date(slot.startsAt);
            const endsAt = new Date(slot.endsAt);
            return (
              <li
                key={startsAt.toISOString()}
                className="text-sm font-medium tabular-nums text-foreground"
              >
                {format(startsAt, "EEE, d MMM yyyy · h:mm a")}
                <span className="font-normal text-muted-foreground">
                  {" – "}
                  {format(endsAt, "h:mm a")}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          No specific time was named — the replacement will be picked on the
          calendar.
        </p>
      )}

      {proposal.reason && (
        <p className="mt-2 text-xs italic text-muted-foreground">
          &ldquo;{proposal.reason}&rdquo;
        </p>
      )}

      <p className="mt-2 text-xs text-muted-foreground">
        {isInitiator ? "Expires" : "Needs an answer by"}{" "}
        {format(new Date(proposal.expiresAt), "EEE, d MMM yyyy · h:mm a")}
      </p>

      {viewerId && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
          {isInitiator ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => mutation.mutate("withdraw")}
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Withdraw request
            </Button>
          ) : (
            <>
              {/* Accept needs concrete times; a preference-only request is
                  answered on the calendar (the route 422s it). */}
              {slots.length > 0 && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => mutation.mutate("accept")}
                >
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Accept new times
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                className="text-red-600 border-red-200 hover:bg-red-50 dark:text-red-400 dark:border-red-900/40 dark:hover:bg-red-900/20"
                onClick={() => setConfirmDecline(true)}
              >
                Decline
              </Button>
            </>
          )}
        </div>
      )}

      <AlertDialog
        open={confirmDecline}
        onOpenChange={(open) => !open && setConfirmDecline(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Decline the proposed times?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  You are only turning down these times — you are not
                  cancelling the booking.
                </p>
                <p className="text-sm text-muted-foreground">
                  {role === "consultee"
                    ? "The sessions being moved stay with your consultant, who will place them at new times."
                    : "The released sessions stay in your allocate queue to place at new times."}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep deciding</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              className="bg-red-600 text-white hover:bg-red-700 focus:ring-red-600"
              onClick={(event) => {
                // Keep the dialog open while in flight; onSuccess closes it.
                event.preventDefault();
                mutation.mutate("decline");
              }}
            >
              {busy ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Declining...
                </>
              ) : (
                "Decline proposal"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
