"use client";

import { DashboardRouteError } from "@/components/dashboard/DashboardRouteError";

export default function AdminDashboardError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>) {
  return (
    <DashboardRouteError
      error={error}
      reset={reset}
      scope="dashboard/admin"
      event="admin_dashboard_error"
      entityKey="area"
      entityId="admin"
      title="Something went wrong in the admin portal"
      devFallbackMessage="An unexpected error occurred while loading the admin dashboard."
      escape={{ href: "/dashboard", label: "Back to dashboard" }}
    />
  );
}
