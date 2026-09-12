"use client";

import { useCallback, useRef } from "react";
import { Search } from "lucide-react";
import type { IConsultantCardData } from "@/types/consultant";
import { useCurrency } from "@/hooks/useCurrency";
import SectionHeader from "@/app/explore/components/SectionHeader";
import FilterChips from "@/app/explore/components/FilterChips";
import FacetRail from "@/app/explore/components/FacetRail";
import {
  useConsultants,
  useExpertsFilters,
  useInfiniteScroll,
  useExpertFilterChips,
} from "./hooks";
import type { IExpertsMetaData } from "./utils";
import { FilterPanel } from "./components/FilterPanel";
import { SearchBar, type SortOption } from "./components/SearchBar";
import StaticTopRows from "./components/StaticTopRows";
import ExpertResults from "./components/ExpertResults";

interface ExpertsInteractiveContentProps {
  metadata: IExpertsMetaData | null;
  trendingExperts: IConsultantCardData[];
  newestExperts: IConsultantCardData[];
}

export default function ExpertsInteractiveContent({
  metadata,
  trendingExperts,
  newestExperts,
}: ExpertsInteractiveContentProps) {
  const { filters, updateFilters, clearFilters } = useExpertsFilters();
  const browseSectionRef = useRef<HTMLDivElement>(null);
  const { formatPrice } = useCurrency();

  // Main listing — keepPreviousData inside the hook keeps stale results
  // visible during refetch.
  const {
    consultants,
    error: consultantsError,
    isLoading,
    isLoadingMore,
    isRefetching,
    hasMore,
    loadMore,
    refresh,
  } = useConsultants(filters);

  // Sentinel-driven infinite scroll. The hook owns the IntersectionObserver
  // lifecycle (one observer per hasMore/isLoading transition, not one per
  // render).
  const sentinelRef = useInfiniteScroll({
    hasMore,
    isLoading: isLoading || isLoadingMore,
    onLoadMore: loadMore,
  });

  // Active chip array + structured-key removal handler.
  const { chips, removeChip, clearAll } = useExpertFilterChips(
    filters,
    metadata,
    updateFilters,
    clearFilters,
    formatPrice,
  );

  // Mobile rail summary. Suppressed while loading AND on fetch failure — an
  // initial failed request must not read "0 experts shown" next to the error
  // card. Extracted (not inline) to keep the JSX readable.
  const expertCountLabel = `${consultants.length} expert${consultants.length === 1 ? "" : "s"} shown${hasMore ? " — scroll for more" : ""}`;
  const resultSummary =
    isLoading || consultantsError ? undefined : expertCountLabel;

  // Scroll to the browse section, optionally setting a sort first.
  const scrollToBrowse = useCallback(
    (sort?: SortOption) => {
      if (sort) updateFilters({ sort });
      browseSectionRef.current?.scrollIntoView({ behavior: "smooth" });
    },
    [updateFilters],
  );

  // Domain grid click → set domain filter + scroll to browse section.
  const handleDomainSelect = useCallback(
    (domainId: string) => {
      updateFilters({ domain: domainId, subdomain: null, tags: [] });
      browseSectionRef.current?.scrollIntoView({ behavior: "smooth" });
    },
    [updateFilters],
  );

  return (
    <section className="py-10 md:py-16">
      <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12">
        <StaticTopRows
          metadata={metadata}
          trendingExperts={trendingExperts}
          newestExperts={newestExperts}
          onSeeAllSort={scrollToBrowse}
          onDomainSelect={handleDomainSelect}
        />

        {/* Browse All Experts */}
        {/* The nav's "Top rated" deep-links here with ?sort=rating, so the
            anchor needs the same fixed-navbar offset as #domains. */}
        <div
          ref={browseSectionRef}
          id="all-experts"
          className="scroll-mt-[calc(var(--header-height,5rem)+1rem)]"
        >
          <SectionHeader
            title="Browse Familiarise Experts"
            subtitle="Vetted mentors for every ambition — book your first session in minutes."
            icon={<Search className="w-5 h-5 text-white" />}
          />

          {/* Affiliation lives in the sidebar filters now (single source, no
              duplicate control to keep in sync). */}

          <div className="grid grid-cols-1 gap-8 lg:grid-cols-[280px_1fr]">
            <FacetRail
              activeCount={chips.length}
              onClearAll={clearAll}
              resultSummary={resultSummary}
            >
              <FilterPanel
                metadata={metadata}
                filters={filters}
                updateFilters={updateFilters}
              />
            </FacetRail>

            <div className="min-w-0">
              <div className="mb-6">
                <SearchBar
                  onSearch={(term) => updateFilters({ search: term })}
                  onSort={(option) => updateFilters({ sort: option })}
                  sortBy={filters.sort}
                  initialSearch={filters.search}
                />
              </div>

              {chips.length > 0 && (
                <div className="mb-6">
                  <FilterChips
                    filters={chips}
                    onRemove={removeChip}
                    onClearAll={clearAll}
                  />
                </div>
              )}

              {/* Live result count for screen readers and sighted scanners. */}
              {!isLoading && !consultantsError && (
                <p aria-live="polite" className="mb-4 text-sm text-muted-foreground">
                  Showing {consultants.length} expert
                  {consultants.length === 1 ? "" : "s"}
                  {hasMore ? " — scroll down for more" : ""}
                </p>
              )}

              {/* Kept as a full-width vertical stack, not a grid: ConsultantCard
                  is a two-column card (profile + plan tabs) that collapses
                  badly inside a narrow grid cell. */}
              <ExpertResults
                consultants={consultants}
                metadata={metadata}
                isLoading={isLoading}
                isRefetching={isRefetching}
                isLoadingMore={isLoadingMore}
                hasMore={hasMore}
                error={consultantsError}
                onRetry={refresh}
                onClearAll={clearAll}
                groupByDomainId={filters.domain}
                sentinelRef={sentinelRef}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
