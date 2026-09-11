"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Inbox } from "lucide-react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { HomeSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { EmptyState } from "@/components/dashboard/DataCard";
import { Button } from "@/components/ui/button";
import { createConsultantQueries } from "@/lib/dashboard-queries";
import { HomeTab } from "./HomeTab";
import type { TConsultantDashboardResponse } from "@/types/consultant-events";

export default function HomePageClient({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  // The factory's staleTime (2 min) is deliberately NOT overridden here. This
  // used to force `staleTime: 0` under a comment about showing stale data
  // immediately, which is not what staleTime does: it marks the server-prefetched
  // cache entry stale on mount, so the client refetched
  // GET /api/dashboard/consultant/[id] straight after hydration and recomputed
  // the identical payload the page had just dehydrated — doubling every query
  // behind it. Harmless before #890 seeded the cache; pure waste after. (#1121)
  const dashboardQuery = {
    ...createConsultantQueries(consultantId).dashboard,
    refetchOnWindowFocus: false,
  };
  const {
    data: dashboardData,
    isLoading,
    isFetching,
    error,
    refetch,
    isStale: _isStale,
  } = useQuery<TConsultantDashboardResponse>(dashboardQuery);

  // Show skeleton only for initial load when no data exists
  if (isLoading && !dashboardData) {
    // Header is owned by the server page now — see its comment on FCP.
    return <HomeSkeleton withHeader={false} />;
  }

  if (error && !dashboardData) {
    return (
      <DashboardErrorBoundary>
        <EmptyState
          icon={AlertCircle}
          title="Error loading dashboard"
          description={
            error.message || "Failed to load dashboard data. Please try again."
          }
          action={
            <Button variant="outline" onClick={() => refetch()}>
              Retry
            </Button>
          }
        />
      </DashboardErrorBoundary>
    );
  }

  if (!dashboardData) {
    return (
      <DashboardErrorBoundary>
        <EmptyState
          icon={Inbox}
          title="No data available"
          description="Dashboard data not found for this consultant."
        />
      </DashboardErrorBoundary>
    );
  }

  return (
    <DashboardErrorBoundary>
      {/* Show subtle loading indicator when refreshing. `isLoading` is false
          once data is cached, so a background refetch needs `isFetching`. */}
      {isFetching && dashboardData && (
        <div className="fixed top-4 right-4 bg-blue-500 text-white px-3 py-1 rounded-md text-sm z-50">
          Refreshing...
        </div>
      )}
      <HomeTab
        appointments={dashboardData.appointments}
        consultantId={consultantId}
        pendingRequestsCount={dashboardData.pendingRequestsCount ?? 0}
        performanceSnapshot={dashboardData.performanceSnapshot}
        financialSummary={dashboardData.financialSummary}
      />
    </DashboardErrorBoundary>
  );
}
