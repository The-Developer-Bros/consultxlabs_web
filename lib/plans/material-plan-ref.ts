/**
 * Shared shape for org-materials surfaces: PlanMaterial rows are polymorphic
 * across the four plan FKs, and every consumer needs the same "which catalog
 * entry does this hang off" answer.
 */

export type MaterialPlanType =
  | "CONSULTATION"
  | "SUBSCRIPTION"
  | "WEBINAR"
  | "CLASS";

export interface MaterialPlanRefInput {
  consultationPlan?: { id: string; title: string } | null;
  subscriptionPlan?: { id: string; title: string } | null;
  webinarPlan?: { id: string; title: string } | null;
  classPlan?: { id: string; title: string } | null;
}

export interface MaterialPlanRef {
  planId: string;
  title: string;
  planType: MaterialPlanType;
}

export function resolveMaterialPlanRef(
  material: MaterialPlanRefInput,
): MaterialPlanRef | null {
  if (material.consultationPlan) {
    return {
      planId: material.consultationPlan.id,
      title: material.consultationPlan.title,
      planType: "CONSULTATION",
    };
  }
  if (material.subscriptionPlan) {
    return {
      planId: material.subscriptionPlan.id,
      title: material.subscriptionPlan.title,
      planType: "SUBSCRIPTION",
    };
  }
  if (material.webinarPlan) {
    return {
      planId: material.webinarPlan.id,
      title: material.webinarPlan.title,
      planType: "WEBINAR",
    };
  }
  if (material.classPlan) {
    return {
      planId: material.classPlan.id,
      title: material.classPlan.title,
      planType: "CLASS",
    };
  }
  return null;
}
