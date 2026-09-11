"use client";

import { useParams } from "next/navigation";
import { DashboardRouteError } from "@/components/dashboard/DashboardRouteError";

export default function ConsulteeDashboardError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  const params = useParams<{ consulteeId: string }>();

  return (
    <DashboardRouteError
      error={error}
      reset={reset}
      scope="dashboard/consultee"
      event="consultee_dashboard_error"
      entityKey="consulteeId"
      entityId={params?.consulteeId ?? "unknown"}
      title="Something went wrong in your dashboard"
      devFallbackMessage="An unexpected error occurred while loading your dashboard."
      escape={{ href: "/dashboard", label: "Back to dashboard" }}
    />
  );
}
