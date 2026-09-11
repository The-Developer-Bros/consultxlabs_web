"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";

import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PageSkeleton } from "@/components/dashboard/DashboardSkeletons";

import { ResourcesTab } from "./ResourcesTab";
import type { ResourceArtifact } from "./EventResourceCard";

/**
 * The consultee Documents and Recordings pages, which are the same fetch shown
 * two ways.
 *
 * They used to be one "Resources" page tabbed by EVENT TYPE, with each card
 * listing that event's materials and recordings together. Splitting by artifact
 * matches how people actually look for these — "where is the recording" and
 * "where is the handout" are different errands — while the event-type tabs stay
 * as grouping, because "which session was this from" is still the useful second
 * question.
 *
 * One endpoint serves both: `/api/dashboard/consultee/[id]/resources` already
 * returns `materials[]` and `recordings[]` per event, so this is a re-slice
 * rather than a new read. Both pages share a query key, so opening one warms
 * the other.
 */
export function ConsulteeResourcesPage({
  params,
  artifact,
  title,
  subtitle,
}: Readonly<{
  params: Promise<{ consulteeId: string }>;
  artifact: Exclude<ResourceArtifact, "both">;
  title: string;
  subtitle: string;
}>) {
  const { consulteeId } = use(params);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["consultee-resources", consulteeId],
    queryFn: async () => {
      const res = await fetch(
        `/api/dashboard/consultee/${consulteeId}/resources`,
      );
      if (!res.ok) throw new Error("Failed to fetch resources");
      const json = await res.json();
      return json.data;
    },
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) return <PageSkeleton />;

  if (error) {
    return (
      <DashboardErrorBoundary>
        <div className="flex min-h-[400px] items-center justify-center">
          <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center">
            <h3 className="font-medium text-foreground">
              Couldn&apos;t load {title.toLowerCase()}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {error.message ||
                "This is a loading problem, not an empty library — refresh to try again."}
            </p>
          </div>
        </div>
      </DashboardErrorBoundary>
    );
  }

  return (
    <DashboardErrorBoundary>
      <ResourcesTab
        data={data}
        onRefresh={() => refetch()}
        artifact={artifact}
        title={title}
        subtitle={subtitle}
      />
    </DashboardErrorBoundary>
  );
}
