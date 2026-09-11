"use client";

import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CalendarX } from "lucide-react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { EmptyState } from "@/components/dashboard/DataCard";
import { Button } from "@/components/ui/button";
import { AppointmentsShell } from "@/components/appointments/AppointmentsShell";
import { AppointmentsPageSkeleton } from "@/components/appointments/skeletons";
import { mapConsulteeEvents } from "@/lib/appointments/map-consultee";
import { createConsulteeQueries } from "@/lib/dashboard-queries";
import { useConsulteeAppointmentsAdapter } from "@/components/appointments/consultee/ConsulteeAppointmentsAdapter";

export default function AppointmentsPageClient({
  consulteeId,
}: Readonly<{ consulteeId: string }>) {
  const eventsQuery = createConsulteeQueries(consulteeId).events;
  // keepPreviousData: refetches show the previous list while the new one
  // loads instead of a skeleton flash (documents-page idiom, #346).
  const {
    data: eventsData,
    isLoading,
    error,
    refetch,
  } = useQuery({
    ...eventsQuery,
    placeholderData: keepPreviousData,
  });

  const adapter = useConsulteeAppointmentsAdapter();

  const vms = useMemo(() => mapConsulteeEvents(eventsData), [eventsData]);

  return (
    <DashboardErrorBoundary>
      <DashboardHeader
        title="Appointments"
        subtitle="Your consultations, subscriptions, webinars, and classes"
      />
      <div className="pt-6">
        {isLoading && !eventsData ? (
          <AppointmentsPageSkeleton />
        ) : error ? (
          <EmptyState
            icon={CalendarX}
            title="Couldn't load appointments"
            description={
              error instanceof Error
                ? error.message
                : "Failed to load appointments. Please try again."
            }
            action={
              <Button variant="outline" onClick={() => void refetch()}>
                Retry
              </Button>
            }
          />
        ) : (
          <AppointmentsShell vms={vms} adapter={adapter} />
        )}
      </div>
    </DashboardErrorBoundary>
  );
}
