"use client";

import { MessageSquare, Star } from "lucide-react";
import { TConsultantReview } from "@/types/review";
import Review from "./Review";

interface ReviewsSectionProps {
  reviews: TConsultantReview[];
  /**
   * #705 — the published score, or null when too few sessions have been rated
   * to publish one. Passed in rather than derived here: this list is a `take`
   * page, so averaging it disagreed with the profile's own number for anyone
   * with more reviews than the page size, and it counted a 200-seat webinar's
   * attendees as 200 data points.
   */
  publishedRating: number | null;
  reviewCount: number;
}

export function ReviewsSection({
  reviews,
  publishedRating,
  reviewCount,
}: ReviewsSectionProps) {
  return (
    <section className="rounded-2xl border border-border bg-card p-6 md:p-8">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-foreground">
          Reviews
          <span className="ml-2 text-sm font-normal tabular-nums text-muted-foreground">
            {reviewCount}
          </span>
        </h2>
        {publishedRating !== null ? (
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
            <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
            <span className="font-semibold tabular-nums text-foreground">
              {publishedRating.toFixed(1)}
            </span>
            average from rated sessions
          </p>
        ) : (
          reviewCount > 0 && (
            <p className="mt-1 text-sm text-muted-foreground">
              Not enough rated sessions yet to show an average
            </p>
          )
        )}
      </div>

      {reviews && reviews.length > 0 ? (
        <ul className="mt-6 divide-y divide-border">
          {reviews.map((review) => (
            <Review key={review.id} {...review} />
          ))}
        </ul>
      ) : (
        <div className="mt-6 flex flex-col items-center py-10 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-foreground">
            <MessageSquare className="h-5 w-5" strokeWidth={1.75} />
          </div>
          <p className="mt-4 text-sm font-medium text-foreground">
            No reviews yet
          </p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            After a session with this expert, you can review it from the
            session&apos;s page.
          </p>
        </div>
      )}
    </section>
  );
}
