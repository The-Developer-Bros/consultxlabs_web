"use client";

import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, CalendarX } from "lucide-react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { EmptyState } from "@/components/dashboard/DataCard";
import { Button } from "@/components/ui/button";
import { AppointmentsShell } from "@/components/appointments/AppointmentsShell";
import { AppointmentsPageSkeleton } from "@/components/appointments/skeletons";
import { mapConsultantAppointments } from "@/lib/appointments/map-consultant";
import { createConsultantQueries } from "@/lib/dashboard-queries";
import { useConsultantAppointmentsAdapter } from "./ConsultantAppointmentsAdapter";
import { TrialsTab } from "../trials/TrialsTab";

/** Old HomeTab deep-links carry groupRecurringAppointments keys — map the
 *  non-recurring "single-<appointmentId>" form onto the VM row id. */
function normalizeHighlight(param: string | null): string | null {
  if (!param) return null;
  if (param.startsWith("single-")) {
    return `appointment-${param.slice("single-".length)}`;
  }
  return param;
}

function SideQueryNotice({
  label,
  onRetry,
}: {
  label: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">{label} couldn&apos;t be loaded.</span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        onClick={onRetry}
      >
        Retry
      </Button>
    </div>
  );
}

export default function AppointmentsPageClient({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  const searchParams = useSearchParams();
  const highlightedId = normalizeHighlight(
    searchParams?.get("highlight") ?? null,
  );

  // keepPreviousData: refetches show the previous list while the new one
  // loads instead of a skeleton flash (#346).
  const appointmentsQuery = createConsultantQueries(consultantId).appointments;
  const {
    data: appointments,
    isLoading,
    error,
    refetch: refetchAppointments,
  } = useQuery({
    ...appointmentsQuery,
    placeholderData: keepPreviousData,
  });

  // Side queries keep their own state so a slow/failed trials or
  // classes/webinars read degrades to a notice instead of blanking the list.
  const {
    data: trialsData,
    isError: trialsError,
    refetch: refetchTrials,
  } = useQuery({
    placeholderData: keepPreviousData,
    queryKey: ["trials", consultantId, "SCHEDULED"] as const,
    queryFn: async () => {
      const res = await fetch(
        `/api/trials?consultantProfileId=${consultantId}&status=SCHEDULED`,
      );
      if (!res.ok) throw new Error("Failed to fetch trials");
      const { data } = await res.json();
      return data;
    },
  });

  const {
    data: classEventsData,
    isError: classesError,
    refetch: refetchClasses,
  } = useQuery({
    placeholderData: keepPreviousData,
    queryKey: ["consultant-classes", consultantId] as const,
    queryFn: async () => {
      const res = await fetch(
        `/api/bookings/classes?consultantProfileId=${consultantId}`,
      );
      if (!res.ok) throw new Error("Failed to fetch classes");
      const { data } = await res.json();
      return (data ?? []).filter(
        (c: { appointment: unknown }) => !c.appointment,
      );
    },
  });

  const {
    data: webinarEventsData,
    isError: webinarsError,
    refetch: refetchWebinars,
  } = useQuery({
    placeholderData: keepPreviousData,
    queryKey: ["consultant-webinars-unscheduled", consultantId] as const,
    queryFn: async () => {
      const res = await fetch(
        `/api/bookings/webinars?consultantProfileId=${consultantId}`,
      );
      if (!res.ok) throw new Error("Failed to fetch webinars");
      const { data } = await res.json();
      return (data ?? []).filter(
        (w: { appointment: unknown }) => !w.appointment,
      );
    },
  });

  const adapter = useConsultantAppointmentsAdapter(consultantId);

  const vms = useMemo(
    () =>
      mapConsultantAppointments({
        appointments: appointments ?? [],
        scheduledTrials: trialsData ?? [],
        unscheduledClasses: classEventsData ?? [],
        unscheduledWebinars: webinarEventsData ?? [],
        consultantId,
      }),
    [appointments, trialsData, classEventsData, webinarEventsData, consultantId],
  );

  const notices =
    trialsError || classesError || webinarsError ? (
      <div className="space-y-2">
        {trialsError && (
          <SideQueryNotice
            label="Trials"
            onRetry={() => void refetchTrials()}
          />
        )}
        {classesError && (
          <SideQueryNotice
            label="Unscheduled classes"
            onRetry={() => void refetchClasses()}
          />
        )}
        {webinarsError && (
          <SideQueryNotice
            label="Unscheduled webinars"
            onRetry={() => void refetchWebinars()}
          />
        )}
      </div>
    ) : null;

  return (
    <DashboardErrorBoundary>
      <DashboardHeader
        title="Appointments"
        subtitle="Your consultations, subscriptions, webinars, and classes"
      />
      <div className="pt-6">
        {isLoading && !appointments ? (
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
              <Button
                variant="outline"
                onClick={() => void refetchAppointments()}
              >
                Retry
              </Button>
            }
          />
        ) : (
          <AppointmentsShell
            vms={vms}
            adapter={adapter}
            highlightedId={highlightedId}
            notices={notices}
            // ADR 19 folded trials onto Appointments on the org side because a
            // trial IS an appointment. This is the personal half of that move —
            // the standalone /trials nav entry is gone.
            extraTabs={[
              {
                value: "trials",
                // "Trial requests", not "Trials": the type chip one row below
                // is already labelled "Trials" and filters the current bucket
                // to TRIAL appointments. This tab is a different thing — the
                // TrialSession queue, with its own status filter and a
                // schedule action. One word for two results, a row apart.
                // The VALUE stays "trials" so ?tab=trials deep-links survive.
                label: "Trial requests",
                content: <TrialsTab />,
              },
            ]}
          />
        )}
      </div>
    </DashboardErrorBoundary>
  );
}
