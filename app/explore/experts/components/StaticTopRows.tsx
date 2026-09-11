"use client";

import { memo } from "react";
import { Briefcase, Clock, Flame } from "lucide-react";
import type { IConsultantCardData } from "@/types/consultant";
import SectionHeader from "@/app/explore/components/SectionHeader";
import ExpertRow from "./ExpertRow";
import DomainGrid from "./DomainGrid";
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
 * Trending Experts, Newly Joined, and Browse by Domain.
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
  return (
    <>
      {/* Trending Experts Row */}
      <div className="mb-14">
        <SectionHeader
          title="Trending Experts"
          icon={<Flame className="w-5 h-5 text-white" />}
          onSeeAllClick={() => onSeeAllSort("trending")}
        />
        <ExpertRow
          experts={trendingExperts}
          badge="trending"
          isLoading={false}
        />
      </div>

      {/* Newly Joined Row */}
      <div className="mb-14">
        <SectionHeader
          title="Newly Joined"
          icon={<Clock className="w-5 h-5 text-white" />}
          onSeeAllClick={() => onSeeAllSort("newest")}
        />
        <ExpertRow experts={newestExperts} badge="new" isLoading={false} />
      </div>

      {/* Browse by Domain. The nav's "Browse by domain" item deep-links to
          #domains; scroll-mt clears the fixed navbar so the heading isn't
          hidden under it on landing. */}
      {metadata?.consultantMetadata?.consultantsByDomain && (
        <div
          id="domains"
          className="mb-14 scroll-mt-[calc(var(--header-height,5rem)+1rem)]"
        >
          <SectionHeader
            title="Browse by Domain"
            icon={<Briefcase className="w-5 h-5 text-white" />}
          />
          <DomainGrid
            domains={metadata.consultantMetadata.consultantsByDomain}
            isLoading={false}
            onDomainSelect={onDomainSelect}
          />
        </div>
      )}
    </>
  );
}

const StaticTopRows = memo(StaticTopRowsImpl);
export default StaticTopRows;
