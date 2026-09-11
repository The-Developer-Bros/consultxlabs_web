"use client";

import { memo, useState } from "react";
import { Hash, ChevronDown, ChevronUp } from "lucide-react";
import { TopicWithCount } from "@/lib/explore/programs";

interface CategoryGridProps {
  topics: TopicWithCount[];
  isLoading?: boolean;
  onTopicSelect: (topicId: string) => void;
}

const INITIAL_DISPLAY = 9;

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-border p-5 animate-pulse">
      <div className="w-10 h-10 bg-muted rounded-lg mb-3" />
      <div className="h-5 bg-muted rounded w-3/4 mb-2" />
      <div className="h-4 bg-muted rounded w-1/2" />
    </div>
  );
}

function CategoryGridImpl({
  topics,
  isLoading,
  onTopicSelect,
}: CategoryGridProps) {
  const [expanded, setExpanded] = useState(false);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (topics.length === 0) return null;

  const displayed = expanded ? topics : topics.slice(0, INITIAL_DISPLAY);
  const hasMore = topics.length > INITIAL_DISPLAY;

  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
        {displayed.map((topic) => (
          <button
            key={topic.id}
            onClick={() => onTopicSelect(topic.id)}
            className="group text-left rounded-xl border border-border bg-card p-5 hover:border-border hover:shadow-md transition-all duration-200"
          >
            <div className="w-10 h-10 rounded-lg bg-muted group-hover:bg-primary flex items-center justify-center mb-3 transition-colors">
              <Hash className="w-5 h-5 text-muted-foreground group-hover:text-primary-foreground transition-colors" />
            </div>
            <h3 className="font-semibold text-foreground text-sm mb-1 line-clamp-1">
              {topic.name}
            </h3>
            <p className="text-xs text-muted-foreground">
              {topic.programCount}{" "}
              {topic.programCount === 1 ? "program" : "programs"}
            </p>
          </button>
        ))}
      </div>

      {hasMore && (
        <div className="flex justify-center mt-6">
          <button
            onClick={() => setExpanded(!expanded)}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-muted-foreground bg-muted rounded-lg hover:bg-muted/80 transition-colors"
          >
            {expanded ? (
              <>
                Show Less <ChevronUp className="w-4 h-4" />
              </>
            ) : (
              <>
                View All Categories <ChevronDown className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

const CategoryGrid = memo(CategoryGridImpl);
export default CategoryGrid;
