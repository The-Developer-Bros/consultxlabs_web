"use client";

import { useParams } from "next/navigation";
import { DashboardRouteError } from "@/components/dashboard/DashboardRouteError";

export default function OrgDashboardError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  const params = useParams<{ orgId: string }>();

  return (
    <DashboardRouteError
      error={error}
      reset={reset}
      scope="dashboard/organization"
      event="org_dashboard_error"
      entityKey="orgId"
      entityId={params?.orgId ?? "unknown"}
      title="Something went wrong in this organization"
      devFallbackMessage="An unexpected error occurred while loading the organization dashboard."
      escape={{ href: "/dashboard", label: "Switch organization" }}
    />
  );
}
