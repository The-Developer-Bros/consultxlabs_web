"use client";

import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { MessagesTab } from "./MessagesTab";

/**
 * No data fetching here on purpose. This page used to run
 * `createConsultantQueries(consultantId).details` — a full round-trip with its
 * own loading, error and not-found branches — purely to hand `MessagesTab` a
 * `userId` and `userRole` that it discarded on arrival. Chat identifies the
 * viewer from the Stream client instead, so the query bought a wait and
 * nothing else.
 */
export default function ChatsPage() {
  return (
    <DashboardErrorBoundary>
      <MessagesTab />
    </DashboardErrorBoundary>
  );
}
