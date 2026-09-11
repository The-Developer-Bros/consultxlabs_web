"use client";

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import MaintenanceControls from "@/components/dashboard/MaintenanceControls";

export default function AdminMaintenancePage() {
  return (
    <>
      <DashboardHeader
        title="Maintenance Mode"
        subtitle="Control platform maintenance windows. Users see a warning banner (degraded) or a full maintenance page (offline)."
      />
      <DashboardContent>
        <MaintenanceControls />
      </DashboardContent>
    </>
  );
}
