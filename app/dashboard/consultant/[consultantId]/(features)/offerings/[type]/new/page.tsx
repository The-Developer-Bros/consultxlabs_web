"use client";

import { notFound, useParams } from "next/navigation";
import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { OfferingEditorContainer } from "@/components/offerings/editor/OfferingEditorContainer";
import { OFFERING_MANIFESTS } from "@/components/offerings/editor/manifests";
import type { OfferingType } from "@/components/offerings/editor/manifest";

/**
 * Authoring an offering is a page, not a dialog.
 *
 * The four modals this replaces all carried
 * `max-h-[90dvh] overflow-hidden flex flex-col` — a page admitting it is a
 * page. A route also gives an offering a stable URL to come back to, which is
 * what makes "save draft" mean anything.
 */
export default function NewOfferingPage() {
  const params = useParams();
  const consultantId = params.consultantId as string;
  const type = params.type as OfferingType;

  if (!OFFERING_MANIFESTS[type]) notFound();

  return (
    <>
      <DashboardHeader
        title={`New ${OFFERING_MANIFESTS[type].noun}`}
        subtitle="Save a draft at any point; publishing needs the essentials filled in."
      />
      <DashboardContent
        className="content-flush-bottom flex flex-1 flex-col"
      >
        <DashboardErrorBoundary>
          <OfferingEditorContainer type={type} consultantId={consultantId} />
        </DashboardErrorBoundary>
      </DashboardContent>
    </>
  );
}
