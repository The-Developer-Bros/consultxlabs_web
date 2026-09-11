"use client";

import { Star, MessageSquare } from "lucide-react";
import { TPublicConsultantReview } from "@/types/review";
import Review from "./Review";

interface ReviewsSectionProps {
  reviews: TPublicConsultantReview[];
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
    <div className="bg-card rounded-2xl border border-border p-6 md:p-8">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
            <MessageSquare className="w-5 h-5 text-muted-foreground" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-foreground">
              Reviews ({reviewCount})
            </h3>
            <div className="flex items-center gap-1 mt-0.5">
              {publishedRating !== null ? (
                <>
                  <Star className="w-4 h-4 fill-amber-400 text-amber-400" />
                  <span className="text-sm font-medium text-muted-foreground">
                    {publishedRating.toFixed(1)} average rating
                  </span>
                </>
              ) : (
                reviewCount > 0 && (
                  <span className="text-sm text-muted-foreground">
                    Not enough rated sessions yet to show an average
                  </span>
                )
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        {reviews && reviews.length > 0 ? (
          reviews.map((review) => <Review key={review.id} {...review} />)
        ) : (
          <div className="text-center py-12">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-muted flex items-center justify-center">
              <MessageSquare className="w-8 h-8 text-muted-foreground/70" />
            </div>
            <p className="text-muted-foreground">No reviews yet</p>
            <p className="text-sm text-muted-foreground/70 mt-1">
              After a session with this expert, you can review it from the
              session&apos;s page.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
