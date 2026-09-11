"use client";

import { ConsulteeResourcesPage } from "@/components/dashboard/consultee/resources/ConsulteeResourcesPage";

export default function ConsulteeDocumentsPage({
  params,
}: Readonly<{ params: Promise<{ consulteeId: string }> }>) {
  return (
    <ConsulteeResourcesPage
      params={params}
      artifact="materials"
      title="Documents"
      subtitle="Handouts and materials shared for the sessions you've booked"
    />
  );
}
