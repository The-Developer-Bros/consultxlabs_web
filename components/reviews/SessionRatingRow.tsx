"use client";

/**
 * #705 — the private rating for ONE video call, rendered on the session it
 * belongs to.
 *
 * This replaces the standalone CSAT card. That card asked for a rating of "the
 * appointment", which on a subscription booking meant a single score for up to
 * twenty-four calls; and it sat directly above the public review card looking
 * almost identical, so the page read as asking the same question twice. Putting
 * the stars on the session row attaches the question to the thing being
 * answered and removes the duplicate entirely.
 *
 * The consultant sees these, so the copy says so — see AppointmentDetailClient.
 */

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";

export function SessionRatingRow({
  appointmentId,
  slotId,
  existingRating,
  readOnly = false,
}: Readonly<{
  appointmentId: string;
  slotId: string;
  existingRating: number | null;
  /** The consultant's view: what this call scored, not something to set. */
  readOnly?: boolean;
}>) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [rating, setRating] = useState(existingRating ?? 0);
  const [hover, setHover] = useState(0);

  useEffect(() => {
    setRating(existingRating ?? 0);
  }, [existingRating, slotId]);

  const save = useMutation({
    mutationFn: async (value: number) => {
      const res = await fetch(`/api/appointments/${appointmentId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: value, slotId }),
      });
      if (!res.ok) await throwSupportError(res, "session rating");
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["appointment-feedback", appointmentId],
      });
    },
    onError: (e: unknown) => {
      // Put the stars back where they were: leaving the new value on screen
      // claims a rating we did not store. The third mutation argument is the
      // `onMutate` context, not the previous value — this mutation has no
      // `onMutate`, so it was always undefined and the branch that read it was
      // dead. The call site captures the pre-click rating.
      setRating(existingRating ?? 0);
      toast({
        title: "Rating",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  // Nothing to show a consultant on a call nobody rated — an empty star row
  // reads as a zero rather than as an absence.
  if (readOnly && !existingRating) return null;

  if (readOnly) {
    return (
      <div
        className="flex items-center gap-0.5"
        title={`Rated ${existingRating} out of 5 by the attendee`}
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <Star
            key={n}
            className={
              "h-3.5 w-3.5 " +
              // ROUNDED, then named. A group call averages its attendees, so
              // this arrives as 3.5 and a bare `>= n` filled three stars — the
              // consultant read the session as scoring worse than it did.
              // Rounding fixes the direction; printing the number is what makes
              // the row honest, since five stars cannot show a half.
              (Math.round(existingRating ?? 0) >= n
                ? "fill-foreground text-foreground"
                : "text-muted-foreground/30")
            }
          />
        ))}
        <span className="ml-1 text-[10px] tabular-nums text-muted-foreground">
          {existingRating}
        </span>
      </div>
    );
  }

  // The score IS shown to the consultant, so the rater has to be told before
  // they give it. The API comment justifying that disclosure asserted this copy
  // already existed; it did not, and a rating collected as private and handed
  // to the rated party is exactly the CSAT/consumer-review mixing #705 set out
  // to avoid. The free-text note stays withheld from them either way.
  const DISCLOSURE = "Your rating of this call is shared with the expert.";

  return (
    // No handler on the wrapper: a div with onClick is unreachable by keyboard
    // and announces nothing. Each star is a real button and stops propagation
    // itself, which is what keeps the session row from also firing.
    <div className="flex items-center gap-0.5" title={DISCLOSURE}>
      <span className="sr-only">{DISCLOSURE}</span>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={save.isPending}
          aria-label={`Rate ${n} out of 5. ${DISCLOSURE}`}
          aria-pressed={rating === n}
          onMouseEnter={() => setHover(n)}
          onMouseLeave={() => setHover(0)}
          onClick={(e) => {
            e.stopPropagation();
            const previous = rating;
            setRating(n);
            save.mutate(n, { onError: () => setRating(previous) });
          }}
          className="rounded p-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
        >
          <Star
            className={
              "h-3.5 w-3.5 " +
              ((hover || rating) >= n
                ? "fill-foreground text-foreground"
                : "text-muted-foreground/50")
            }
          />
        </button>
      ))}
    </div>
  );
}
