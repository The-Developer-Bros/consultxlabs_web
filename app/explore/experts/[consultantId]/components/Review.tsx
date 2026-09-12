import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { TPublicConsultantReview } from "@/types/review";
import Image from "next/image";

import { StarIcon } from "lucide-react";
import React from "react";

const Review: React.FC<Readonly<TPublicConsultantReview>> = ({
  consulteeProfile,
  consultantProfile,
  createdAt,
  rating,
  reviewDescription,
  editedAt,
  replyBody,
  repliedAt,
}) => {
  // "Verified client" rather than "Anonymous": the trust here comes from the
  // review being welded to a paid, attended session, and that is worth saying
  // out loud when the name is withheld. The server has already removed the
  // name — this is the label for that, not the mechanism.
  const reviewerName = consulteeProfile?.user?.name || "Verified client";
  const reviewerImage = consulteeProfile?.user?.image || null;
  const consultantName = consultantProfile?.user?.name || null;

  // Same radius, border and padding as the composer above it: a flat list of
  // siblings, with nothing that reads as nested under anything else.
  return (
    <div className="flex items-start gap-4 rounded-xl border border-border bg-card p-4">
      <Avatar className="w-10 h-10">
        {reviewerImage && (
          <AvatarImage src={reviewerImage} alt={reviewerName} />
        )}
        <AvatarFallback>{reviewerName.charAt(0).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h4 className="text-md font-semibold text-foreground">
              {reviewerName}
            </h4>
            <p className="text-xs text-muted-foreground">
              {new Date(createdAt).toLocaleDateString("en-IN")}
              {/* #1300 — BIS IS 19000:2022 asks that an edited review be shown as
                  edited. Every edit is marked, deliberately: making the mark
                  conditional on the expert having replied would hand them a
                  switch, since replying to everything would brand every
                  subsequent revision. */}
              {editedAt && <span className="ml-1.5">· Edited</span>}
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
        {/* #1300 — the expert's right of reply. `sanitisePublicReview` has already
            dropped the body if staff removed the reply, so a present body here is
            one that is meant to be read. A public review of a named professional
            with no way to answer it is the shape every benchmarked platform has
            moved away from. */}
        {/* A flat footer of the same card, not an inset box: the reply is a
            property of this review, and there is no thread beneath it. */}
        {replyBody && (
          <div className="mt-3 pt-3 border-t border-border">
            <p className="text-xs font-medium text-foreground">
              {consultantName
                ? `Reply from ${consultantName}`
                : "Response from the expert"}
              {repliedAt && (
                <span className="ml-1.5 font-normal text-muted-foreground">
                  · {new Date(repliedAt).toLocaleDateString("en-IN")}
                </span>
              )}
            </p>
            <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
              {replyBody}
            </p>
          </div>
        )}
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
