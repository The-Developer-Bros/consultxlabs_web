"use client";

import { notFound, useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { PlannerSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { OfferingEditorContainer } from "@/components/offerings/editor/OfferingEditorContainer";
import { OFFERING_MANIFESTS } from "@/components/offerings/editor/manifests";
import type { OfferingType } from "@/components/offerings/editor/manifest";

const PLAN_PATH: Record<OfferingType, (id: string) => string> = {
  consultation: (id) => `/api/plans/consultations/${id}`,
  subscription: (id) => `/api/plans/subscriptions/${id}`,
  webinar: (id) => `/api/plans/webinars/${id}`,
  class: (id) => `/api/plans/classes/${id}`,
};

/**
 * Adapters expect a planner-shaped event wrapper, not the bare plan row.
 * Class start date lives on the Class instance (`schedulingPeriodStartsAt`),
 * so it is lifted onto the wrapper the same way the planner list does.
 */
function wrapPlanAsEvent(
  type: OfferingType,
  plan: Record<string, unknown>,
): Record<string, unknown> {
  const id = String(plan.id ?? "");
  if (type === "consultation") {
    return { type, id, consultationPlan: plan };
  }
  if (type === "subscription") {
    return { type, id, subscriptionPlan: plan };
  }
  if (type === "webinar") {
    // Same derivation the planner list uses: first slot start on the webinar's
    // appointment. The plan row itself has no scheduledAt column.
    const webinars = plan.webinars as
      | Array<{
          appointment?: {
            slotsOfAppointment?: Array<{ startsAt?: string | Date | null }>;
          } | null;
        }>
      | undefined;
    const scheduledAt =
      webinars?.[0]?.appointment?.slotsOfAppointment?.[0]?.startsAt ?? null;
    return {
      type,
      id,
      webinarPlan: {
        ...plan,
        scheduledAt,
      },
    };
  }
  const classes = plan.classes as
    | Array<{ schedulingPeriodStartsAt?: string | Date | null }>
    | undefined;
  const start =
    classes?.find(
      (row) =>
        row.schedulingPeriodStartsAt !== null &&
        row.schedulingPeriodStartsAt !== undefined,
    )?.schedulingPeriodStartsAt ??
    classes?.[0]?.schedulingPeriodStartsAt ??
    null;
  return {
    type,
    id,
    classPlan: plan,
    schedulingPeriodStartsAt: start,
  };
}

/**
 * Load the one offering being edited by id. A paginated list lookup (plus
 * marketplaceVisibilityWhere on those list routes) 404'd valid plans that were
 * past page one or marked ORG_ONLY — the owner's own edit URL must not depend
 * on marketplace visibility or list pagination.
 */
function useOfferingEvent(type: OfferingType, offeringId: string) {
  return useQuery({
    queryKey: ["offering-edit", type, offeringId],
    enabled: !!OFFERING_MANIFESTS[type] && !!offeringId,
    queryFn: async () => {
      const response = await fetch(PLAN_PATH[type](offeringId));
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`Failed to load ${type} plan (${response.status})`);
      }
      const body = (await response.json()) as {
        data?: Record<string, unknown>;
      };
      if (!body.data) return null;
      return wrapPlanAsEvent(type, body.data);
    },
  });
}

export default function EditOfferingPage() {
  const params = useParams();
  const consultantId = params.consultantId as string;
  const type = params.type as OfferingType;
  const offeringId = params.offeringId as string;

  if (!OFFERING_MANIFESTS[type]) notFound();

  const offering = useOfferingEvent(type, offeringId);

  if (offering.isLoading) {
    return (
      <>
        <DashboardHeader title="Edit offering" />
        <DashboardContent>
          <PlannerSkeleton />
        </DashboardContent>
      </>
    );
  }

  // Query failures are real errors (network / 500), not missing rows — let the
  // dashboard error boundary render them instead of pretending the plan is gone.
  if (offering.isError) throw offering.error;

  if (!offering.data) notFound();

  return (
    <>
      <DashboardHeader
        title={`Edit ${OFFERING_MANIFESTS[type].noun}`}
        subtitle="Changes go live when you save."
      />
      <DashboardContent className="content-flush-bottom flex flex-1 flex-col">
        <DashboardErrorBoundary>
          <OfferingEditorContainer
            type={type}
            consultantId={consultantId}
            initialEvent={offering.data}
          />
        </DashboardErrorBoundary>
      </DashboardContent>
    </>
  );
}
