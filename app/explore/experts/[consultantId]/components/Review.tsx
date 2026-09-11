import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { TPublicConsultantReview } from "@/types/review";
import Image from "next/image";

import { StarIcon } from "lucide-react";
import React from "react";

const Review: React.FC<Readonly<TPublicConsultantReview>> = ({
  consulteeProfile,
  createdAt,
  rating,
  reviewDescription,
}) => {
  // "Verified client" rather than "Anonymous": the trust here comes from the
  // review being welded to a paid, attended session, and that is worth saying
  // out loud when the name is withheld. The server has already removed the
  // name — this is the label for that, not the mechanism.
  const reviewerName = consulteeProfile?.user?.name || "Verified client";
  const reviewerImage = consulteeProfile?.user?.image || null;

  return (
    <div className="flex items-start space-x-4 p-4 bg-card rounded-lg shadow-sm">
      <Avatar className="w-10 h-10">
        {reviewerImage && (
          <AvatarImage src={reviewerImage} alt={reviewerName} />
        )}
        <AvatarFallback>{reviewerName.charAt(0).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="flex-1">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h4 className="text-md font-semibold text-foreground">
              {reviewerName}
            </h4>
            <p className="text-xs text-muted-foreground">
              {new Date(createdAt).toLocaleDateString("en-IN")}
            </p>
          </div>
          <div className="flex items-center">
            {[...Array(5)].map((_, i) => (
              <StarIcon
                key={`star-${rating}-${i}`}
                className={`w-4 h-4 ${i < rating ? "text-yellow-400" : "text-muted"}`}
              />
            ))}
          </div>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {reviewDescription}
        </p>
        <div className="flex items-center gap-1.5 mt-3 pt-3 border-t border-border">
          <Image
            src="/avif/static/assets/logos/images/logos/Familiarise-logos_transparent.avif"
            alt="Familiarise"
            width={14}
            height={14}
          />
          <span className="text-[10px] text-muted-foreground/70">
            Reviewed on Familiarise
          </span>
        </div>
      </div>
    </div>
  );
};

export default Review;
