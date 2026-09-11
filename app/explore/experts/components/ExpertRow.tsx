"use client";

import { memo, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { IConsultantCardData } from "@/types/consultant";
import ExpertMiniCard from "./ExpertMiniCard";

interface ExpertRowProps {
  experts: IConsultantCardData[];
  badge?: "trending" | "new";
  isLoading?: boolean;
}

function SkeletonCard() {
  return (
    <div className="flex-shrink-0 w-[260px] rounded-2xl border border-border p-5 animate-pulse">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-12 h-12 rounded-full bg-muted" />
        <div className="space-y-2 flex-1">
          <div className="h-4 bg-muted rounded w-3/4" />
          <div className="h-3 bg-muted rounded w-1/2" />
        </div>
      </div>
      <div className="h-5 bg-muted rounded-full w-16 mb-2" />
      <div className="flex gap-1 mb-3">
        <div className="h-4 bg-muted rounded-full w-14" />
        <div className="h-4 bg-muted rounded-full w-14" />
      </div>
      <div className="h-3 bg-muted rounded w-20" />
    </div>
  );
}

function ExpertRowImpl({ experts, badge, isLoading }: ExpertRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const scroll = (direction: "left" | "right") => {
    if (!scrollRef.current) return;
    const amount = 280;
    scrollRef.current.scrollBy({
      left: direction === "left" ? -amount : amount,
      behavior: "smooth",
    });
  };

  if (isLoading) {
    return (
      <div className="flex gap-4 overflow-hidden">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (experts.length === 0) return null;

  return (
    <div className="relative group/row">
      {/* Scroll buttons */}
      <button
        onClick={() => scroll("left")}
        className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-4 z-10 w-10 h-10 rounded-full bg-card border border-border shadow-lg flex items-center justify-center opacity-0 group-hover/row:opacity-100 transition-opacity hover:bg-muted"
        aria-label="Scroll left"
      >
        <ChevronLeft className="w-5 h-5 text-muted-foreground" />
      </button>
      <button
        onClick={() => scroll("right")}
        className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-4 z-10 w-10 h-10 rounded-full bg-card border border-border shadow-lg flex items-center justify-center opacity-0 group-hover/row:opacity-100 transition-opacity hover:bg-muted"
        aria-label="Scroll right"
      >
        <ChevronRight className="w-5 h-5 text-muted-foreground" />
      </button>

      {/* Scrollable row */}
      <div
        ref={scrollRef}
        className="flex gap-4 overflow-x-auto scrollbar-hide pb-2"
        style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
      >
        {experts.map((expert) => (
          <ExpertMiniCard key={expert.id} expert={expert} badge={badge} />
        ))}
      </div>
    </div>
  );
}

const ExpertRow = memo(ExpertRowImpl);
export default ExpertRow;
