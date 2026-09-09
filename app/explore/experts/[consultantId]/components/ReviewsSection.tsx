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
  /**
   * #1300 (ADR 29) — the two tracks, shown side by side rather than blended.
   * NULL on either means SUPPRESSED — below its own threshold — never zero, and
   * the two thresholds are independent, so an expert can be published on one and
   * withheld on the other.
   */
  publishedRatingOneToOne: number | null;
  publishedRatingGroup: number | null;
  ratedClientsOneToOne: number;
  ratedEventsGroup: number;
  /** The per-user "may you review this expert" island. Rendered here because
   *  this is where the review lives and where you read the others. */
  composer?: React.ReactNode;
}

export function ReviewsSection({
  reviews,
  publishedRating,
  reviewCount,
  publishedRatingOneToOne,
  publishedRatingGroup,
  ratedClientsOneToOne,
  ratedEventsGroup,
  composer,
}: ReviewsSectionProps) {
  const tracks = [
    {
      label: "one-to-one",
      score: publishedRatingOneToOne,
      count: ratedClientsOneToOne,
      unit: "clients",
    },
    {
      label: "group sessions",
      score: publishedRatingGroup,
      count: ratedEventsGroup,
      unit: "events",
    },
  ].filter((t) => t.score !== null || t.count > 0);
  // `id="reviews"` so the appointment page can deep-link here: the review
  // composer used to live there, and now only a link does.
  return (
    <div
      id="reviews"
      className="bg-card rounded-2xl border border-border p-6 md:p-8"
    >
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
            <MessageSquare className="w-5 h-5 text-muted-foreground" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-foreground">
              Reviews ({reviewCount})
            </h3>
            {/* Two numbers, not one. Falling back to the blended score keeps the
                header honest for legacy rows, which carry no track and so
                contribute to neither. */}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-1">
              {tracks.length > 0 ? (
                tracks.map((t) => (
                  <div key={t.label} className="flex items-center gap-1">
                    {t.score !== null ? (
                      <>
                        <Star className="w-4 h-4 fill-amber-400 text-amber-400" />
                        <span className="text-sm font-medium text-muted-foreground">
                          {t.score.toFixed(1)} {t.label}
                        </span>
                        <span className="text-xs text-muted-foreground/70">
                          · {t.count} {t.unit}
                        </span>
                      </>
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        Not enough rated {t.label} yet
                      </span>
                    )}
                  </div>
                ))
              ) : // No track has data. Legacy reviews carry no track and so
              // contribute to neither, while still feeding the blended
              // score — 59 of the 62 rows in this database are exactly
              // that — so fall back to it rather than showing nothing about
              // a consultant who does have reviews.
              publishedRating !== null ? (
                <div className="flex items-center gap-1">
                  <Star className="w-4 h-4 fill-amber-400 text-amber-400" />
                  <span className="text-sm font-medium text-muted-foreground">
                    {publishedRating.toFixed(1)} average rating
                  </span>
                </div>
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

      {composer}

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
              After a session with this expert, you can review them here.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
