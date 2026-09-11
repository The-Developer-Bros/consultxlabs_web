"use client";

import { useParams } from "next/navigation";
import { DashboardRouteError } from "@/components/dashboard/DashboardRouteError";

export default function OrgWorkspaceDashboardError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  const params = useParams<{ orgWorkspaceId: string }>();

  return (
    <DashboardRouteError
      error={error}
      reset={reset}
      scope="dashboard/org-workspace"
      event="org_workspace_dashboard_error"
      entityKey="orgWorkspaceId"
      entityId={params?.orgWorkspaceId ?? "unknown"}
      title="Something went wrong in this workspace"
      devFallbackMessage="An unexpected error occurred while loading the operator dashboard."
      escape={{ href: "/dashboard", label: "Back to dashboard" }}
    />
  );
}
