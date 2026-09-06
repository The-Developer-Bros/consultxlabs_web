import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { TConsultantReview } from "@/types/review";
import { Star } from "lucide-react";
import React from "react";

const Review: React.FC<Readonly<TConsultantReview>> = ({
  consulteeProfile,
  createdAt,
  rating,
  reviewDescription,
}) => {
  const reviewerName = consulteeProfile?.user?.name || "Anonymous";
  const reviewerImage = consulteeProfile?.user?.image || null;

  return (
    <li className="flex gap-4 py-5 first:pt-0 last:pb-0">
      <Avatar className="h-9 w-9 ring-1 ring-border">
        {reviewerImage && (
          <AvatarImage src={reviewerImage} alt={reviewerName} />
        )}
        <AvatarFallback className="bg-muted text-sm font-medium text-foreground">
          {reviewerName.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-foreground">
              {reviewerName}
            </p>
            <p className="text-xs text-muted-foreground">
              {new Date(createdAt).toLocaleDateString("en-IN", {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </p>
          </div>
          <div
            className="flex items-center gap-0.5"
            aria-label={`${rating} out of 5 stars`}
          >
            {[...Array(5)].map((_, i) => (
              <Star
                key={`star-${rating}-${i}`}
                className={`h-3.5 w-3.5 ${
                  i < rating
                    ? "fill-amber-400 text-amber-400"
                    : "fill-border text-border"
                }`}
              />
            ))}
          </div>
        </div>
        {reviewDescription && (
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {reviewDescription}
          </p>
        )}
      </div>
    </li>
  );
};

export default Review;
