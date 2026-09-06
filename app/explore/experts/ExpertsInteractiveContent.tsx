"use client";

import { useCallback, useRef } from "react";
import { motion } from "framer-motion";
import { Zap, Building2, Users } from "lucide-react";
import type { IConsultantCardData } from "@/types/consultant";
import { useCurrency } from "@/hooks/useCurrency";
import SectionHeader from "@/app/explore/components/SectionHeader";
import SegmentedControl from "@/app/explore/components/SegmentedControl";
import FilterChips from "@/app/explore/components/FilterChips";
import FacetRail from "@/app/explore/components/FacetRail";
import {
  useConsultants,
  useExpertsFilters,
  useInfiniteScroll,
  useExpertFilterChips,
} from "./hooks";
import type { IExpertsMetaData, AffiliationType } from "./utils";
import { FilterPanel } from "./components/FilterPanel";
import { SearchBar, type SortOption } from "./components/SearchBar";
import StaticTopRows from "./components/StaticTopRows";
import ExpertResults from "./components/ExpertResults";

/** "all" is the segmented-control sentinel for the null affiliation filter. */
const AFFILIATION_TABS = [
  { value: "all", label: "All experts", icon: Users },
  { value: "independent", label: "Independent", icon: Zap },
  { value: "agency", label: "Agency / Org", icon: Building2 },
];

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
    isLoading,
    isLoadingMore,
    isRefetching,
    hasMore,
    loadMore,
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

  const handleAffiliationChange = useCallback(
    (value: string) => {
      updateFilters({
        affiliationType: value === "all" ? null : (value as AffiliationType),
      });
    },
    [updateFilters],
  );

  return (
    <section className="py-10 md:py-16">
      <div className="mx-auto max-w-[1600px] px-4 md:px-8 lg:px-12">
        <StaticTopRows
          metadata={metadata}
          trendingExperts={trendingExperts}
          newestExperts={newestExperts}
          onSeeAllSort={scrollToBrowse}
          onDomainSelect={handleDomainSelect}
        />

        {/* Browse all experts. The nav's "Top rated" deep-links here with
            ?sort=rating, so the anchor needs the same fixed-navbar offset as
            #domains. */}
        <motion.div
          ref={browseSectionRef}
          id="all-experts"
          className="scroll-mt-[calc(var(--header-height,5rem)+1rem)]"
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        >
          <SectionHeader
            title="All experts"
            description="Filter by domain, price, experience and language."
          />

          <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <SegmentedControl
              value={filters.affiliationType ?? "all"}
              onChange={handleAffiliationChange}
              options={AFFILIATION_TABS}
              ariaLabel="Filter experts by affiliation"
            />
            <div className="lg:max-w-xl lg:flex-1">
              <SearchBar
                onSearch={(term) => updateFilters({ search: term })}
                onSort={(option) => updateFilters({ sort: option })}
                sortBy={filters.sort}
                initialSearch={filters.search}
              />
            </div>
          </div>

          {/* Filters live in a sticky rail (mobile: Sheet drawer) so the
              results keep the full column instead of starting below a
              three-row filter grid. */}
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-[280px_1fr]">
            <FacetRail activeCount={chips.length} onClearAll={clearAll}>
              <FilterPanel
                metadata={metadata}
                filters={filters}
                updateFilters={updateFilters}
              />
            </FacetRail>

            <div className="min-w-0">
              {chips.length > 0 && (
                <div className="mb-6">
                  <FilterChips
                    filters={chips}
                    onRemove={removeChip}
                    onClearAll={clearAll}
                  />
                </div>
              )}

              {/* Kept as a full-width vertical stack, not a grid: ConsultantCard
                  is a two-column card (profile + plans) that collapses badly
                  inside a narrow grid cell. */}
              <ExpertResults
                consultants={consultants}
                metadata={metadata}
                isLoading={isLoading}
                isRefetching={isRefetching}
                isLoadingMore={isLoadingMore}
                groupByDomainId={filters.domain}
                sentinelRef={sentinelRef}
              />
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
