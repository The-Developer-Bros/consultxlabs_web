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
        No programs found
      </h3>
      <p className="text-muted-foreground max-w-md mx-auto">
        Try adjusting your filters or search terms to discover more programs
      </p>
    </motion.div>
  );
}

/**
 * Grid / list rendering of the all-programs section, plus the empty state,
 * the load-more spinner, and the sentinel `<div>` that the parent's
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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {programs.map((item, index) => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{
                duration: 0.4,
                delay: Math.min(index * 0.05, 0.6),
              }}
            >
              <ProgramCard program={item} variant="grid" viewerOrgs={viewerOrgs} />
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {programs.map((item, index) => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{
                duration: 0.4,
                delay: Math.min(index * 0.05, 0.6),
              }}
            >
              <ProgramCard program={item} variant="list" viewerOrgs={viewerOrgs} />
            </motion.div>
          ))}
        </div>
      )}

      {programs.length === 0 && !isLoading && <EmptyState />}

      {/* Sentinel for infinite scroll — observed by useInfiniteScroll. */}
      <div ref={sentinelRef} aria-hidden="true" />

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 border-3 border-muted border-t-primary rounded-full animate-spin" />
            <span className="text-muted-foreground">Loading programs...</span>
          </div>
        </div>
      )}
    </>
  );
}

const ProgramResults = memo(ProgramResultsImpl);
export default ProgramResults;
