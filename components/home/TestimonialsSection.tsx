"use client";

import { useMemo } from "react";
import { Star } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { ReviewWithProfiles } from "@/types/review";
import { SectionIntro } from "./SectionIntro";

function TestimonialCard({ review }: { review: ReviewWithProfiles }) {
  return (
    <div className="mx-2 w-[360px] flex-shrink-0 rounded-2xl border border-white/10 bg-white/[0.04] p-6">
      {/* An untexted review still says something honest — the score and who it
          was for. It does not get a fabricated quote to fill the space. */}
      {review.reviewDescription && (
        <p className="line-clamp-4 text-[15px] leading-relaxed text-zinc-200">
          &ldquo;{review.reviewDescription}&rdquo;
        </p>
      )}

      <div className="mt-5 flex items-center gap-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <Star
            key={i}
            className={
              i < review.rating
                ? "h-3.5 w-3.5 fill-amber-400 text-amber-400"
                : "h-3.5 w-3.5 text-zinc-700"
            }
          />
        ))}
      </div>

      <div className="mt-5 flex items-center gap-3">
        <Avatar className="h-8 w-8 border border-white/10">
          <AvatarImage src={review.consulteeProfile?.user?.image ?? ""} />
          <AvatarFallback className="bg-white/10 text-xs text-zinc-300">
            {review.consulteeProfile?.user?.name?.charAt(0) ?? "U"}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">
            {review.consulteeProfile?.user?.name || "Anonymous"}
          </p>
          <p className="truncate text-xs text-zinc-500">
            Session with {review.consultantProfile?.user?.name}
          </p>
        </div>
      </div>
    </div>
  );
}

function TestimonialLoadingSkeleton() {
  return (
    <div className="mx-2 h-[212px] w-[360px] flex-shrink-0 animate-pulse rounded-2xl border border-white/10 bg-white/[0.04]" />
  );
}

interface TestimonialsSectionProps {
  reviews: ReviewWithProfiles[];
  isLoading: boolean;
}

export function TestimonialsSection({
  reviews,
  isLoading,
}: TestimonialsSectionProps) {
  // Ensure enough items for smooth marquee
  const displayReviews = useMemo(
    () =>
      reviews.length >= 3 ? reviews : [...reviews, ...reviews, ...reviews],
    [reviews],
  );

  return (
    <section className="overflow-hidden bg-zinc-950 py-20 text-white md:py-28">
      <div className="container mx-auto px-4 md:px-6">
        <SectionIntro
          eyebrow="Reviews"
          title="What people say after a session"
          tone="dark"
        />
      </div>

      <div className="relative mb-4">
        <div className="pointer-events-none absolute bottom-0 left-0 top-0 z-10 w-24 bg-gradient-to-r from-zinc-950 to-transparent" />
        <div className="pointer-events-none absolute bottom-0 right-0 top-0 z-10 w-24 bg-gradient-to-l from-zinc-950 to-transparent" />

        <div className="flex animate-marquee hover:[animation-play-state:paused]">
          {isLoading
            ? Array.from({ length: 4 }).map((_, i) => (
                <TestimonialLoadingSkeleton key={i} />
              ))
            : [...displayReviews, ...displayReviews, ...displayReviews].map(
                (review, i) => (
                  <TestimonialCard
                    key={`ltr-${review.id}-${i}`}
                    review={review}
                  />
                ),
              )}
        </div>
      </div>

      <div className="relative">
        <div className="pointer-events-none absolute bottom-0 left-0 top-0 z-10 w-24 bg-gradient-to-r from-zinc-950 to-transparent" />
        <div className="pointer-events-none absolute bottom-0 right-0 top-0 z-10 w-24 bg-gradient-to-l from-zinc-950 to-transparent" />

        <div className="flex animate-marquee-reverse hover:[animation-play-state:paused]">
          {isLoading
            ? Array.from({ length: 4 }).map((_, i) => (
                <TestimonialLoadingSkeleton key={i} />
              ))
            : [...displayReviews, ...displayReviews, ...displayReviews]
                .reverse()
                .map((review, i) => (
                  <TestimonialCard
                    key={`rtl-${review.id}-${i}`}
                    review={review}
                  />
                ))}
        </div>
      </div>
    </section>
  );
}
