"use client";

/**
 * Dashboard-wide error boundary. A segment's own `error.tsx` cannot catch
 * errors thrown by that segment's `layout.tsx` — those bubble to the nearest
 * PARENT boundary. The per-tree boundaries (admin/staff/organization/…) catch
 * page-level errors, but their server layouts run the auth guards
 * (`requireUserRole` / `requireOnboarded`); this parent boundary is what
 * catches an unexpected throw from one of those layouts.
 */

import { DashboardRouteError } from "@/components/dashboard/DashboardRouteError";

export default function DashboardError({
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
      scope="dashboard"
      event="dashboard_error"
      entityKey="area"
      entityId="dashboard"
      title="Something went wrong"
      devFallbackMessage="An unexpected error occurred while loading the dashboard."
      escape={{ href: "/", label: "Go home" }}
    />
  );
}
