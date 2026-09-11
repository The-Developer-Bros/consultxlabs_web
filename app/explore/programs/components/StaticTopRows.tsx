"use client";

import { memo } from "react";
import { Sparkles, Flame, Clock, Hash } from "lucide-react";
import type { Program, TopicWithCount } from "@/lib/explore/programs";
import SectionHeader from "./SectionHeader";
import FeaturedCarousel from "./FeaturedCarousel";
import ProgramRow from "./ProgramRow";
import CategoryGrid from "./CategoryGrid";

interface StaticTopRowsProps {
  featuredPrograms: Program[];
  trendingPrograms: Program[];
  newPrograms: Program[];
  topics: TopicWithCount[];
  trendingLoading: boolean;
  newLoading: boolean;
  topicsLoading: boolean;
  onTopicSelect: (topicId: string) => void;
}

/**
 * The "above the fold" rows that depend only on RSC-pre-warmed curated
 * data: Featured carousel, Trending row, Newly Added row, and Browse by
 * Category grid.
 *
 * Memoized so filter mutations on the all-programs section can never
 * re-render any of these.
 */
function StaticTopRowsImpl({
  featuredPrograms,
  trendingPrograms,
  newPrograms,
  topics,
  trendingLoading,
  newLoading,
  topicsLoading,
  onTopicSelect,
}: StaticTopRowsProps) {
  return (
    <>
      {/* Featured Carousel */}
      <div className="mb-14">
        <SectionHeader
          title="Familiarise Featured"
          icon={<Sparkles className="w-5 h-5 text-white" />}
        />
        <FeaturedCarousel
          programs={featuredPrograms}
          isLoading={trendingLoading}
        />
      </div>

      {/* Trending Now */}
      <div className="mb-14">
        <SectionHeader
          title="Trending Now"
          icon={<Flame className="w-5 h-5 text-white" />}
          seeAllHref="/explore/programs?sort=trending"
        />
        <ProgramRow
          programs={trendingPrograms}
          badge="trending"
          isLoading={trendingLoading}
        />
      </div>

      {/* Newly Added */}
      <div className="mb-14">
        <SectionHeader
          title="Newly Added"
          icon={<Clock className="w-5 h-5 text-white" />}
          seeAllHref="/explore/programs?sort=newest"
        />
        <ProgramRow
          programs={newPrograms}
          badge="new"
          isLoading={newLoading}
        />
      </div>

      {/* Browse by Category */}
      <div className="mb-14">
        <SectionHeader
          title="Browse by Category"
          icon={<Hash className="w-5 h-5 text-white" />}
        />
        <CategoryGrid
          topics={topics}
          isLoading={topicsLoading}
          onTopicSelect={onTopicSelect}
        />
      </div>
    </>
  );
}

const StaticTopRows = memo(StaticTopRowsImpl);
export default StaticTopRows;
