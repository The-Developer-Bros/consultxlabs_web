"use client";

import { memo, useMemo } from "react";
import { Briefcase } from "lucide-react";
import type { IConsultantCardData } from "@/types/consultant";
import SectionHeader from "@/app/explore/components/SectionHeader";
import TaxonomyGrid from "@/app/explore/components/TaxonomyGrid";
import ExpertRow from "./ExpertRow";
import type { SortOption } from "./SearchBar";
import type { IExpertsMetaData } from "../utils";

interface StaticTopRowsProps {
  metadata: IExpertsMetaData | null;
  trendingExperts: IConsultantCardData[];
  newestExperts: IConsultantCardData[];
  onSeeAllSort: (sort: SortOption) => void;
  onDomainSelect: (domainId: string) => void;
}

/**
 * The "above the fold" rows that depend only on RSC-fetched static data:
 * trending experts, newly joined, and browse by domain.
 *
 * Receives only static props (data + stable callbacks) so the parent
 * memoizes this and filter state changes never re-render any of it.
 */
function StaticTopRowsImpl({
  metadata,
  trendingExperts,
  newestExperts,
  onSeeAllSort,
  onDomainSelect,
}: StaticTopRowsProps) {
  const domains = useMemo(
    () =>
      (metadata?.consultantMetadata?.consultantsByDomain ?? []).map(
        (domain) => ({
          id: domain.id,
          name: domain.name,
          count: domain.consultantCount,
        }),
      ),
    [metadata],
  );

  return (
    <>
      <div className="mb-14">
        <SectionHeader
          title="Trending experts"
          onSeeAllClick={() => onSeeAllSort("trending")}
        />
        <ExpertRow
          experts={trendingExperts}
          badge="trending"
          isLoading={false}
        />
      </div>

      <div className="mb-14">
        <SectionHeader
          title="Newly joined"
          onSeeAllClick={() => onSeeAllSort("newest")}
        />
        <ExpertRow experts={newestExperts} badge="new" isLoading={false} />
      </div>

      {/* The nav's "Browse by domain" item deep-links to #domains; scroll-mt
          clears the fixed navbar so the heading isn't hidden under it on
          landing. */}
      {metadata?.consultantMetadata?.consultantsByDomain && (
        <div
          id="domains"
          className="mb-14 scroll-mt-[calc(var(--header-height,5rem)+1rem)]"
        >
          <SectionHeader title="Browse by domain" />
          <TaxonomyGrid
            items={domains}
            noun="expert"
            icon={Briefcase}
            isLoading={false}
            onSelect={onDomainSelect}
          />
        </div>
      )}
    </>
  );
}

const StaticTopRows = memo(StaticTopRowsImpl);
export default StaticTopRows;
