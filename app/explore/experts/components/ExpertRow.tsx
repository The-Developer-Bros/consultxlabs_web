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

const SCROLL_BUTTON_CLASSNAME =
  "absolute top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card opacity-0 shadow-elevation-2 transition-opacity hover:bg-muted group-hover/row:opacity-100";

function SkeletonCard() {
  return (
    <div className="w-[240px] shrink-0 animate-pulse rounded-2xl border border-border p-4">
      <div className="mb-3 h-6 w-20 rounded-full bg-muted" />
      <div className="mb-3 flex items-center gap-3">
        <div className="h-11 w-11 rounded-full bg-muted" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-3/4 rounded bg-muted" />
          <div className="h-3 w-1/2 rounded bg-muted" />
        </div>
      </div>
      <div className="flex gap-1.5">
        <div className="h-6 w-16 rounded-full bg-muted" />
        <div className="h-6 w-16 rounded-full bg-muted" />
      </div>
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
    <div className="group/row relative">
      <button
        type="button"
        onClick={() => scroll("left")}
        className={`left-0 -translate-x-4 ${SCROLL_BUTTON_CLASSNAME}`}
        aria-label="Scroll left"
      >
        <ChevronLeft className="h-4 w-4 text-muted-foreground" />
      </button>
      <button
        type="button"
        onClick={() => scroll("right")}
        className={`right-0 translate-x-4 ${SCROLL_BUTTON_CLASSNAME}`}
        aria-label="Scroll right"
      >
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </button>

      <div
        ref={scrollRef}
        className="scrollbar-hide flex gap-4 overflow-x-auto pb-2"
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
