"use client";

import { useParams } from "next/navigation";
import { DashboardRouteError } from "@/components/dashboard/DashboardRouteError";

export default function StaffDashboardError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  const params = useParams<{ staffId: string }>();

  return (
    <DashboardRouteError
      error={error}
      reset={reset}
      scope="dashboard/staff"
      event="staff_dashboard_error"
      entityKey="staffId"
      entityId={params?.staffId ?? "unknown"}
      title="Something went wrong in the staff portal"
      devFallbackMessage="An unexpected error occurred while loading the staff dashboard."
      escape={{ href: "/dashboard", label: "Back to dashboard" }}
    />
  );
}
