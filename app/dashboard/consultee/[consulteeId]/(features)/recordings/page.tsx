"use client";

import { ConsulteeResourcesPage } from "@/components/dashboard/consultee/resources/ConsulteeResourcesPage";

export default function ConsulteeRecordingsPage({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string }> }>) {
  return (
    <ConsulteeResourcesPage
      params={params}
      artifact="recordings"
      title="Recordings"
      subtitle="Session recordings from the events you've attended"
    />
  );
}
