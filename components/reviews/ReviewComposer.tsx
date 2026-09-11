"use client";

/**
 * #705 — the ONE public-review form.
 *
 * Shared by the profile page, the post-call sheet and nothing else. It exists
 * as its own component because the alternative is three copies drifting apart,
 * and this form carries constraints that must not drift: everyone is asked
 * identically after every held session, with no sentiment gate and no
 * incentive. The FTC preamble is explicit that soliciting only the customers
 * you believe are happy is not a "generalized solicitation", and the programme
 * that tested incentives found incentivised reviews MORE negative with no
 * revenue effect.
 *
 * A review is about the CONSULTANT — one per person, editable. The session is
 * provenance: it proves the review is genuine and it is what granted access to
 * this form.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";

export interface ExistingReview {
  id: string;
  rating: number;
  reviewDescription: string | null;
  isAnonymous?: boolean;
}

export function ReviewComposer({
  appointmentId,
  consultantName,
  contextLine,
  existing,
  invalidateKeys,
  onSaved,
  compact = false,
}: Readonly<{
  /** The session that grants eligibility — provenance, not subject. */
  appointmentId: string;
  consultantName: string | null;
  /** Small line under the heading, e.g. the session title. */
  contextLine?: string;
  existing: ExistingReview | null;
  /** Query keys to refresh once the write lands. */
  invalidateKeys: readonly (readonly unknown[])[];
  onSaved?: () => void;
  compact?: boolean;
}>) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [text, setText] = useState("");
  const [anonymous, setAnonymous] = useState(false);

  // Seed ONCE per review, not on every render of a fresh object. React Query
  // hands back a new object each refetch, so depending on its identity meant a
  // background poll reset the textarea to the saved text — and a user who had
  // just cleared it submitted the old value straight back.
  const seededFor = useRef<string | null>(null);
  const seedKey = existing?.id ?? `none:${appointmentId}`;
  useEffect(() => {
    if (seededFor.current === seedKey) return;
    seededFor.current = seedKey;
    setRating(existing?.rating ?? 0);
    setText(existing?.reviewDescription ?? "");
    setAnonymous(existing?.isAnonymous ?? false);
  }, [seedKey, existing]);

  const save = useMutation({
    mutationFn: async () => {
      // Explicit null when cleared, never undefined: UpdateReviewSchema is
      // `.partial()`, so undefined means "leave it alone" and a consultee
      // deleting their written review could never actually delete it.
      const body = {
        rating,
        reviewDescription: text.trim() || null,
        isAnonymous: anonymous,
      };
      const res = existing
        ? await fetch(`/api/user/reviews/${existing.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : await fetch(`/api/user/reviews`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, appointmentId }),
          });
      if (!res.ok) await throwSupportError(res, "review save");
      return res.json();
    },
    onSuccess: async () => {
      toast({
        title: existing ? "Review updated" : "Thanks for your review",
        description: `It appears on ${consultantName ?? "the expert"}'s profile.`,
      });
      // AWAITED: until this resolves `existing` is still null and the button
      // still reads "Post review", so a second press would POST again and take
      // a 409 off the one-review-per-consultant unique. `isPending` stays true
      // for the duration, which is what keeps the button disabled.
      await Promise.all(
        invalidateKeys.map((queryKey) => qc.invalidateQueries({ queryKey })),
      );
      onSaved?.();
    },
    onError: (e: unknown) => {
      toast({
        title: "Review",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  return (
    <div>
      <h3 className="text-sm font-medium text-foreground">
        {existing ? "Your review of " : "Review "}
        {consultantName ?? "this expert"}
      </h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {contextLine ? `${contextLine} · ` : ""}
        Public — it appears on their profile with the date. One review per
        expert; you can edit it after a later session.
      </p>

      <div className="mt-3 flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            // Every star is the same size and the same affordance. Making the
            // high ones easier to press is a named dark pattern under the CCPA
            // 2023 guidelines, and it is how a rating stops being data.
            onClick={() => setRating(n)}
            onMouseEnter={() => setHover(n)}
            onMouseLeave={() => setHover(0)}
            aria-label={`${n} star${n === 1 ? "" : "s"}`}
            aria-pressed={rating === n}
            className="rounded p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Star
              className={
                (compact ? "h-5 w-5 " : "h-6 w-6 ") +
                ((hover || rating) >= n
                  ? "fill-foreground text-foreground"
                  : "text-muted-foreground")
              }
            />
          </button>
        ))}
      </div>

      <Textarea
        className="mt-3"
        rows={compact ? 2 : 3}
        maxLength={2000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What was useful, and what could have been better? (optional)"
      />

      <label className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={anonymous}
          onChange={(e) => setAnonymous(e.target.checked)}
        />
        {/* Authenticity never depended on the name: the review is welded to a
            paid, attended session either way. Hiding it buys candour from
            someone who may want to book this person again. */}
        <span>
          Post as <strong>Verified client</strong> instead of my name
        </span>
      </label>

      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          disabled={rating === 0 || save.isPending}
          onClick={() => save.mutate()}
        >
          {existing ? "Update review" : "Post review"}
        </Button>
        {/* No confirm-shaming on a low rating: "are you sure you only want to
            give 3 stars?" is a named dark pattern, and it manufactures the
            J-shape it pretends to measure. */}
        <span className="text-xs text-muted-foreground">
          You can edit this later.
        </span>
      </div>
    </div>
  );
}
