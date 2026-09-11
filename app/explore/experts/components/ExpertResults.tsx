"use client";

import { motion } from "framer-motion";
import { Search } from "lucide-react";
import { memo, type RefObject } from "react";
import type { IConsultantCardData } from "@/types/consultant";
import { ConsultantCard } from "./ConsultantCard";
import {
  groupConsultantsByDomain,
  type IExpertsMetaData,
} from "../utils";

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

function EmptyState() {
  return (
    <motion.div
      className="text-center py-16"
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3 }}
    >
      <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-muted flex items-center justify-center">
        <Search className="w-10 h-10 text-muted-foreground/70" />
      </div>
      <h3 className="text-xl font-semibold text-foreground mb-2">
        No experts found
      </h3>
      <p className="text-muted-foreground max-w-md mx-auto">
        Try adjusting your filters or search terms to discover more amazing
        mentors
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

  // Initial load: show card-grid anatomy instead of a spinner overlay.
  if ((isLoading || isRefetching) && consultants.length === 0) {
    return (
      <div className="mt-8 min-h-[400px] space-y-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-36 animate-pulse rounded-xl bg-muted"
          />
        ))}
      </div>
    );
  }

  return (
    <div className="mt-8 min-h-[400px] relative">
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
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5 }}
              >
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-1 h-8 bg-gradient-to-b from-foreground to-muted-foreground/70 rounded-full" />
                  <h3 className="text-2xl font-bold text-foreground">
                    {domain.name}
                  </h3>
                  <span className="px-3 py-1 bg-muted rounded-full text-sm text-muted-foreground">
                    {domainConsultants.length} expert
                    {domainConsultants.length !== 1 ? "s" : ""}
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
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{
                duration: 0.4,
                delay: Math.min(index * 0.05, 0.6),
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
        <div className="space-y-4 py-6">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-xl bg-muted"
            />
          ))}
        </div>
      )}
    </div>
  );
}

const ExpertResults = memo(ExpertResultsImpl);
export default ExpertResults;
