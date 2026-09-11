"use client";

import { PlanLevel } from "@prisma/client";
import { useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import {
  GraduationCap,
  Video,
  Users,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { useCurrency } from "@/hooks/useCurrency";
import { type Program, type TopicWithCount } from "@/lib/explore/programs";
import {
  buildProgramHeroStats,
  type ProgramStatKey,
} from "@/lib/data/public-stats";
import {
  useCuratedPrograms,
  useInfiniteScroll,
  usePrograms,
  useProgramFilterChips,
  useProgramsFilters,
  useTopicsWithCount,
} from "./hooks";
import ProgramTabs from "./components/ProgramTabs";
import SectionHeader from "./components/SectionHeader";
import AdvancedFilters from "./components/AdvancedFilters";
import FilterChips from "./components/FilterChips";
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

// #1490 — there is no FALLBACK_STATS any more. It rendered "500+ Classes
// Available", "200+ Live Webinars" and "25K+ Students Enrolled" whenever the
// stats read returned null, and the data path kept the "25K+" regardless, so
// that one was fabricated even when the others were real. A figure now either
// comes from the database or is not shown.
const PROGRAM_STAT_ICONS: Record<ProgramStatKey, LucideIcon> = {
  classes: GraduationCap,
  webinars: Video,
  learners: Users,
};

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
      {/* Hero Section */}
      <section className="relative pt-32 pb-20 bg-zinc-950 overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute top-1/4 left-1/4 w-[600px] h-[600px] bg-zinc-800/30 rounded-full blur-[120px] animate-blob" />
          <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-zinc-700/20 rounded-full blur-[100px] animate-blob animation-delay-2000" />
        </div>
        <div className="absolute inset-0 grid-pattern opacity-20" />

        <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 relative z-10">
          <motion.div
            className="max-w-4xl mx-auto text-center"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-800/50 backdrop-blur-sm border border-zinc-700/50 rounded-full mb-8">
              <Sparkles className="w-4 h-4 text-white" />
              <span className="text-sm font-medium text-zinc-300">
                Learn from the Best
              </span>
            </div>

            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white mb-6">
              Classes & <span className="silver-text">Webinars</span>
            </h1>

            <p className="text-lg md:text-xl text-zinc-400 mb-12 max-w-2xl mx-auto">
              Expand your knowledge with expert-led classes and live webinars.
              Learn at your own pace or join interactive sessions.
            </p>

            {stats.length > 0 ? (
              <div className="flex flex-wrap justify-center gap-8 md:gap-16">
                {stats.map((stat, index) => {
                  const Icon = PROGRAM_STAT_ICONS[stat.key];
                  return (
                    <motion.div
                      key={stat.key}
                      className="text-center"
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.5, delay: 0.2 + index * 0.1 }}
                    >
                      <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-zinc-800/50 border border-zinc-700/50 flex items-center justify-center">
                        <Icon className="w-6 h-6 text-white" />
                      </div>
                      <div className="text-2xl md:text-3xl font-bold text-white">
                        {stat.display}
                      </div>
                      <div className="text-sm text-zinc-500">{stat.label}</div>
                    </motion.div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-zinc-500">
                Check back for new classes and webinars.
              </p>
            )}
          </motion.div>
        </div>
      </section>

      {/* Content Section */}
      <section className="py-10 md:py-16">
        <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12">
          {/* Tabs */}
          <div className="mb-10">
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

          {/* All Programs Section */}
          <div id="all-programs">
            <SectionHeader title="All Programs" />

            {/* Advanced Filters */}
            <motion.div
              className="mb-8"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
            >
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
            </motion.div>

            {/* Active Filter Chips */}
            {chips.length > 0 && (
              <div className="mb-6">
                <FilterChips
                  filters={chips}
                  onRemove={removeChip}
                  onClearAll={clearAllChips}
                />
              </div>
            )}

            <ProgramResults
              programs={filteredAndSortedPrograms}
              isLoading={isLoading}
              viewMode={viewMode}
              sentinelRef={sentinelRef}
              viewerOrgs={viewerOrgs}
            />
          </div>
        </div>
      </section>
    </main>
  );
}
