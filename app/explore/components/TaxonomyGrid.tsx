"use client";

import type { LucideIcon } from "lucide-react";
import { memo, useState } from "react";

import { Button } from "@/components/ui/button";

interface TaxonomyItem {
  id: string;
  name: string;
  count: number;
}

interface TaxonomyGridProps {
  items: TaxonomyItem[];
  /** Singular noun for the count line — "expert" / "program". */
  noun: string;
  icon: LucideIcon;
  isLoading?: boolean;
  onSelect: (id: string) => void;
}

const INITIAL_DISPLAY = 9;

/**
 * The "browse by …" tile grid, shared by both listings. Experts and programs
 * each kept a private copy of this that differed only in its icon and its
 * count noun.
 */
function SkeletonTile() {
  return (
    <div className="flex animate-pulse items-center gap-3 rounded-2xl border border-border p-4">
      <div className="h-10 w-10 shrink-0 rounded-xl bg-muted" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="h-4 w-3/4 rounded bg-muted" />
        <div className="h-3 w-1/2 rounded bg-muted" />
      </div>
    </div>
  );
}

function TaxonomyGridImpl({
  items,
  noun,
  icon: Icon,
  isLoading,
  onSelect,
}: TaxonomyGridProps) {
  const [expanded, setExpanded] = useState(false);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonTile key={i} />
        ))}
      </div>
    );
  }

  if (items.length === 0) return null;

  const displayed = expanded ? items : items.slice(0, INITIAL_DISPLAY);
  const hasMore = items.length > INITIAL_DISPLAY;

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {displayed.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 text-left shadow-elevation-1 transition-all duration-300 ease-out hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-elevation-2"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
              <Icon className="h-5 w-5" strokeWidth={1.75} />
            </span>
            <span className="min-w-0">
              <span className="line-clamp-1 block text-sm font-semibold text-foreground">
                {item.name}
              </span>
              <span className="block text-xs text-muted-foreground">
                {item.count} {item.count === 1 ? noun : `${noun}s`}
              </span>
            </span>
          </button>
        ))}
      </div>

      {hasMore && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? "Show less" : `Show all ${items.length}`}
          </Button>
        </div>
      )}
    </div>
  );
}

const TaxonomyGrid = memo(TaxonomyGridImpl);
export default TaxonomyGrid;
