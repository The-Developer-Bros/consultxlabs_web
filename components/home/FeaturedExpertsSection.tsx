"use client";

import { BadgeCheck, Star } from "lucide-react";
import Link from "next/link";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { IConsultantCardData } from "@/types/consultant";
import { SectionIntro } from "./SectionIntro";

function ExpertCard({ expert }: { expert: IConsultantCardData }) {
  const subtitle = expert.headline || expert.domain?.name;
  const hasRating = expert.rating !== null;
  const hasExperience = expert.experience !== null;

  return (
    <Link
      href={`/explore/experts/${expert.id}`}
      className="group mx-2 block w-[300px] flex-shrink-0 rounded-2xl border border-border bg-card p-5 shadow-elevation-1 transition-all duration-300 ease-out hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-elevation-2"
    >
      <div className="flex items-center gap-3">
        <Avatar className="h-14 w-14 border border-border">
          <AvatarImage
            src={expert.user.image ?? "/placeholder-user.jpg"}
            alt={expert.user.name ?? "Expert"}
          />
          <AvatarFallback className="bg-muted text-base font-medium text-foreground">
            {expert.user.name?.charAt(0) ?? "E"}
          </AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 items-center gap-1.5">
          <h3 className="line-clamp-1 font-semibold text-foreground">
            {expert.user.name}
          </h3>
          {expert.isVerified && (
            <BadgeCheck className="h-4 w-4 shrink-0 text-foreground" />
          )}
        </div>
      </div>

      {subtitle && (
        <p className="mt-4 line-clamp-1 text-sm text-muted-foreground">
          {subtitle}
        </p>
      )}

      {(hasRating || hasExperience) && (
        <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          {hasRating && (
            <span className="flex items-center gap-1">
              <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
              <span className="font-medium tabular-nums text-foreground">
                {expert.rating?.toFixed(1)}
              </span>
            </span>
          )}
          {hasRating && hasExperience && <span aria-hidden>·</span>}
          {hasExperience && (
            <span className="tabular-nums">{expert.experience} yrs</span>
          )}
        </div>
      )}

      {expert.tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {expert.tags.slice(0, 2).map((tag) => (
            <span
              key={tag.id}
              className="inline-flex items-center rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground"
            >
              {tag.name}
            </span>
          ))}
        </div>
      )}
    </Link>
  );
}

function ExpertLoadingSkeleton() {
  return (
    <div className="mx-2 h-[196px] w-[300px] flex-shrink-0 animate-pulse rounded-2xl border border-border bg-muted" />
  );
}

interface FeaturedExpertsSectionProps {
  experts: IConsultantCardData[];
  isLoading: boolean;
}

export function FeaturedExpertsSection({
  experts,
  isLoading,
}: FeaturedExpertsSectionProps) {
  return (
    <section className="overflow-hidden bg-background py-20 md:py-28">
      <div className="container mx-auto px-4 md:px-6">
        <SectionIntro
          eyebrow="Featured experts"
          title="Learn from industry leaders"
          lede="Handpicked professionals ready to guide your journey."
          action={{ label: "View all experts →", href: "/explore/experts" }}
        />
      </div>

      <div className="relative">
        <div className="pointer-events-none absolute bottom-0 left-0 top-0 z-10 w-24 bg-gradient-to-r from-background to-transparent" />
        <div className="pointer-events-none absolute bottom-0 right-0 top-0 z-10 w-24 bg-gradient-to-l from-background to-transparent" />

        <div className="flex animate-marquee hover:[animation-play-state:paused]">
          {isLoading
            ? Array.from({ length: 6 }).map((_, i) => (
                <ExpertLoadingSkeleton key={i} />
              ))
            : [...experts, ...experts].map((expert, i) => (
                <ExpertCard key={`${expert.id}-${i}`} expert={expert} />
              ))}
        </div>
      </div>
    </section>
  );
}
