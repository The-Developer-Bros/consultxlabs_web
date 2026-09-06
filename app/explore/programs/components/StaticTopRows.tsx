"use client";

import { memo, useMemo } from "react";
import { Hash } from "lucide-react";
import type { Program, TopicWithCount } from "@/lib/explore/programs";
import SectionHeader from "@/app/explore/components/SectionHeader";
import TaxonomyGrid from "@/app/explore/components/TaxonomyGrid";
import FeaturedCarousel from "./FeaturedCarousel";
import ProgramRow from "./ProgramRow";

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
 * data: the featured carousel, the trending row, the newly-added row and
 * the browse-by-topic grid.
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
  const topicItems = useMemo(
    () =>
      topics.map((topic) => ({
        id: topic.id,
        name: topic.name,
        count: topic.programCount,
      })),
    [topics],
  );

  return (
    <>
      <div className="mb-14">
        <SectionHeader title="Featured" />
        <FeaturedCarousel
          programs={featuredPrograms}
          isLoading={trendingLoading}
        />
      </div>

      <div className="mb-14">
        <SectionHeader
          title="Trending now"
          seeAllHref="/explore/programs?sort=trending"
        />
        <ProgramRow
          programs={trendingPrograms}
          badge="trending"
          isLoading={trendingLoading}
        />
      </div>

      <div className="mb-14">
        <SectionHeader
          title="Newly added"
          seeAllHref="/explore/programs?sort=newest"
        />
        <ProgramRow programs={newPrograms} badge="new" isLoading={newLoading} />
      </div>

      <div className="mb-14">
        <SectionHeader title="Browse by topic" />
        <TaxonomyGrid
          items={topicItems}
          noun="program"
          icon={Hash}
          isLoading={topicsLoading}
          onSelect={onTopicSelect}
        />
      </div>
    </>
  );
}

const StaticTopRows = memo(StaticTopRowsImpl);
export default StaticTopRows;
