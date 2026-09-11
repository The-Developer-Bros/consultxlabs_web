"use client";

import { useParams } from "next/navigation";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CalendarRange } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PlannerSkeleton } from "@/components/dashboard/DashboardSkeletons";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { EmptyState } from "@/components/dashboard/DataCard";
import { createConsultantQueries } from "@/lib/dashboard-queries";
import { EventManagementDashboard } from "@/components/planner/components/EventManagementDashboard";

export default function PlannerPage() {
  const params = useParams();
  const consultantId = params.consultantId as string;

  const plannerQuery = createConsultantQueries(consultantId).planner;
  // keepPreviousData: refetches show the previous planner while the new one
  // loads instead of a skeleton flash (documents-page idiom, #346).
  const {
    data: plannerData,
    isLoading,
    error,
    refetch,
  } = useQuery({
    ...plannerQuery,
    placeholderData: keepPreviousData,
  });

  const header = (
    <DashboardHeader
      title="Event Planner"
      subtitle="Create and manage your plans and scheduled sessions"
    />
  );

  if (isLoading) {
    return (
      <>
        {header}
        <DashboardContent>
          <PlannerSkeleton />
        </DashboardContent>
      </>
    );
  }

  if (error || !plannerData) {
    return (
      <>
        {header}
        <DashboardContent>
          <DashboardErrorBoundary>
            <EmptyState
              icon={CalendarRange}
              title={error ? "Couldn't load your planner" : "No planner data"}
              description={
                error instanceof Error
                  ? error.message
                  : "Planner data is unavailable right now. Please retry."
              }
              action={
                <Button variant="outline" onClick={() => void refetch()}>
                  Retry
                </Button>
              }
            />
          </DashboardErrorBoundary>
        </DashboardContent>
      </>
    );
  }

  return (
    <>
      {header}
      <DashboardContent>
        <DashboardErrorBoundary>
          <EventManagementDashboard
            consultantId={consultantId}
            data={plannerData}
          />
        </DashboardErrorBoundary>
      </DashboardContent>
    </>
  );
}
