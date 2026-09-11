"use client";

import { memo } from "react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { User, Star, ArrowRight, Flame, Clock, BadgeCheck, Globe } from "lucide-react";
import { CompanyLogo } from "@/components/ui/company-logo";
import type { IConsultantCardData } from "@/types/consultant";

interface ExpertMiniCardProps {
  expert: IConsultantCardData;
  badge?: "trending" | "new";
}

function ExpertMiniCardImpl({ expert, badge }: ExpertMiniCardProps) {
  return (
    <Link
      href={`/explore/experts/${expert.id}`}
      className="group flex-shrink-0 w-[260px] block"
    >
      <div className="bg-card rounded-2xl p-5 border border-border hover:border-border hover:shadow-lg transition-all duration-300 h-full flex flex-col">
        {/* Badge */}
        {badge && (
          <div className="mb-3">
            {/* Neutral taxonomy, not a status — monochrome, and unlike the
                previous *-100/*-700 pairs these survive dark mode. */}
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${
                badge === "trending"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground border border-border"
              }`}
            >
              {badge === "trending" ? (
                <Flame className="w-3 h-3" />
              ) : (
                <Clock className="w-3 h-3" />
              )}
              {badge === "trending" ? "Trending" : "New"}
            </span>
          </div>
        )}

        {/* Avatar + Name */}
        <div className="flex items-center gap-3 mb-3">
          <Avatar className="h-12 w-12 ring-2 ring-muted group-hover:ring-border transition-all">
            <AvatarImage
              src={expert.user.image || "/placeholder-user.jpg"}
              alt={expert.user.name || "Expert"}
              className="object-cover"
            />
            <AvatarFallback className="bg-primary text-primary-foreground">
              <User className="h-6 w-6" />
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="flex items-center gap-1">
              <h3 className="text-sm font-semibold text-foreground line-clamp-1 group-hover:text-muted-foreground transition-colors">
                {expert.user.name}
              </h3>
              {expert.isVerified && (
                <span title="Verified by Familiarise">
                  <BadgeCheck className="w-3.5 h-3.5 text-foreground flex-shrink-0" />
                </span>
              )}
            </div>
            {expert.rating !== null && (
              <div className="flex items-center gap-1">
                <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                <span className="text-xs font-medium text-muted-foreground">
                  {expert.rating.toFixed(1)}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Bottom section — pinned to bottom for consistent card height */}
        <div className="mt-auto">
          {/* Company Logos */}
          {expert.user.workExperiences &&
            expert.user.workExperiences.length > 0 && (
              <div className="flex items-center gap-1.5 mb-2">
                {expert.user.workExperiences.slice(0, 2).map((exp, i) => (
                  <CompanyLogo
                    key={`${expert.id}-company-${i}`}
                    companyName={exp.company}
                    companyDomain={exp.companyDomain ?? undefined}
                    size={24}
                    className="border-border"
                  />
                ))}
              </div>
            )}

          {/* Languages */}
          {expert.languages && expert.languages.length > 0 && (
            <div className="flex items-center gap-1 mb-2">
              <Globe className="w-3 h-3 text-muted-foreground/70 flex-shrink-0" />
              <p className="text-[10px] text-muted-foreground line-clamp-1">
                {expert.languages.slice(0, 2).join(", ")}
              </p>
            </div>
          )}

          {/* Domain badge */}
          <Badge className="text-[10px] px-2 py-0.5 bg-muted text-muted-foreground hover:bg-muted border-0 w-fit mb-2">
            {expert.domain?.name || "General"}
          </Badge>

          {/* Tags */}
          {expert.tags && expert.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-3">
              {expert.tags.slice(0, 2).map((tag) => (
                <span
                  key={tag.id}
                  className="text-[10px] px-2 py-0.5 bg-muted text-muted-foreground rounded-full"
                >
                  {tag.name}
                </span>
              ))}
            </div>
          )}

          {/* View Profile */}
          <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors">
            <span>View Profile</span>
            <ArrowRight className="w-3 h-3 group-hover:translate-x-1 transition-transform" />
          </div>
        </div>
      </div>
    </Link>
  );
}

const ExpertMiniCard = memo(ExpertMiniCardImpl);
export default ExpertMiniCard;
