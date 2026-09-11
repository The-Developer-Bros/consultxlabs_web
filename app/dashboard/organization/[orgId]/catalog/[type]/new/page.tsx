"use client";

import { notFound, useParams, useRouter, useSearchParams } from "next/navigation";
import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { OfferingEditorContainer } from "@/components/offerings/editor/OfferingEditorContainer";
import { OFFERING_MANIFESTS } from "@/components/offerings/editor/manifests";
import type { OfferingType } from "@/components/offerings/editor/manifest";

/**
 * Org authoring uses the same editor as personal authoring.
 *
 * It previously had its own reduced surface that dropped every ADR-24 content
 * field on the floor, so an org-authored offering was structurally thinner than
 * the identical personal one. Only the WRITE differs — the org endpoint stamps
 * the organization and writes an audit log — so only the write is overridden.
 */
export default function NewOrgOfferingPage() {
  const params = useParams();
  const search = useSearchParams();
  const router = useRouter();

  const orgId = params.orgId as string;
  const type = params.type as OfferingType;
  // Which expert delivers it. The catalog picks this before routing here.
  const expertId = search.get("expertId") ?? "";

  if (!OFFERING_MANIFESTS[type]) notFound();

  const returnHref = `/dashboard/organization/${orgId}/catalog`;

  return (
    <>
      <DashboardHeader
        title={`New ${OFFERING_MANIFESTS[type].noun}`}
        subtitle="Save a draft at any point; publishing needs the essentials filled in."
      />
      <DashboardContent className="content-flush-bottom flex flex-1 flex-col">
        <DashboardErrorBoundary>
          {expertId ? (
            <OfferingEditorContainer
              type={type}
              consultantId={expertId}
              returnHref={returnHref}
              onSave={async (values) => {
                const response = await fetch(
                  `/api/organizations/${orgId}/catalog`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      ...values,
                      kind: type.toUpperCase(),
                      consultantProfileId: expertId,
                      // The endpoint takes paise; the form edits rupees, same
                      // as every other price field in the product.
                      pricePaise: Math.round(Number(values.price ?? 0) * 100),
                    }),
                  },
                );
                if (!response.ok) {
                  const body = await response.json().catch(() => ({}));
                  throw new Error(body.error ?? "Failed to save offering");
                }
              }}
            />
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Pick the expert who will deliver this offering first.
              </p>
              <button
                type="button"
                className="text-sm underline"
                onClick={() => router.push(returnHref)}
              >
                Back to catalog
              </button>
            </div>
          )}
        </DashboardErrorBoundary>
      </DashboardContent>
    </>
  );
}
