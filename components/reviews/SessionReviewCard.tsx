"use client";

/**
 * #705 — writing a review from the APPOINTMENT detail page, and the first
 * submission surface this product has ever had. `/api/user/reviews` had no
 * caller: the expert page invited people to "Be the first to leave a review!"
 * and there was nowhere to do it, so the entire review corpus could only come
 * from seeds.
 *
 * Deliberately distinct from the per-call rating on the session rows above
 * (`SessionRatingRow`). That one is a PRIVATE rating of a single call; this is
 * a consumer review of the CONSULTANT, one per person, editable. FTC 16 CFR
 * 465.1(d) makes a bare star rating a "consumer review", so merging the two
 * would quietly turn private feedback into a published one.
 *
 * The form itself is `ReviewComposer`, shared with the profile surface — this
 * component only answers "may you review, and about which session", which is a
 * per-user question and so cannot be rendered on the cached profile page.
 */

import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { throwSupportError } from "@/lib/support/error-copy";
import { ReviewComposer, type ExistingReview } from "./ReviewComposer";

interface ReviewableSession {
  appointmentId: string;
  consultantName: string | null;
  title: string;
  existingReview: ExistingReview | null;
}

export function SessionReviewCard({
  appointmentId,
}: Readonly<{ appointmentId: string }>) {
  const queryKey = ["reviewable-session", appointmentId] as const;

  const {
    data: session,
    isError,
    isLoading,
    refetch,
  } = useQuery({
    queryKey,
    queryFn: async (): Promise<ReviewableSession | null> => {
      const res = await fetch(
        `/api/user/reviews/reviewable-sessions?appointmentId=${encodeURIComponent(appointmentId)}`,
      );
      if (!res.ok) await throwSupportError(res, "review eligibility");
      const { data } = await res.json();
      return (data as ReviewableSession[])[0] ?? null;
    },
  });

  // A failed eligibility check is NOT the same as "you cannot review this".
  // Rendering nothing for both is the mistake the Platform tab already made
  // once — it showed a load failure as an empty list and invited the user to
  // file a request they already had open.
  if (isError) {
    return (
      <section className="rounded-xl border border-dashed border-border p-4">
        <p className="text-sm text-muted-foreground">
          Couldn&apos;t check whether you can review this session.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => refetch()}
        >
          Retry
        </Button>
      </section>
    );
  }
  // Still asking, or genuinely not eligible. Showing a disabled form to someone
  // who may never be allowed to use it is worse than showing nothing.
  if (isLoading || !session) return null;

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <ReviewComposer
        appointmentId={session.appointmentId}
        consultantName={session.consultantName}
        contextLine={session.title}
        existing={session.existingReview}
        invalidateKeys={[queryKey]}
      />
    </section>
  );
}
