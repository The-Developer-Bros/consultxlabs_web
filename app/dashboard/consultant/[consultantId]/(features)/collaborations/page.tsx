"use client";

import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { InvitationsPanel } from "@/components/collaborators/InvitationsPanel";

export default function CollaborationsPage() {
  return (
    <>
      <DashboardHeader
        title="Collaborations"
        subtitle="Manage invitations and active collaborations on webinars and classes"
      />
      <DashboardContent>
        <InvitationsPanel />
      </DashboardContent>
    </>
  );
}
