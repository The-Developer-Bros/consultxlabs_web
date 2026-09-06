"use client";

import { motion } from "framer-motion";
import { Search } from "lucide-react";
import { memo, type RefObject } from "react";
import type { IConsultantCardData } from "@/types/consultant";
import { ConsultantCard } from "./ConsultantCard";
import { groupConsultantsByDomain, type IExpertsMetaData } from "../utils";

interface ExpertResultsProps {
  consultants: IConsultantCardData[];
  metadata: IExpertsMetaData | null;
  isLoading: boolean;
  isRefetching: boolean;
  isLoadingMore: boolean;
  /** When non-null, results are grouped by domain header. */
  groupByDomainId: string | null;
  sentinelRef: RefObject<HTMLDivElement>;
}

const REVEAL = {
  initial: { opacity: 0, y: 16 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-80px" },
} as const;

const EASE = [0.16, 1, 0.3, 1] as const;

function EmptyState() {
  return (
    <motion.div
      className="py-16 text-center"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE }}
    >
      <div className="mx-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
        <Search className="h-5 w-5" strokeWidth={1.75} />
      </div>
      <h3 className="mt-4 text-lg font-semibold tracking-tight text-foreground">
        No experts found
      </h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Try a different search term, or widen the filters in the rail.
      </p>
    </motion.div>
  );
}

/**
 * The infinite-scrolling results region: stale-data overlay during refetch,
 * grouped or flat layout, empty state, load-more spinner, and a single
 * sentinel `<div>` at the bottom that the parent's `useInfiniteScroll`
 * observes.
 */
function ExpertResultsImpl({
  consultants,
  metadata,
  isLoading,
  isRefetching,
  isLoadingMore,
  groupByDomainId,
  sentinelRef,
}: ExpertResultsProps) {
  const grouped = groupConsultantsByDomain(consultants);
  const showEmpty = consultants.length === 0 && !isLoading && !isRefetching;

  // Initial load: show card anatomy instead of a spinner overlay.
  if ((isLoading || isRefetching) && consultants.length === 0) {
    return (
      <div className="min-h-[400px] space-y-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-48 animate-pulse rounded-2xl bg-muted" />
        ))}
      </div>
    );
  }

  return (
    <div className="relative min-h-[400px]">
      {/* Soft refetch veil — keep stale results visible (no spinner CLS). */}
      {isRefetching && consultants.length > 0 && (
        <div
          className="pointer-events-none absolute inset-0 z-10 rounded-2xl bg-background/40"
          aria-hidden
        />
      )}

      {groupByDomainId ? (
        <>
          {metadata?.domains.map((domain) => {
            const domainConsultants = grouped[domain.id] || [];
            if (domainConsultants.length === 0) return null;

            return (
              <motion.div
                key={domain.id}
                className="mb-12"
                {...REVEAL}
                transition={{ duration: 0.5, ease: EASE }}
              >
                <div className="mb-5 flex items-baseline gap-3">
                  <h3 className="text-xl font-semibold tracking-tight text-foreground">
                    {domain.name}
                  </h3>
                  <span className="inline-flex items-center rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium tabular-nums text-muted-foreground">
                    {domainConsultants.length}
                  </span>
                </div>
                <div className="space-y-6">
                  {domainConsultants.map((consultant) => (
                    <ConsultantCard
                      key={consultant.id}
                      consultant={consultant}
                      metadata={metadata}
                    />
                  ))}
                </div>
              </motion.div>
            );
          })}
        </>
      ) : (
        <div className="space-y-6">
          {consultants.map((consultant, index) => (
            <motion.div
              key={consultant.id}
              {...REVEAL}
              transition={{
                duration: 0.5,
                ease: EASE,
                delay: Math.min(index * 0.05, 0.3),
              }}
            >
              <ConsultantCard consultant={consultant} metadata={metadata} />
            </motion.div>
          ))}
        </div>
      )}

      {showEmpty && <EmptyState />}

      {/* Sentinel for infinite scroll — observed by useInfiniteScroll. */}
      <div ref={sentinelRef} aria-hidden="true" />

      {isLoadingMore && (
        <div className="space-y-6 py-6">
          {[1, 2].map((i) => (
            <div key={i} className="h-48 animate-pulse rounded-2xl bg-muted" />
          ))}
        </div>
      )}
    </div>
  );
}

const ExpertResults = memo(ExpertResultsImpl);
export default ExpertResults;
