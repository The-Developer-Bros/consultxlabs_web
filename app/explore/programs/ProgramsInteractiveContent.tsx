"use client";

import { PlanLevel } from "@prisma/client";
import { useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import { useSession } from "@/lib/auth-client";
import { useCurrency } from "@/hooks/useCurrency";
import { type Program, type TopicWithCount } from "@/lib/explore/programs";
import { buildProgramHeroStats } from "@/lib/data/public-stats";
import ExploreHero from "@/app/explore/components/ExploreHero";
import SectionHeader from "@/app/explore/components/SectionHeader";
import FilterChips from "@/app/explore/components/FilterChips";
import {
  useCuratedPrograms,
  useInfiniteScroll,
  usePrograms,
  useProgramFilterChips,
  useProgramsFilters,
  useTopicsWithCount,
} from "./hooks";
import ProgramTabs from "./components/ProgramTabs";
import AdvancedFilters from "./components/AdvancedFilters";
import StaticTopRows from "./components/StaticTopRows";
import ProgramResults from "./components/ProgramResults";

interface ProgramStats {
  publishedClassCount: number;
  publishedWebinarCount: number;
  enrolledLearnerCount: number;
}

interface ProgramsInteractiveContentProps {
  initialTrending: Program[];
  initialNewest: Program[];
  initialTopics: TopicWithCount[];
  initialStats: ProgramStats | null;
  /** #664 — viewer's ACTIVE org memberships as { orgId: orgName }. */
  viewerOrgs?: Record<string, string>;
  /** Every level in the catalog, read server-side — not just loaded rows. */
  availableLevels?: PlanLevel[];
}

export default function ProgramsInteractiveContent({
  initialTrending,
  initialNewest,
  initialTopics,
  initialStats,
  viewerOrgs = {},
  availableLevels = [],
}: ProgramsInteractiveContentProps) {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const { formatPrice } = useCurrency();

  // All UI state lives in one hook so the orchestrator stays thin.
  const {
    programType,
    handleTabChange,
    filters,
    updateFilters,
    localSearchValue,
    onLocalSearchChange,
    selectedLevel,
    setSelectedLevel,
    viewMode,
    setViewMode,
    clearAll: clearAllFilters,
  } = useProgramsFilters();

  // Stats: server-fetched or absent. `null` means the read failed, and a hero
  // with no numbers is the honest rendering of "we could not count them".
  // No client useEffect — the RSC paid that cost.
  //
  // #1490 — there is no FALLBACK_STATS any more. It rendered "500+ Classes
  // Available", "200+ Live Webinars" and "25K+ Students Enrolled" whenever the
  // stats read returned null, and the data path kept the "25K+" regardless, so
  // that one was fabricated even when the others were real. A figure now either
  // comes from the database or is not shown.
  const stats = useMemo(
    () => (initialStats ? buildProgramHeroStats(initialStats) : []),
    [initialStats],
  );

  // Data hooks. Curated and topics are pre-warmed via initialData for the
  // default `programType === "all"` query keys; tab switches still trigger
  // normal client fetches via the existing query-key plumbing.
  const { programs, isLoading, hasMore, loadMore } = usePrograms(programType, {
    userId,
    filters,
  });

  const { programs: trendingPrograms, isLoading: trendingLoading } =
    useCuratedPrograms(
      programType,
      "trending",
      8,
      programType === "all" ? initialTrending : undefined,
    );

  const { programs: newPrograms, isLoading: newLoading } = useCuratedPrograms(
    programType,
    "newest",
    8,
    programType === "all" ? initialNewest : undefined,
  );

  const { topics: topicsWithCount, isLoading: topicsLoading } =
    useTopicsWithCount(
      programType,
      programType === "all" ? initialTopics : undefined,
    );

  // Sentinel-driven infinite scroll. Hook owns the IntersectionObserver
  // lifecycle, no per-render disconnect/reconnect.
  const sentinelRef = useInfiniteScroll({
    hasMore,
    isLoading,
    onLoadMore: loadMore,
  });

  // Active filter chips with structured-key removal.
  const clearSearch = useCallback(() => {
    onLocalSearchChange("");
  }, [onLocalSearchChange]);

  const {
    chips,
    removeChip,
    clearAll: clearAllChips,
  } = useProgramFilterChips({
    filters,
    topics: topicsWithCount,
    selectedLevel,
    searchTerm: filters.search ?? "",
    formatPrice,
    updateFilters,
    setSelectedLevel,
    clearSearch,
    clearAll: clearAllFilters,
  });

  // Use trending programs as featured (proxy until admin-flagged feature exists)
  const featuredPrograms = useMemo(
    () => trendingPrograms.slice(0, 5),
    [trendingPrograms],
  );

  const handleTopicSelect = useCallback(
    (topicId: string) => {
      updateFilters({
        topicIds: filters.topicIds?.includes(topicId)
          ? filters.topicIds
          : [...(filters.topicIds || []), topicId],
      });
      document
        .getElementById("all-programs")
        ?.scrollIntoView({ behavior: "smooth" });
    },
    [filters.topicIds, updateFilters],
  );

  // `programs` is already fully filtered by the API — search and level used to
  // be re-applied here over the loaded page only, which silently dropped
  // matches that lived on later pages.
  const filteredAndSortedPrograms = programs;

  const uniqueLevels = availableLevels;

  return (
    <main className="min-h-screen bg-background">
      <ExploreHero
        eyebrow="Programs"
        title="Classes and webinars"
        titleAccent="led by practitioners"
        description="Multi-week cohorts and single live sessions. Learn with a group, ask your questions, and leave with something you can use."
        stats={stats}
        emptyStatsText="Check back for new classes and webinars."
      />

      <section className="py-10 md:py-16">
        <div className="mx-auto max-w-[1600px] px-4 md:px-8 lg:px-12">
          <div className="mb-10 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <ProgramTabs
              activeTab={programType}
              onTabChange={handleTabChange}
            />
          </div>

          <StaticTopRows
            featuredPrograms={featuredPrograms}
            trendingPrograms={trendingPrograms}
            newPrograms={newPrograms}
            topics={topicsWithCount}
            trendingLoading={trendingLoading}
            newLoading={newLoading}
            topicsLoading={topicsLoading}
            onTopicSelect={handleTopicSelect}
          />

          {/* The nav deep-links to #all-programs, so the anchor carries the
              fixed-navbar offset. */}
          <motion.div
            id="all-programs"
            className="scroll-mt-[calc(var(--header-height,5rem)+1rem)]"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          >
            <SectionHeader
              title="All programs"
              description="Search, then narrow by level, price, language and topic."
            />

            <AdvancedFilters
              filters={filters}
              onFiltersChange={updateFilters}
              localSearch={localSearchValue}
              onLocalSearchChange={onLocalSearchChange}
              selectedLevel={selectedLevel}
              onLevelChange={setSelectedLevel}
              uniqueLevels={uniqueLevels}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              topics={topicsWithCount}
            />

            {chips.length > 0 && (
              <div className="mt-6">
                <FilterChips
                  filters={chips}
                  onRemove={removeChip}
                  onClearAll={clearAllChips}
                />
              </div>
            )}

            <div className="mt-8">
              <ProgramResults
                programs={filteredAndSortedPrograms}
                isLoading={isLoading}
                viewMode={viewMode}
                sentinelRef={sentinelRef}
                viewerOrgs={viewerOrgs}
              />
            </div>
          </motion.div>
        </div>
      </section>
    </main>
  );
}
