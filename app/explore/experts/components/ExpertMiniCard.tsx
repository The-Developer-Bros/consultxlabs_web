"use client";

import { memo } from "react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import Link from "next/link";
import { User, Star, Flame, Clock, BadgeCheck } from "lucide-react";
import type { IConsultantCardData } from "@/types/consultant";

interface ExpertMiniCardProps {
  expert: IConsultantCardData;
  badge?: "trending" | "new";
}

function ExpertMiniCardImpl({ expert, badge }: ExpertMiniCardProps) {
  const isTrending = badge === "trending";

  return (
    <Link
      href={`/explore/experts/${expert.id}`}
      className="group flex w-[240px] shrink-0 flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-elevation-1 transition-all duration-300 ease-out hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-elevation-2"
    >
      {badge && (
        <span
          className={`inline-flex w-fit items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${
            isTrending
              ? "border-transparent bg-foreground text-background"
              : "border-border bg-background text-muted-foreground"
          }`}
        >
          {isTrending ? (
            <Flame className="h-3 w-3" />
          ) : (
            <Clock className="h-3 w-3" />
          )}
          {isTrending ? "Trending" : "New"}
        </span>
      )}

      <div className="flex items-center gap-3">
        <Avatar className="h-11 w-11 shrink-0 ring-1 ring-border">
          <AvatarImage
            src={expert.user.image || "/placeholder-user.jpg"}
            alt={expert.user.name || "Expert"}
            className="object-cover"
          />
          <AvatarFallback className="bg-muted text-muted-foreground">
            <User className="h-5 w-5" />
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <h3 className="line-clamp-1 text-sm font-semibold text-foreground">
              {expert.user.name}
            </h3>
            {expert.isVerified && (
              <span title="Verified by Familiarise" className="shrink-0">
                <BadgeCheck className="h-3.5 w-3.5 text-foreground" />
              </span>
            )}
          </div>
          {expert.rating !== null && (
            <div className="flex items-center gap-1">
              <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
              <span className="text-xs font-medium tabular-nums text-muted-foreground">
                {expert.rating.toFixed(1)}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="mt-auto">
        <div className="flex flex-wrap gap-1.5">
          {expert.domain?.name && (
            <span className="inline-flex max-w-full items-center rounded-full border border-transparent bg-foreground px-2.5 py-1 text-xs font-medium text-background">
              <span className="truncate">{expert.domain.name}</span>
            </span>
          )}
          {expert.tags?.slice(0, 2).map((tag) => (
            <span
              key={tag.id}
              className="inline-flex max-w-full items-center rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground"
            >
              <span className="truncate">{tag.name}</span>
            </span>
          ))}
        </div>

        <span className="mt-3 block text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
          View profile →
        </span>
      </div>
    </Link>
  );
}

const ExpertMiniCard = memo(ExpertMiniCardImpl);
export default ExpertMiniCard;
