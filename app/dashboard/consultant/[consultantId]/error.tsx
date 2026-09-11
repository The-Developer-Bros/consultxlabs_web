"use client";

import { useParams } from "next/navigation";
import { DashboardRouteError } from "@/components/dashboard/DashboardRouteError";

export default function ConsultantDashboardError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  const params = useParams<{ consultantId: string }>();

  return (
    <DashboardRouteError
      error={error}
      reset={reset}
      scope="dashboard/consultant"
      event="consultant_dashboard_error"
      entityKey="consultantId"
      entityId={params?.consultantId ?? "unknown"}
      title="Something went wrong in your dashboard"
      devFallbackMessage="An unexpected error occurred while loading the consultant dashboard."
      escape={{ href: "/dashboard", label: "Back to dashboard" }}
    />
  );
}
