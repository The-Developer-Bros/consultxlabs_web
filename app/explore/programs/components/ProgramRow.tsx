"use client";

import { memo, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Program } from "@/lib/explore/programs";
import ProgramCard, { ProgramBadge } from "./ProgramCard";

interface ProgramRowProps {
  programs: Program[];
  badge?: ProgramBadge;
  isLoading?: boolean;
}

const SCROLL_BUTTON_CLASSNAME =
  "absolute top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card opacity-0 shadow-elevation-2 transition-opacity hover:bg-muted group-hover/row:opacity-100";

function SkeletonCard() {
  return (
    <div className="w-[320px] shrink-0 overflow-hidden rounded-2xl border border-border md:w-[360px]">
      <div className="aspect-[16/10] animate-pulse bg-muted" />
      <div className="space-y-2 p-4">
        <div className="h-5 w-3/4 animate-pulse rounded bg-muted" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
        <div className="mt-3 h-5 w-1/3 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}

function ProgramRowImpl({ programs, badge, isLoading }: ProgramRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const scroll = (direction: "left" | "right") => {
    if (!scrollRef.current) return;
    const amount = 380;
    scrollRef.current.scrollBy({
      left: direction === "left" ? -amount : amount,
      behavior: "smooth",
    });
  };

  if (isLoading) {
    return (
      <div className="flex gap-4 overflow-hidden">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (programs.length === 0) return null;

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
        {programs.map((program) => (
          <ProgramCard
            key={program.id}
            program={program}
            variant="carousel"
            badge={badge}
          />
        ))}
      </div>
    </div>
  );
}

const ProgramRow = memo(ProgramRowImpl);
export default ProgramRow;
