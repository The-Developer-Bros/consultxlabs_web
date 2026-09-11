"use client";

import { use } from "react";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { SettingsSkeleton } from "@/components/dashboard/DashboardSkeletons";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { useQuery } from "@tanstack/react-query";
import { fetchConsultantData } from "../../utils/fetchHelpers";
import { SettingsTab } from "./SettingsTab";

export default function SettingsPage({
  params,
}: {
  params: Promise<{ consultantId: string }>;
}) {
  const { consultantId } = use(params);

  const {
    data: consultant,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["consultant-settings", consultantId],
    queryFn: () => fetchConsultantData(consultantId),
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
    refetchOnWindowFocus: false,
    retry: 2,
  });

  if (isLoading) {
    return (
      <>
        <DashboardHeader
          title="Settings"
          subtitle="Manage your profile, availability, and notification preferences"
        />
        <DashboardContent>
          <SettingsSkeleton />
        </DashboardContent>
      </>
    );
  }

  if (error) {
    return (
      <>
        <DashboardHeader
          title="Settings"
          subtitle="Manage your profile, availability, and notification preferences"
        />
        <DashboardContent>
          <DashboardErrorBoundary>
            <div className="flex items-center justify-center min-h-[400px]">
              <div className="p-4 bg-red-50 text-red-600 rounded-lg max-w-md text-center">
                <h3 className="font-semibold mb-2">Error Loading Settings</h3>
                <p className="text-sm">
                  {error.message ||
                    "Failed to load consultant settings. Please try again."}
                </p>
                <button
                  onClick={() => window.location.reload()}
                  className="mt-4 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
                >
                  Retry
                </button>
              </div>
            </div>
          </DashboardErrorBoundary>
        </DashboardContent>
      </>
    );
  }

  if (!consultant) {
    return (
      <>
        <DashboardHeader
          title="Settings"
          subtitle="Manage your profile, availability, and notification preferences"
        />
        <DashboardContent>
          <DashboardErrorBoundary>
            <div className="flex items-center justify-center min-h-[400px]">
              <div className="p-4 bg-orange-50 text-orange-600 rounded-lg max-w-md text-center">
                <h3 className="font-semibold mb-2">No Data Available</h3>
                <p className="text-sm">Consultant data not found.</p>
              </div>
            </div>
          </DashboardErrorBoundary>
        </DashboardContent>
      </>
    );
  }

  return (
    <>
      <DashboardHeader
        title="Settings"
        subtitle="Manage your profile, availability, and notification preferences"
      />
      <DashboardContent>
        <DashboardErrorBoundary>
          <SettingsTab consultant={consultant} />
        </DashboardErrorBoundary>
      </DashboardContent>
    </>
  );
}
