"use client";

/**
 * #705 — writing a review from the CONSULTANT's profile, which is where the
 * review lives and where you read the others.
 *
 * A client island on purpose. The expert profile is statically cached (ISR plus
 * `unstable_cache` tags) and that is what makes explore fast; rendering a
 * per-user answer server-side would either force the page dynamic or risk one
 * viewer's eligibility landing in a shared cache entry. This asks at runtime
 * and renders nothing until it has an answer.
 */

import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { throwSupportError } from "@/lib/support/error-copy";
import { ReviewComposer, type ExistingReview } from "./ReviewComposer";

interface ReviewableSession {
  appointmentId: string;
  consultantName: string | null;
  title: string;
  heldAt: string | null;
  existingReview: ExistingReview | null;
}

export function ProfileReviewComposer({
  consultantProfileId,
  consultantName,
}: Readonly<{ consultantProfileId: string; consultantName: string | null }>) {
  const queryKey = ["reviewable-for-consultant", consultantProfileId] as const;

  const { data, isError, isLoading, refetch } = useQuery({
    queryKey,
    // Signed-out visitors are the common case on a public profile; a 401 is an
    // answer ("nothing to offer"), not a failure worth retrying or shouting
    // about.
    retry: false,
    queryFn: async (): Promise<ReviewableSession[]> => {
      const res = await fetch(
        `/api/user/reviews/reviewable-sessions?consultantProfileId=${encodeURIComponent(consultantProfileId)}`,
      );
      if (res.status === 401) return [];
      if (!res.ok) await throwSupportError(res, "review eligibility");
      const { data } = await res.json();
      return data as ReviewableSession[];
    },
  });

  // A failed check is NOT "you may not review". Rendering nothing for both is
  // the mistake the Platform tab made once — a load failure shown as an empty
  // state.
  if (isError) {
    return (
      <div className="rounded-xl border border-dashed border-border p-4">
        <p className="text-sm text-muted-foreground">
          Couldn&apos;t check whether you can review this expert.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (isLoading || !data?.length) return null;

  // Most recent qualifying session — the provenance the write records.
  const session = data[0];

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <ReviewComposer
        appointmentId={session.appointmentId}
        consultantName={consultantName ?? session.consultantName}
        contextLine={session.title}
        existing={session.existingReview}
        invalidateKeys={[queryKey]}
      />
    </div>
  );
}
