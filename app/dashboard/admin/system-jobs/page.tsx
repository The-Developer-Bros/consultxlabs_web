"use client";

import { SystemJobsPanel } from "@/components/dashboard/SystemJobsPanel";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";

export default function AdminSystemJobsPage() {
  return (
    <div className="space-y-6">
      <DashboardHeader
        title="System Jobs"
        subtitle="Manually trigger background jobs for data validation and cleanup"
      />

      <SystemJobsPanel />
    </div>
  );
}
