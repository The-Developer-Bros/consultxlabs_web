"use client";

import { useQuery } from "@tanstack/react-query";
import { CalendarX2 } from "lucide-react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { HomeSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { EmptyState } from "@/components/dashboard/DataCard";
import { Button } from "@/components/ui/button";
import { createConsulteeQueries } from "@/lib/dashboard-queries";
import HomeTab from "./HomeTab";
import { useUser } from "../../UserContext";

export default function HomePageClient({
  consulteeId,
}: Readonly<{ consulteeId: string }>) {
  const { userDetails } = useUser();

  // Personal pin, matching the sibling Appointments page (ADR 19). The old
  // defaultForOrgMember: "all" here papered over the missing attendee arm in
  // the orgMember scope (#1166 ORG-5); org-funded sessions now live on the
  // org dashboard, which can actually show them.
  //
  // `eventsHome` is the factory's Home-tuned twin of `events` (same key base
  // as the SSR seed, calmer refresh posture) — keep query config in the
  // factory so both tabs stay consistent by construction.
  const eventsQuery = createConsulteeQueries(consulteeId).eventsHome;
  const { data: eventsData, isLoading, error, refetch } = useQuery(eventsQuery);

  // Show skeleton only for initial load when no data exists
  if (isLoading && !eventsData) {
    return <HomeSkeleton />;
  }

  if (error && !eventsData) {
    return (
      <EmptyState
        icon={CalendarX2}
        title="Couldn't load your sessions"
        description={
          (error as Error)?.message ||
          "Failed to load events data. Please try again."
        }
        action={<Button onClick={() => refetch()}>Retry</Button>}
      />
    );
  }

  if (!eventsData || !userDetails) {
    return <HomeSkeleton />;
  }

  return (
    <DashboardErrorBoundary>
      {/* Show subtle loading indicator when refreshing */}
      {isLoading && eventsData && (
        <div className="fixed top-4 right-4 bg-foreground text-background px-3 py-1 rounded-md text-sm z-50">
          Refreshing...
        </div>
      )}
      <HomeTab
        eventsData={eventsData}
        userDetails={{
          id: userDetails.id,
          name: userDetails.name ?? "User",
          email: userDetails.email ?? "",
          image: userDetails.image ?? undefined,
        }}
        isRefreshing={isLoading && !!eventsData}
        consulteeId={consulteeId}
      />
    </DashboardErrorBoundary>
  );
}
