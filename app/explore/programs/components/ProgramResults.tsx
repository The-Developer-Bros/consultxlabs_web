"use client";

import { memo, type RefObject } from "react";
import { motion } from "framer-motion";
import { Search } from "lucide-react";
import type { Program } from "@/lib/explore/programs";
import ProgramCard from "./ProgramCard";

interface ProgramResultsProps {
  programs: Program[];
  isLoading: boolean;
  viewMode: "grid" | "list";
  sentinelRef: RefObject<HTMLDivElement>;
  /** #664 — viewer's ACTIVE org memberships as { orgId: orgName }. */
  viewerOrgs?: Record<string, string>;
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
        No programs found
      </h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Try a different search term, or widen the filters above.
      </p>
    </motion.div>
  );
}

/**
 * Grid / list rendering of the all-programs section, plus the empty state,
 * the load-more skeletons, and the sentinel `<div>` that the parent's
 * `useInfiniteScroll` observes for pagination.
 */
function ProgramResultsImpl({
  programs,
  isLoading,
  viewMode,
  sentinelRef,
  viewerOrgs,
}: ProgramResultsProps) {
  return (
    <>
      {viewMode === "grid" ? (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {programs.map((item, index) => (
            <motion.div
              key={item.id}
              {...REVEAL}
              transition={{
                duration: 0.5,
                ease: EASE,
                delay: Math.min(index * 0.05, 0.3),
              }}
            >
              <ProgramCard
                program={item}
                variant="grid"
                viewerOrgs={viewerOrgs}
              />
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {programs.map((item, index) => (
            <motion.div
              key={item.id}
              {...REVEAL}
              transition={{
                duration: 0.5,
                ease: EASE,
                delay: Math.min(index * 0.05, 0.3),
              }}
            >
              <ProgramCard
                program={item}
                variant="list"
                viewerOrgs={viewerOrgs}
              />
            </motion.div>
          ))}
        </div>
      )}

      {programs.length === 0 && !isLoading && <EmptyState />}

      {/* Sentinel for infinite scroll — observed by useInfiniteScroll. */}
      <div ref={sentinelRef} aria-hidden="true" />

      {isLoading &&
        (viewMode === "grid" ? (
          <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-72 animate-pulse rounded-2xl bg-muted"
              />
            ))}
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-40 animate-pulse rounded-2xl bg-muted"
              />
            ))}
          </div>
        ))}
    </>
  );
}

const ProgramResults = memo(ProgramResultsImpl);
export default ProgramResults;
